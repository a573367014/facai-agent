import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import initSqlJs from "sql.js";
import type { AgentExecutionResult, AgentStreamEvent } from "./types.js";
import { legacyContentToParts, partsToLegacyContent, type MessagePart } from "./message-parts.js";
import type {
  AgentAssetRecord,
  AgentAssetType,
  AgentEventListener,
  AgentMessageRecord,
  AgentMessageRole,
  AgentMessageStatus,
  AgentSessionRecord,
  AgentStore,
  CreateAgentAssetInput,
  CreateAgentMessageInput,
  StoredAgentEvent,
  UpdateAgentMessageInput
} from "./agent-store.js";

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

interface SqliteAgentStoreOptions {
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

export class SqliteAgentStore implements AgentStore {
  private readonly subscribers = new Map<string, Set<AgentEventListener>>();
  private readonly pendingAnswerChunks = new Map<string, PendingAnswerChunk>();

  private constructor(
    private readonly databasePath: string,
    private readonly database: SqlDatabase,
    private readonly answerChunkCharLimit: number
  ) {}

  static async create(options: SqliteAgentStoreOptions): Promise<SqliteAgentStore> {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    const SQL = await initSqlJs();
    const data = existsSync(options.databasePath) ? readFileSync(options.databasePath) : undefined;
    const database = new SQL.Database(data) as SqlDatabase;
    const store = new SqliteAgentStore(
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

  createMessage(input: CreateAgentMessageInput): AgentMessageRecord {
    const timestamp = now();
    const parts = input.parts ?? legacyContentToParts(input.content ?? "");
    const content = partsToLegacyContent(parts);
    const message: AgentMessageRecord = {
      id: createId("msg"),
      sessionId: input.sessionId,
      role: input.role,
      status: input.status,
      parts,
      content,
      maxIterations: input.maxIterations,
      error: input.error,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.database.run(
      `INSERT INTO agent_messages (
         id,
         session_id,
         role,
         status,
         content,
         parts_json,
         max_iterations,
         steps_json,
         error_json,
         created_at,
         updated_at,
         completed_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.sessionId,
        message.role,
        message.status,
        message.content,
        JSON.stringify(message.parts),
        message.maxIterations ?? null,
        null,
        message.error ? JSON.stringify(message.error) : null,
        timestamp,
        timestamp,
        null
      ]
    );
    this.touchSession(message.sessionId, timestamp);
    this.persist();
    return message;
  }

  updateMessage(messageId: string, input: UpdateAgentMessageInput): AgentMessageRecord | undefined {
    const existingMessage = this.getMessage(messageId);

    if (!existingMessage) {
      return undefined;
    }

    const timestamp = now();
    const status = input.status ?? existingMessage.status;
    const parts = input.parts ?? (input.content === undefined ? existingMessage.parts : legacyContentToParts(input.content));
    const content = partsToLegacyContent(parts);
    const steps = input.steps ?? existingMessage.steps;
    const error = input.error;
    const completedAt = input.completedAt ?? existingMessage.completedAt;

    this.database.run(
      `UPDATE agent_messages
       SET status = ?,
           content = ?,
           parts_json = ?,
           steps_json = ?,
           error_json = ?,
           updated_at = ?,
           completed_at = ?
       WHERE id = ?`,
      [
        status,
        content,
        JSON.stringify(parts),
        steps ? JSON.stringify(steps) : null,
        error ? JSON.stringify(error) : null,
        timestamp,
        completedAt ?? null,
        messageId
      ]
    );
    this.touchSession(existingMessage.sessionId, timestamp);
    this.persist();
    return this.getMessage(messageId);
  }

  updateMessageParts(messageId: string, parts: MessagePart[]): AgentMessageRecord | undefined {
    return this.updateMessage(messageId, { parts });
  }

  getMessage(messageId: string): AgentMessageRecord | undefined {
    const row = this.queryOne(
      `SELECT
         id,
         session_id,
         role,
         status,
         content,
         parts_json,
         max_iterations,
         steps_json,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM agent_messages
       WHERE id = ?`,
      [messageId]
    );

    return row ? this.toMessageRecord(row) : undefined;
  }

  getMessagesBySession(sessionId: string): AgentMessageRecord[] {
    return this.queryMany(
      `SELECT
         id,
         session_id,
         role,
         status,
         content,
         parts_json,
         max_iterations,
         steps_json,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM agent_messages
       WHERE session_id = ?
       ORDER BY created_at ASC, rowid ASC`,
      [sessionId]
    ).map((row) => this.toMessageRecord(row));
  }

  createAsset(input: CreateAgentAssetInput): AgentAssetRecord {
    const timestamp = now();
    const asset: AgentAssetRecord = {
      id: createId("asset"),
      sessionId: input.sessionId,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      type: input.type,
      url: input.url,
      mimeType: input.mimeType,
      width: input.width,
      height: input.height,
      prompt: input.prompt,
      index: input.index,
      metadata: input.metadata,
      createdAt: timestamp
    };

    this.database.run(
      `INSERT INTO agent_assets (
         id,
         session_id,
         message_id,
         tool_call_id,
         type,
         url,
         mime_type,
         width,
         height,
         prompt,
         asset_index,
         metadata_json,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        asset.id,
        asset.sessionId,
        asset.messageId ?? null,
        asset.toolCallId ?? null,
        asset.type,
        asset.url,
        asset.mimeType ?? null,
        asset.width ?? null,
        asset.height ?? null,
        asset.prompt ?? null,
        asset.index ?? null,
        asset.metadata ? JSON.stringify(asset.metadata) : null,
        timestamp
      ]
    );
    this.touchSession(asset.sessionId, timestamp);
    this.persist();
    return asset;
  }

  getAssetsBySession(sessionId: string): AgentAssetRecord[] {
    return this.queryMany(
      `SELECT
         id,
         session_id,
         message_id,
         tool_call_id,
         type,
         url,
         mime_type,
         width,
         height,
         prompt,
         asset_index,
         metadata_json,
         created_at
       FROM agent_assets
       WHERE session_id = ?
       ORDER BY created_at ASC, asset_index ASC`,
      [sessionId]
    ).map((row) => this.toAssetRecord(row));
  }

  appendEvent(messageId: string, event: AgentStreamEvent): StoredAgentEvent | undefined {
    if (event.type === "answer_delta") {
      return this.appendAnswerDelta(messageId, event);
    }

    this.flushPendingAnswerChunk(messageId);
    return this.appendStoredEvent(messageId, event);
  }

  getEvents(messageId: string, after = 0): StoredAgentEvent[] {
    return this.queryMany(
      `SELECT id, seq, message_id, payload_json, created_at
       FROM agent_events
       WHERE message_id = ? AND seq > ?
       ORDER BY seq ASC`,
      [messageId, after]
    ).map((row) => this.toStoredEvent(row));
  }

  subscribe(messageId: string, listener: AgentEventListener): () => void {
    const listeners = this.subscribers.get(messageId) ?? new Set<AgentEventListener>();
    listeners.add(listener);
    this.subscribers.set(messageId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.subscribers.delete(messageId);
      }
    };
  }

  close() {
    for (const messageId of this.pendingAnswerChunks.keys()) {
      this.flushPendingAnswerChunk(messageId);
    }

    this.persist();
    this.database.close();
  }

  private initializeSchema() {
    this.database.run(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        parts_json TEXT NOT NULL DEFAULT '[]',
        max_iterations INTEGER,
        steps_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_assets (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT,
        tool_call_id TEXT,
        type TEXT NOT NULL,
        url TEXT NOT NULL,
        mime_type TEXT,
        width INTEGER,
        height INTEGER,
        prompt TEXT,
        asset_index INTEGER,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (message_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_messages_session_id_created_at
        ON agent_messages (session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_agent_assets_session_id_created_at
        ON agent_assets (session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_agent_assets_message_id
        ON agent_assets (message_id);

      CREATE INDEX IF NOT EXISTS idx_agent_events_message_id_seq
        ON agent_events (message_id, seq);
    `);
    this.ensureMessagePartsColumn();
  }

  private ensureMessagePartsColumn() {
    const columns = this.database.exec(`PRAGMA table_info(agent_messages)`)[0]?.values ?? [];
    const hasPartsJson = columns.some((row) => row[1] === "parts_json");

    if (!hasPartsJson) {
      this.database.run(`ALTER TABLE agent_messages ADD COLUMN parts_json TEXT NOT NULL DEFAULT '[]'`);
    }
  }

  private appendAnswerDelta(
    messageId: string,
    event: Extract<AgentStreamEvent, { type: "answer_delta" }>
  ): StoredAgentEvent | undefined {
    const currentChunk = this.pendingAnswerChunks.get(messageId);

    if (currentChunk && currentChunk.iteration !== event.iteration) {
      this.flushPendingAnswerChunk(messageId);
    }

    const pendingChunk = this.pendingAnswerChunks.get(messageId) ?? { iteration: event.iteration, text: "" };
    pendingChunk.text += event.delta;
    this.pendingAnswerChunks.set(messageId, pendingChunk);

    if (pendingChunk.text.length >= this.answerChunkCharLimit) {
      return this.flushPendingAnswerChunk(messageId);
    }

    return undefined;
  }

  private flushPendingAnswerChunk(messageId: string): StoredAgentEvent | undefined {
    const pendingChunk = this.pendingAnswerChunks.get(messageId);

    if (!pendingChunk || pendingChunk.text.length === 0) {
      return undefined;
    }

    this.pendingAnswerChunks.delete(messageId);
    return this.appendStoredEvent(messageId, {
      type: "answer_chunk",
      iteration: pendingChunk.iteration,
      text: pendingChunk.text
    });
  }

  private appendStoredEvent(messageId: string, event: AgentStreamEvent): StoredAgentEvent {
    const eventId = createId("event");
    const eventSeq = this.nextEventSeq(messageId);
    const timestamp = now();
    const storedEvent: StoredAgentEvent = {
      id: eventId,
      seq: eventSeq,
      messageId,
      event,
      createdAt: timestamp
    };

    this.database.run(
      `INSERT INTO agent_events (id, message_id, seq, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [eventId, messageId, eventSeq, event.type, JSON.stringify(event), timestamp]
    );
    this.persist();
    this.publish(storedEvent);
    return storedEvent;
  }

  private nextEventSeq(messageId: string): number {
    const row = this.queryOne(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
       FROM agent_events
       WHERE message_id = ?`,
      [messageId]
    );

    return optionalNumber(row?.next_seq) ?? 1;
  }

  private publish(event: StoredAgentEvent) {
    const listeners = this.subscribers.get(event.messageId);

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

  private toMessageRecord(row: SqlRow): AgentMessageRecord {
    const content = requiredString(row.content, "content");
    const storedParts = parseJson<MessagePart[]>(row.parts_json);
    const parts = storedParts && storedParts.length > 0 ? storedParts : legacyContentToParts(content);

    return {
      id: requiredString(row.id, "id"),
      sessionId: requiredString(row.session_id, "session_id"),
      role: requiredString(row.role, "role") as AgentMessageRole,
      status: requiredString(row.status, "status") as AgentMessageStatus,
      parts,
      content,
      maxIterations: optionalNumber(row.max_iterations),
      steps: parseJson<AgentExecutionResult["steps"]>(row.steps_json),
      error: parseJson<AgentMessageRecord["error"]>(row.error_json),
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at"),
      completedAt: optionalString(row.completed_at)
    };
  }

  private toAssetRecord(row: SqlRow): AgentAssetRecord {
    return {
      id: requiredString(row.id, "id"),
      sessionId: requiredString(row.session_id, "session_id"),
      messageId: optionalString(row.message_id),
      toolCallId: optionalString(row.tool_call_id),
      type: requiredString(row.type, "type") as AgentAssetType,
      url: requiredString(row.url, "url"),
      mimeType: optionalString(row.mime_type),
      width: optionalNumber(row.width),
      height: optionalNumber(row.height),
      prompt: optionalString(row.prompt),
      index: optionalNumber(row.asset_index),
      metadata: parseJson<AgentAssetRecord["metadata"]>(row.metadata_json),
      createdAt: requiredString(row.created_at, "created_at")
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
      messageId: requiredString(row.message_id, "message_id"),
      event,
      createdAt: requiredString(row.created_at, "created_at")
    };
  }
}
