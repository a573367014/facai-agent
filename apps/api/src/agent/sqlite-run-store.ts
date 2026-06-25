import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import initSqlJs from "sql.js";
import type { AgentRunResult, AgentStreamEvent } from "./types.js";
import type {
  AgentRunEventListener,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunStore,
  AgentSessionRecord,
  CreateAgentRunInput,
  StoredAgentEvent
} from "./run-store.js";

const DEFAULT_ANSWER_CHUNK_CHAR_LIMIT = 24;

type SqlValue = string | number | Uint8Array | null;
type SqlParams = SqlValue[] | Record<string, SqlValue> | null;

interface SqlDatabase {
  exec(sql: string, params?: SqlParams): Array<{ columns: string[]; values: SqlValue[][] }>;
  run(sql: string, params?: SqlParams): SqlDatabase;
  export(): Uint8Array;
  close(): void;
}

interface PendingAnswerChunk {
  iteration: number;
  text: string;
}

interface SqliteAgentRunStoreOptions {
  databasePath: string;
  answerChunkCharLimit?: number;
}

type SqlRow = Record<string, SqlValue>;

function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function requiredString(value: SqlValue | undefined, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`SQLite 字段 ${field} 不是字符串`);
  }

  return value;
}

function optionalString(value: SqlValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: SqlValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseJson<T>(value: SqlValue | undefined): T | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return JSON.parse(value) as T;
}

export class SqliteAgentRunStore implements AgentRunStore {
  // subscribers 和 pendingAnswerChunks 都是“当前进程状态”，不入库：
  // subscribers 只代表当前打开的 SSE 连接，pendingAnswerChunks 只是临时累计 answer_delta。
  private readonly subscribers = new Map<string, Set<AgentRunEventListener>>();
  private readonly pendingAnswerChunks = new Map<string, PendingAnswerChunk>();

  private constructor(
    private readonly databasePath: string,
    private readonly database: SqlDatabase,
    private readonly answerChunkCharLimit: number
  ) {}

  static async create(options: SqliteAgentRunStoreOptions): Promise<SqliteAgentRunStore> {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    const SQL = await initSqlJs();
    // sql.js 把 SQLite 数据库加载进内存运行；如果文件存在，就从文件恢复。
    const data = existsSync(options.databasePath) ? readFileSync(options.databasePath) : undefined;
    const database = new SQL.Database(data) as SqlDatabase;
    const store = new SqliteAgentRunStore(
      options.databasePath,
      database,
      options.answerChunkCharLimit ?? DEFAULT_ANSWER_CHUNK_CHAR_LIMIT
    );

    store.initializeSchema();
    store.persist();
    return store;
  }

  createSession(title?: string): AgentSessionRecord {
    const timestamp = now();
    const session: AgentSessionRecord = {
      id: createId("session"),
      title,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.database.run(
      `INSERT INTO agent_sessions (id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      [session.id, title ?? null, timestamp, timestamp]
    );
    this.persist();
    return session;
  }

  getSession(sessionId: string): AgentSessionRecord | undefined {
    const row = this.queryOne(
      `SELECT id, title, created_at, updated_at
       FROM agent_sessions
       WHERE id = ?`,
      [sessionId]
    );

    return row ? this.toSessionRecord(row) : undefined;
  }

  listSessions(): AgentSessionRecord[] {
    return this.queryMany(
      `SELECT id, title, created_at, updated_at
       FROM agent_sessions
       ORDER BY updated_at DESC`
    ).map((row) => this.toSessionRecord(row));
  }

  createRun(input: CreateAgentRunInput): AgentRunRecord {
    const timestamp = now();
    const run: AgentRunRecord = {
      id: createId("run"),
      sessionId: input.sessionId,
      input: input.input,
      maxIterations: input.maxIterations,
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.database.run(
      `INSERT INTO agent_runs (
         id,
         session_id,
         input,
         max_iterations,
         status,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [run.id, run.sessionId, run.input, run.maxIterations ?? null, run.status, timestamp, timestamp]
    );
    this.touchSession(run.sessionId, timestamp);
    this.persist();
    return run;
  }

  getRun(runId: string): AgentRunRecord | undefined {
    const row = this.queryOne(
      `SELECT
         id,
         session_id,
         input,
         max_iterations,
         status,
         answer,
         steps_json,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM agent_runs
       WHERE id = ?`,
      [runId]
    );

    return row ? this.toRunRecord(row) : undefined;
  }

  getRunsBySession(sessionId: string): AgentRunRecord[] {
    return this.queryMany(
      `SELECT
         id,
         session_id,
         input,
         max_iterations,
         status,
         answer,
         steps_json,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM agent_runs
       WHERE session_id = ?
       ORDER BY created_at ASC`,
      [sessionId]
    ).map((row) => this.toRunRecord(row));
  }

  appendEvent(runId: string, event: AgentStreamEvent): StoredAgentEvent | undefined {
    // answer_delta 可能一个字一条，直接写数据库会让 agent_events 膨胀得很快。
    // 所以先进入 pendingAnswerChunks，达到阈值或遇到非 delta 事件时再落成 answer_chunk。
    if (event.type === "answer_delta") {
      return this.appendAnswerDelta(runId, event);
    }

    this.flushPendingAnswerChunk(runId);
    return this.appendStoredEvent(runId, event);
  }

  getEvents(runId: string, after = 0): StoredAgentEvent[] {
    // after 对应的是 run 内 seq，不是 event 的全局 id。
    // 这样前端断线后只需要记住最后收到的 seq，就能稳定续传。
    return this.queryMany(
      `SELECT id, seq, run_id, payload_json, created_at
       FROM agent_events
       WHERE run_id = ? AND seq > ?
       ORDER BY seq ASC`,
      [runId, after]
    ).map((row) => this.toStoredEvent(row));
  }

  completeRun(runId: string, result: AgentRunResult): AgentRunRecord | undefined {
    const existingRun = this.getRun(runId);

    if (!existingRun) {
      return undefined;
    }

    this.flushPendingAnswerChunk(runId);
    const timestamp = now();
    this.database.run(
      `UPDATE agent_runs
       SET status = ?,
           answer = ?,
           steps_json = ?,
           error_json = NULL,
           updated_at = ?,
           completed_at = ?
       WHERE id = ?`,
      ["completed", result.answer, JSON.stringify(result.steps), timestamp, timestamp, runId]
    );
    this.touchSession(existingRun.sessionId, timestamp);
    this.persist();
    return this.getRun(runId);
  }

  failRun(runId: string, error: { code: string; message: string }): AgentRunRecord | undefined {
    const existingRun = this.getRun(runId);

    if (!existingRun) {
      return undefined;
    }

    this.flushPendingAnswerChunk(runId);
    const timestamp = now();
    this.database.run(
      `UPDATE agent_runs
       SET status = ?,
           error_json = ?,
           updated_at = ?,
           completed_at = ?
       WHERE id = ?`,
      ["failed", JSON.stringify(error), timestamp, timestamp, runId]
    );
    this.touchSession(existingRun.sessionId, timestamp);
    this.persist();
    return this.getRun(runId);
  }

  cancelRun(runId: string): AgentRunRecord | undefined {
    const existingRun = this.getRun(runId);

    if (!existingRun) {
      return undefined;
    }

    this.flushPendingAnswerChunk(runId);
    const timestamp = now();
    this.database.run(
      `UPDATE agent_runs
       SET status = ?,
           error_json = NULL,
           updated_at = ?,
           completed_at = ?
       WHERE id = ?`,
      ["cancelled", timestamp, timestamp, runId]
    );
    this.touchSession(existingRun.sessionId, timestamp);
    this.persist();
    return this.getRun(runId);
  }

  subscribe(runId: string, listener: AgentRunEventListener): () => void {
    const listeners = this.subscribers.get(runId) ?? new Set<AgentRunEventListener>();
    listeners.add(listener);
    this.subscribers.set(runId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.subscribers.delete(runId);
      }
    };
  }

  close() {
    for (const runId of this.pendingAnswerChunks.keys()) {
      this.flushPendingAnswerChunk(runId);
    }

    this.persist();
    this.database.close();
  }

  private initializeSchema() {
    // 先迁移旧表，再执行 CREATE TABLE IF NOT EXISTS。
    // 如果是全新库，迁移方法会直接返回；如果是旧库，会把旧 id 拆成新 id + seq。
    this.migrateLegacyAgentEventsSchema();

    this.database.run(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        input TEXT NOT NULL,
        max_iterations INTEGER,
        status TEXT NOT NULL,
        answer TEXT,
        steps_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_events (
        -- id 是事件对象的唯一标识，将来可以按它单独查询某条事件。
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        -- seq 是同一个 run 内的递增顺序，SSE 的 after 游标按它工作。
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        -- 数据库兜底保证：同一个 run 里不能出现两个相同 seq 的事件。
        UNIQUE (run_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_runs_session_id_created_at
        ON agent_runs (session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_agent_events_run_id_seq
        ON agent_events (run_id, seq);
    `);
  }

  private migrateLegacyAgentEventsSchema() {
    const columns = this.queryMany("PRAGMA table_info(agent_events)");

    // 没有表：全新数据库。已有 seq：已经迁移过。两种情况都不用处理。
    if (columns.length === 0 || columns.some((column) => column.name === "seq")) {
      return;
    }

    // SQLite 不能方便地直接修改已有主键，所以采用常见迁移套路：
    // 旧表改名 -> 创建新表 -> 拷贝转换后的数据 -> 删除旧表。
    this.database.run(`
      ALTER TABLE agent_events RENAME TO agent_events_legacy;

      CREATE TABLE agent_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, seq)
      );

      INSERT INTO agent_events (id, run_id, seq, type, payload_json, created_at)
      -- 旧表里的 id 本质是 run 内序号，所以迁移为 seq；
      -- 新 id 用旧数据拼出稳定值，避免旧事件在迁移后失去唯一标识。
      SELECT 'event_' || run_id || '_' || id, run_id, id, type, payload_json, created_at
      FROM agent_events_legacy;

      DROP TABLE agent_events_legacy;
    `);
  }

  private appendAnswerDelta(
    runId: string,
    event: Extract<AgentStreamEvent, { type: "answer_delta" }>
  ): StoredAgentEvent | undefined {
    const currentChunk = this.pendingAnswerChunks.get(runId);

    // 不同 iteration 的文本不能合进同一个 chunk，否则事件归属会混乱。
    if (currentChunk && currentChunk.iteration !== event.iteration) {
      this.flushPendingAnswerChunk(runId);
    }

    const pendingChunk = this.pendingAnswerChunks.get(runId) ?? { iteration: event.iteration, text: "" };
    pendingChunk.text += event.delta;
    this.pendingAnswerChunks.set(runId, pendingChunk);

    if (pendingChunk.text.length >= this.answerChunkCharLimit) {
      return this.flushPendingAnswerChunk(runId);
    }

    return undefined;
  }

  private flushPendingAnswerChunk(runId: string): StoredAgentEvent | undefined {
    const pendingChunk = this.pendingAnswerChunks.get(runId);

    if (!pendingChunk || pendingChunk.text.length === 0) {
      return undefined;
    }

    this.pendingAnswerChunks.delete(runId);
    // 对外保存的是 answer_chunk，不再保存原始 answer_delta。
    return this.appendStoredEvent(runId, {
      type: "answer_chunk",
      iteration: pendingChunk.iteration,
      text: pendingChunk.text
    });
  }

  private appendStoredEvent(runId: string, event: AgentStreamEvent): StoredAgentEvent {
    // id 和 seq 分工不同：id 是事件唯一身份，seq 是当前 run 内的回放顺序。
    const eventId = createId("event");
    const eventSeq = this.nextEventSeq(runId);
    const timestamp = now();
    const storedEvent: StoredAgentEvent = {
      id: eventId,
      seq: eventSeq,
      runId,
      event,
      createdAt: timestamp
    };

    this.database.run(
      `INSERT INTO agent_events (id, run_id, seq, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [eventId, runId, eventSeq, event.type, JSON.stringify(event), timestamp]
    );
    this.persist();
    this.publish(storedEvent);
    return storedEvent;
  }

  private nextEventSeq(runId: string): number {
    // 每个 run 的事件序号独立递增，因此 run_1 和 run_2 都可以有 seq=1。
    const row = this.queryOne(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
       FROM agent_events
       WHERE run_id = ?`,
      [runId]
    );

    return optionalNumber(row?.next_seq) ?? 1;
  }

  private publish(event: StoredAgentEvent) {
    const listeners = this.subscribers.get(event.runId);

    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  private touchSession(sessionId: string, timestamp: string) {
    this.database.run(
      `UPDATE agent_sessions
       SET updated_at = ?
       WHERE id = ?`,
      [timestamp, sessionId]
    );
  }

  private persist() {
    // sql.js 的数据库运行在内存中，必须 export 后写回文件才算落盘。
    writeFileSync(this.databasePath, this.database.export());
  }

  private queryOne(sql: string, params?: SqlParams): SqlRow | undefined {
    return this.queryMany(sql, params)[0];
  }

  private queryMany(sql: string, params?: SqlParams): SqlRow[] {
    const [result] = this.database.exec(sql, params);

    if (!result) {
      return [];
    }

    return result.values.map((values) =>
      Object.fromEntries(result.columns.map((column, index) => [column, values[index] ?? null]))
    );
  }

  private toSessionRecord(row: SqlRow): AgentSessionRecord {
    return {
      id: requiredString(row.id, "id"),
      title: optionalString(row.title),
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at")
    };
  }

  private toRunRecord(row: SqlRow): AgentRunRecord {
    return {
      id: requiredString(row.id, "id"),
      sessionId: requiredString(row.session_id, "session_id"),
      input: requiredString(row.input, "input"),
      maxIterations: optionalNumber(row.max_iterations),
      status: requiredString(row.status, "status") as AgentRunStatus,
      answer: optionalString(row.answer),
      steps: parseJson<AgentRunResult["steps"]>(row.steps_json),
      error: parseJson<AgentRunRecord["error"]>(row.error_json),
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at"),
      completedAt: optionalString(row.completed_at)
    };
  }

  private toStoredEvent(row: SqlRow): StoredAgentEvent {
    const event = parseJson<AgentStreamEvent>(row.payload_json);

    if (!event) {
      throw new Error("SQLite 事件 payload_json 为空");
    }

    return {
      id: requiredString(row.id, "id"),
      seq: optionalNumber(row.seq) ?? 0,
      runId: requiredString(row.run_id, "run_id"),
      event,
      createdAt: requiredString(row.created_at, "created_at")
    };
  }
}
