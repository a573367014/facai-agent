import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import initSqlJs from "sql.js";
import type { AgentStreamEvent } from "./types.js";
import type { MessagePart } from "./message-parts.js";
import type {
  AgentEventListener,
  AgentMessageRecord,
  AgentMessageRole,
  AgentMessageStatus,
  AgentRunPhase,
  AgentRunRecord,
  AgentRunStatus,
  AgentSessionRecord,
  AgentSessionSummaryRecord,
  AgentStore,
  AgentToolCallRecord,
  CreateAgentProcessStepInput,
  CreateAgentMessageInput,
  CreateAgentResourceInput,
  CreateAgentToolCallInput,
  CreateAgentRunInput,
  AgentProcessStepRecord,
  AgentResourceRecord,
  ListAgentSessionsOptions,
  PruneExpiredAgentEventsInput,
  PruneAgentEventsResult,
  StoredAgentEvent,
  UpdateAgentMessageInput,
  UpdateAgentProcessStepInput,
  UpdateAgentResourceInput,
  UpdateAgentRunInput,
  UpdateAgentToolCallInput,
  UpsertAgentSessionSummaryInput
} from "./agent-store.js";

type SqlValue = string | number | Uint8Array | null;
type SqlParams = SqlValue[] | Record<string, SqlValue> | null;

interface SqlDatabase {
  exec(sql: string, params?: SqlParams): Array<{ columns: string[]; values: SqlValue[][] }>;
  run(sql: string, params?: SqlParams): SqlDatabase;
  export(): Uint8Array;
  close(): void;
}

type SqlJsModule = Awaited<ReturnType<typeof initSqlJs>>;

interface SqliteAgentStoreOptions {
  databasePath: string;
  eventRetentionDays?: number;
}

type SqlRow = Record<string, SqlValue>;

interface MessageCursor {
  sessionId: string;
  createdAt: string;
  rowid: number;
}

interface SessionCursor {
  updatedAt: string;
  rowid: number;
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function addDaysIso(iso: string, days: number) {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function normalizeLimit(limit: number): number {
  return Math.max(0, Math.floor(limit));
}

function normalizePositiveInteger(value: number): number {
  return Math.max(1, Math.floor(value));
}

const contextMessageFilter = "(role = 'user' OR (role = 'assistant' AND status IN ('completed', 'failed')))";

// 只有用户消息、已完成/失败的 assistant 消息会进入后续上下文。
// running/cancelled/system 更多是流程状态，参与检索容易污染下一轮模型输入。
function isTerminalToolCallStatus(status: AgentToolCallRecord["status"]) {
  return status === "succeeded" || status === "failed";
}

function isTerminalProcessStepStatus(status: AgentProcessStepRecord["status"]) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
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
  // 这个 store 负责“长期事实”：会话、消息、run、工具调用、资源、事件回放都落在 SQLite。
  // Redis 只做运行时协调，进程重启后最终仍以 SQLite 里的记录和事件为准。
  private readonly subscribers = new Map<string, Set<AgentEventListener>>();
  private readonly runSubscribers = new Map<string, Set<AgentEventListener>>();
  private readonly eventRetentionDays: number;
  private lastLoadedMtimeMs: number;
  private transactionDepth = 0;
  private hasUnpersistedChanges = false;

  private constructor(
    private readonly databasePath: string,
    private database: SqlDatabase,
    private readonly SQL: SqlJsModule,
    options: { eventRetentionDays: number; lastLoadedMtimeMs: number }
  ) {
    this.eventRetentionDays = options.eventRetentionDays;
    this.lastLoadedMtimeMs = options.lastLoadedMtimeMs;
  }

  static async create(options: SqliteAgentStoreOptions): Promise<SqliteAgentStore> {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    const SQL = await initSqlJs();
    const databaseExists = existsSync(options.databasePath);
    const data = databaseExists ? readFileSync(options.databasePath) : undefined;
    const database = new SQL.Database(data) as SqlDatabase;
    const store = new SqliteAgentStore(options.databasePath, database, SQL, {
      eventRetentionDays: normalizePositiveInteger(options.eventRetentionDays ?? 3),
      lastLoadedMtimeMs: databaseExists ? statSync(options.databasePath).mtimeMs : 0
    });

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

    this.run(
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

  listSessions(options: ListAgentSessionsOptions = {}): AgentSessionRecord[] {
    const cursor = options.after ? this.getSessionCursor(options.after) : undefined;
    const normalizedLimit = options.limit === undefined ? undefined : normalizeLimit(options.limit);
    const params: SqlValue[] = [];

    if (options.after && !cursor) {
      return [];
    }

    if (cursor) {
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.rowid);
    }

    if (normalizedLimit !== undefined) {
      if (normalizedLimit === 0) {
        return [];
      }

      params.push(normalizedLimit);
    }

    return this.queryMany(
      `SELECT id, title, created_at, updated_at
       FROM agent_sessions
       ${cursor ? "WHERE updated_at < ? OR (updated_at = ? AND rowid < ?)" : ""}
       ORDER BY updated_at DESC, rowid DESC
       ${normalizedLimit !== undefined ? "LIMIT ?" : ""}`,
      params
    ).map((row) => this.toSessionRecord(row));
  }

  deleteSession(sessionId: string): boolean {
    const session = this.getSession(sessionId);

    if (!session) {
      return false;
    }

    const messageIds = this.queryMany(`SELECT id FROM agent_messages WHERE session_id = ?`, [sessionId]).map((row) =>
      requiredString(row.id, "id")
    );
    const runIds = this.queryMany(`SELECT id FROM agent_runs WHERE session_id = ?`, [sessionId]).map((row) =>
      requiredString(row.id, "id")
    );

    this.run("BEGIN TRANSACTION");
    try {
      this.run(
        `DELETE FROM agent_events
         WHERE run_id IN (SELECT id FROM agent_runs WHERE session_id = ?)
            OR message_id IN (SELECT id FROM agent_messages WHERE session_id = ?)`,
        [sessionId, sessionId]
      );
      this.run(`DELETE FROM agent_resources WHERE session_id = ?`, [sessionId]);
      this.run(`DELETE FROM agent_tool_calls WHERE session_id = ?`, [sessionId]);
      this.run(`DELETE FROM agent_session_summaries WHERE session_id = ?`, [sessionId]);
      this.run(`DELETE FROM agent_runs WHERE session_id = ?`, [sessionId]);
      this.run(`DELETE FROM agent_messages WHERE session_id = ?`, [sessionId]);
      this.run(`DELETE FROM agent_sessions WHERE id = ?`, [sessionId]);
      this.run("COMMIT");
    } catch (error) {
      this.run("ROLLBACK");
      throw error;
    }

    for (const messageId of messageIds) {
      this.subscribers.delete(messageId);
    }

    for (const runId of runIds) {
      this.runSubscribers.delete(runId);
    }

    this.persist();
    return true;
  }

  getSessionSummary(sessionId: string): AgentSessionSummaryRecord | undefined {
    const row = this.queryOne(
      `SELECT
         id,
         session_id,
         version,
         summary_json,
         covered_message_id,
         covered_message_created_at,
         source_summary_id,
         schema_version,
         created_at,
         updated_at
       FROM agent_session_summaries
       WHERE session_id = ?
       ORDER BY version DESC, created_at DESC
       LIMIT 1`,
      [sessionId]
    );

    return row ? this.toSessionSummaryRecord(row) : undefined;
  }

  getSessionSummaryBeforeMessage(sessionId: string, messageId: string): AgentSessionSummaryRecord | undefined {
    const targetMessage = this.getMessage(messageId);

    if (!targetMessage || targetMessage.sessionId !== sessionId) {
      return undefined;
    }

    const orderedMessages = this.getMessagesBySession(sessionId);
    const messageOrder = new Map(orderedMessages.map((message, index) => [message.id, index]));
    const targetIndex = messageOrder.get(messageId);

    if (targetIndex === undefined) {
      return undefined;
    }

    return this.listSessionSummaries(sessionId)
      .filter((summary) => {
        const coveredIndex = messageOrder.get(summary.coveredMessageId);
        return coveredIndex !== undefined && coveredIndex < targetIndex;
      })
      .sort((leftSummary, rightSummary) => {
        const leftCoveredIndex = messageOrder.get(leftSummary.coveredMessageId) ?? -1;
        const rightCoveredIndex = messageOrder.get(rightSummary.coveredMessageId) ?? -1;

        if (leftCoveredIndex !== rightCoveredIndex) {
          return rightCoveredIndex - leftCoveredIndex;
        }

        return rightSummary.version - leftSummary.version;
      })[0];
  }

  listSessionSummaries(sessionId: string): AgentSessionSummaryRecord[] {
    return this.queryMany(
      `SELECT
         id,
         session_id,
         version,
         summary_json,
         covered_message_id,
         covered_message_created_at,
         source_summary_id,
         schema_version,
         created_at,
         updated_at
       FROM agent_session_summaries
       WHERE session_id = ?
       ORDER BY version ASC, created_at ASC`,
      [sessionId]
    ).map((row) => this.toSessionSummaryRecord(row));
  }

  upsertSessionSummary(input: UpsertAgentSessionSummaryInput): AgentSessionSummaryRecord {
    const timestamp = now();
    const previousSummary = this.getSessionSummary(input.sessionId);
    const coveredMessage = this.getMessage(input.coveredMessageId);

    // 摘要一定要指向一个真实消息，coveredMessageId 表示“摘要已经覆盖到哪里”。
    // 下次构造上下文时，ContextBuilder 会从这个消息之后继续补最近原文。
    if (!coveredMessage || coveredMessage.sessionId !== input.sessionId) {
      throw new Error(`SQLite 会话摘要覆盖消息无效：${input.coveredMessageId}`);
    }

    const summaryId = `summary_${randomUUID()}`;
    const version = (previousSummary?.version ?? 0) + 1;

    this.run(
      `INSERT INTO agent_session_summaries (
         id,
         session_id,
         version,
         summary_json,
         covered_message_id,
         covered_message_created_at,
         source_summary_id,
         schema_version,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        summaryId,
        input.sessionId,
        version,
        JSON.stringify(input.summary),
        input.coveredMessageId,
        coveredMessage.createdAt,
        previousSummary?.id ?? null,
        input.schemaVersion ?? previousSummary?.schemaVersion ?? 1,
        timestamp,
        timestamp
      ]
    );

    this.touchSession(input.sessionId, timestamp);
    this.persist();
    const storedSummary = this.listSessionSummaries(input.sessionId).find((summary) => summary.id === summaryId);

    if (!storedSummary) {
      throw new Error("SQLite 会话摘要写入失败");
    }

    return storedSummary;
  }

  createRun(input: CreateAgentRunInput): AgentRunRecord {
    const timestamp = now();
    const run: AgentRunRecord = {
      id: createId("run"),
      sessionId: input.sessionId,
      status: input.status,
      phase: input.phase,
      userMessageId: input.userMessageId,
      systemMessageId: input.systemMessageId,
      assistantMessageId: input.assistantMessageId,
      error: input.error,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.run(
      `INSERT INTO agent_runs (
         id,
         session_id,
         status,
         phase,
         user_message_id,
         system_message_id,
         assistant_message_id,
         error_json,
         created_at,
         updated_at,
         completed_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.sessionId,
        run.status,
        run.phase,
        run.userMessageId,
        run.systemMessageId ?? null,
        run.assistantMessageId ?? null,
        run.error ? JSON.stringify(run.error) : null,
        timestamp,
        timestamp,
        null
      ]
    );
    this.touchSession(run.sessionId, timestamp);
    this.persist();
    return run;
  }

  updateRun(runId: string, input: UpdateAgentRunInput): AgentRunRecord | undefined {
    const existingRun = this.getRun(runId);

    if (!existingRun) {
      return undefined;
    }

    const timestamp = now();
    const status = input.status ?? existingRun.status;
    const phase = input.phase ?? existingRun.phase;
    // run 是用户一次请求的执行单元，状态流转必须单向：
    // running 可以进入 completed/failed/cancelled，终态不能再被改回 running。
    assertValidRunTransition(existingRun.status, status);
    assertRunPhaseMatchesStatus(status, phase);
    const systemMessageId = input.systemMessageId ?? existingRun.systemMessageId;
    const assistantMessageId = input.assistantMessageId ?? existingRun.assistantMessageId;
    const error = input.error;
    const completedAt = input.completedAt ?? existingRun.completedAt;

    this.run(
      `UPDATE agent_runs
       SET status = ?,
           phase = ?,
           system_message_id = ?,
           assistant_message_id = ?,
           error_json = ?,
           updated_at = ?,
           completed_at = ?
       WHERE id = ?`,
      [
        status,
        phase,
        systemMessageId ?? null,
        assistantMessageId ?? null,
        error ? JSON.stringify(error) : null,
        timestamp,
        completedAt ?? null,
        runId
      ]
    );
    this.touchSession(existingRun.sessionId, timestamp);
    this.persist();
    return this.getRun(runId);
  }

  getRun(runId: string): AgentRunRecord | undefined {
    const row = this.queryOne(
      `SELECT
         id,
         session_id,
         status,
         phase,
         user_message_id,
         system_message_id,
         assistant_message_id,
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

  getRunsByMessageId(messageId: string): AgentRunRecord[] {
    return this.queryMany(
      `SELECT
         id,
         session_id,
         status,
         phase,
         user_message_id,
         system_message_id,
         assistant_message_id,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM agent_runs
       WHERE user_message_id = ?
          OR system_message_id = ?
          OR assistant_message_id = ?
       ORDER BY created_at ASC, rowid ASC`,
      [messageId, messageId, messageId]
    ).map((row) => this.toRunRecord(row));
  }

  createMessage(input: CreateAgentMessageInput): AgentMessageRecord {
    const timestamp = now();
    const message: AgentMessageRecord = {
      id: createId("msg"),
      sessionId: input.sessionId,
      role: input.role,
      status: input.status,
      parts: input.parts,
      maxIterations: input.maxIterations,
      error: input.error,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.run(
      `INSERT INTO agent_messages (
         id,
         session_id,
         role,
         status,
         parts_json,
         max_iterations,
         error_json,
         created_at,
         updated_at,
         completed_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.sessionId,
        message.role,
        message.status,
        JSON.stringify(message.parts),
        message.maxIterations ?? null,
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
    // message 状态也只允许 running -> 终态。这个保护能避免延迟到达的流式事件
    // 把已经失败/取消/完成的消息重新改成运行中。
    assertValidMessageTransition(existingMessage.status, status);
    const parts = input.parts ?? existingMessage.parts;
    const error = input.error;
    const completedAt = input.completedAt ?? existingMessage.completedAt;

    this.run(
      `UPDATE agent_messages
       SET status = ?,
           parts_json = ?,
           error_json = ?,
           updated_at = ?,
           completed_at = ?
       WHERE id = ?`,
      [
        status,
        JSON.stringify(parts),
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
         parts_json,
         max_iterations,
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
         parts_json,
         max_iterations,
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

  getRecentMessagesBySession(sessionId: string, limit: number): AgentMessageRecord[] {
    const normalizedLimit = normalizeLimit(limit);

    if (normalizedLimit === 0) {
      return [];
    }

    return this.queryMany(
      `SELECT
         id,
         session_id,
         role,
         status,
         parts_json,
         max_iterations,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM (
         SELECT rowid, *
         FROM agent_messages
         WHERE session_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?
       )
       ORDER BY created_at ASC, rowid ASC`,
      [sessionId, normalizedLimit]
    ).map((row) => this.toMessageRecord(row));
  }

  getRecentContextMessagesBySession(sessionId: string, limit: number): AgentMessageRecord[] {
    const normalizedLimit = normalizeLimit(limit);

    if (normalizedLimit === 0) {
      return [];
    }

    return this.queryMany(
      `SELECT
         id,
         session_id,
         role,
         status,
         parts_json,
         max_iterations,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM (
         SELECT rowid, *
         FROM agent_messages
         WHERE session_id = ?
           AND role IN ('user', 'assistant')
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?
       )
       ORDER BY created_at ASC, rowid ASC`,
      [sessionId, normalizedLimit]
    ).map((row) => this.toMessageRecord(row));
  }

  getMessagesBefore(sessionId: string, beforeMessageId: string, limit: number): AgentMessageRecord[] {
    const normalizedLimit = normalizeLimit(limit);
    const cursor = this.getMessageCursor(beforeMessageId);

    if (normalizedLimit === 0 || !cursor || cursor.sessionId !== sessionId) {
      return [];
    }

    return this.queryMany(
      `SELECT
         id,
         session_id,
         role,
         status,
         parts_json,
         max_iterations,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM (
         SELECT rowid, *
         FROM agent_messages
         WHERE session_id = ?
           AND (created_at < ? OR (created_at = ? AND rowid < ?))
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?
       )
       ORDER BY created_at ASC, rowid ASC`,
      [sessionId, cursor.createdAt, cursor.createdAt, cursor.rowid, normalizedLimit]
    ).map((row) => this.toMessageRecord(row));
  }

  getMessagesAfter(sessionId: string, afterMessageId: string | undefined, limit?: number): AgentMessageRecord[] {
    const cursor = afterMessageId ? this.getMessageCursor(afterMessageId) : undefined;
    const hasCursor = Boolean(cursor && cursor.sessionId === sessionId);
    const normalizedLimit = limit === undefined ? undefined : normalizeLimit(limit);

    if (normalizedLimit === 0) {
      return [];
    }

    const limitClause = normalizedLimit === undefined ? "" : "LIMIT ?";
    const params: SqlValue[] = hasCursor
      ? [sessionId, cursor?.createdAt ?? "", cursor?.createdAt ?? "", cursor?.rowid ?? 0]
      : [sessionId];

    if (normalizedLimit !== undefined) {
      params.push(normalizedLimit);
    }

    return this.queryMany(
      `SELECT
         id,
         session_id,
         role,
         status,
         parts_json,
         max_iterations,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM agent_messages
       WHERE session_id = ?
         ${hasCursor ? "AND (created_at > ? OR (created_at = ? AND rowid > ?))" : ""}
       ORDER BY created_at ASC, rowid ASC
       ${limitClause}`,
      params
    ).map((row) => this.toMessageRecord(row));
  }

  getRecentMessagesAfter(sessionId: string, afterMessageId: string | undefined, limit: number): AgentMessageRecord[] {
    const normalizedLimit = normalizeLimit(limit);
    const cursor = afterMessageId ? this.getMessageCursor(afterMessageId) : undefined;
    const hasCursor = Boolean(cursor && cursor.sessionId === sessionId);
    const params: SqlValue[] = hasCursor
      ? [sessionId, cursor?.createdAt ?? "", cursor?.createdAt ?? "", cursor?.rowid ?? 0, normalizedLimit]
      : [sessionId, normalizedLimit];

    if (normalizedLimit === 0) {
      return [];
    }

    return this.queryMany(
      `SELECT
         id,
         session_id,
         role,
         status,
         parts_json,
         max_iterations,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM (
         SELECT rowid, *
         FROM agent_messages
         WHERE session_id = ?
           ${hasCursor ? "AND (created_at > ? OR (created_at = ? AND rowid > ?))" : ""}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?
       )
       ORDER BY created_at ASC, rowid ASC`,
      params
    ).map((row) => this.toMessageRecord(row));
  }

  countMessagesAfter(sessionId: string, afterMessageId?: string): number {
    const cursor = afterMessageId ? this.getMessageCursor(afterMessageId) : undefined;
    const hasCursor = Boolean(cursor && cursor.sessionId === sessionId);
    const row = this.queryOne(
      `SELECT COUNT(*) AS message_count
       FROM agent_messages
       WHERE session_id = ?
         ${hasCursor ? "AND (created_at > ? OR (created_at = ? AND rowid > ?))" : ""}`,
      hasCursor ? [sessionId, cursor?.createdAt ?? "", cursor?.createdAt ?? "", cursor?.rowid ?? 0] : [sessionId]
    );

    return optionalNumber(row?.message_count) ?? 0;
  }

  getContextMessagesAfter(sessionId: string, afterMessageId: string | undefined, limit?: number): AgentMessageRecord[] {
    const cursor = afterMessageId ? this.getMessageCursor(afterMessageId) : undefined;
    const hasCursor = Boolean(cursor && cursor.sessionId === sessionId);
    const normalizedLimit = limit === undefined ? undefined : normalizeLimit(limit);

    if (normalizedLimit === 0) {
      return [];
    }

    const limitClause = normalizedLimit === undefined ? "" : "LIMIT ?";
    const params: SqlValue[] = hasCursor
      ? [sessionId, cursor?.createdAt ?? "", cursor?.createdAt ?? "", cursor?.rowid ?? 0]
      : [sessionId];

    if (normalizedLimit !== undefined) {
      params.push(normalizedLimit);
    }

    return this.queryMany(
      `SELECT
         id,
         session_id,
         role,
         status,
         parts_json,
         max_iterations,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM agent_messages
       WHERE session_id = ?
         AND ${contextMessageFilter}
         ${hasCursor ? "AND (created_at > ? OR (created_at = ? AND rowid > ?))" : ""}
       ORDER BY created_at ASC, rowid ASC
       ${limitClause}`,
      params
    ).map((row) => this.toMessageRecord(row));
  }

  getRecentContextMessagesAfter(sessionId: string, afterMessageId: string | undefined, limit: number): AgentMessageRecord[] {
    const normalizedLimit = normalizeLimit(limit);
    const cursor = afterMessageId ? this.getMessageCursor(afterMessageId) : undefined;
    const hasCursor = Boolean(cursor && cursor.sessionId === sessionId);
    const params: SqlValue[] = hasCursor
      ? [sessionId, cursor?.createdAt ?? "", cursor?.createdAt ?? "", cursor?.rowid ?? 0, normalizedLimit]
      : [sessionId, normalizedLimit];

    if (normalizedLimit === 0) {
      return [];
    }

    return this.queryMany(
      `SELECT
         id,
         session_id,
         role,
         status,
         parts_json,
         max_iterations,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM (
         SELECT rowid, *
         FROM agent_messages
         WHERE session_id = ?
           AND role IN ('user', 'assistant')
           ${hasCursor ? "AND (created_at > ? OR (created_at = ? AND rowid > ?))" : ""}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?
       )
       ORDER BY created_at ASC, rowid ASC`,
      params
    ).map((row) => this.toMessageRecord(row));
  }

  countContextMessagesAfter(sessionId: string, afterMessageId?: string): number {
    const cursor = afterMessageId ? this.getMessageCursor(afterMessageId) : undefined;
    const hasCursor = Boolean(cursor && cursor.sessionId === sessionId);
    const row = this.queryOne(
      `SELECT COUNT(*) AS message_count
       FROM agent_messages
       WHERE session_id = ?
         AND ${contextMessageFilter}
         ${hasCursor ? "AND (created_at > ? OR (created_at = ? AND rowid > ?))" : ""}`,
      hasCursor ? [sessionId, cursor?.createdAt ?? "", cursor?.createdAt ?? "", cursor?.rowid ?? 0] : [sessionId]
    );

    return optionalNumber(row?.message_count) ?? 0;
  }

  getContextMessagesBefore(
    sessionId: string,
    beforeMessageId: string,
    afterMessageId: string | undefined,
    limit?: number
  ): AgentMessageRecord[] {
    const beforeCursor = this.getMessageCursor(beforeMessageId);
    const afterCursor = afterMessageId ? this.getMessageCursor(afterMessageId) : undefined;
    const hasAfterCursor = Boolean(afterCursor && afterCursor.sessionId === sessionId);
    const normalizedLimit = limit === undefined ? undefined : normalizeLimit(limit);

    if (normalizedLimit === 0 || !beforeCursor || beforeCursor.sessionId !== sessionId) {
      return [];
    }

    const limitClause = normalizedLimit === undefined ? "" : "LIMIT ?";
    const params: SqlValue[] = [
      sessionId,
      beforeCursor.createdAt,
      beforeCursor.createdAt,
      beforeCursor.rowid
    ];

    if (hasAfterCursor) {
      params.push(afterCursor?.createdAt ?? "", afterCursor?.createdAt ?? "", afterCursor?.rowid ?? 0);
    }

    if (normalizedLimit !== undefined) {
      params.push(normalizedLimit);
    }

    return this.queryMany(
      `SELECT
         id,
         session_id,
         role,
         status,
         parts_json,
         max_iterations,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM agent_messages
       WHERE session_id = ?
         AND ${contextMessageFilter}
         AND (created_at < ? OR (created_at = ? AND rowid < ?))
         ${hasAfterCursor ? "AND (created_at > ? OR (created_at = ? AND rowid > ?))" : ""}
       ORDER BY created_at ASC, rowid ASC
       ${limitClause}`,
      params
    ).map((row) => this.toMessageRecord(row));
  }

  getRecentContextMessagesBefore(
    sessionId: string,
    beforeMessageId: string,
    afterMessageId: string | undefined,
    limit: number
  ): AgentMessageRecord[] {
    const beforeCursor = this.getMessageCursor(beforeMessageId);
    const afterCursor = afterMessageId ? this.getMessageCursor(afterMessageId) : undefined;
    const hasAfterCursor = Boolean(afterCursor && afterCursor.sessionId === sessionId);
    const normalizedLimit = normalizeLimit(limit);

    if (normalizedLimit === 0 || !beforeCursor || beforeCursor.sessionId !== sessionId) {
      return [];
    }

    const params: SqlValue[] = [
      sessionId,
      beforeCursor.createdAt,
      beforeCursor.createdAt,
      beforeCursor.rowid
    ];

    if (hasAfterCursor) {
      params.push(afterCursor?.createdAt ?? "", afterCursor?.createdAt ?? "", afterCursor?.rowid ?? 0);
    }

    params.push(normalizedLimit);

    return this.queryMany(
      `SELECT
         id,
         session_id,
         role,
         status,
         parts_json,
         max_iterations,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM (
         SELECT rowid, *
         FROM agent_messages
         WHERE session_id = ?
           AND role IN ('user', 'assistant')
           AND (created_at < ? OR (created_at = ? AND rowid < ?))
           ${hasAfterCursor ? "AND (created_at > ? OR (created_at = ? AND rowid > ?))" : ""}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?
       )
       ORDER BY created_at ASC, rowid ASC`,
      params
    ).map((row) => this.toMessageRecord(row));
  }

  countContextMessagesBefore(sessionId: string, beforeMessageId: string, afterMessageId?: string): number {
    const beforeCursor = this.getMessageCursor(beforeMessageId);
    const afterCursor = afterMessageId ? this.getMessageCursor(afterMessageId) : undefined;
    const hasAfterCursor = Boolean(afterCursor && afterCursor.sessionId === sessionId);

    if (!beforeCursor || beforeCursor.sessionId !== sessionId) {
      return 0;
    }

    const params: SqlValue[] = [
      sessionId,
      beforeCursor.createdAt,
      beforeCursor.createdAt,
      beforeCursor.rowid
    ];

    if (hasAfterCursor) {
      params.push(afterCursor?.createdAt ?? "", afterCursor?.createdAt ?? "", afterCursor?.rowid ?? 0);
    }

    const row = this.queryOne(
      `SELECT COUNT(*) AS message_count
       FROM agent_messages
       WHERE session_id = ?
         AND ${contextMessageFilter}
         AND (created_at < ? OR (created_at = ? AND rowid < ?))
         ${hasAfterCursor ? "AND (created_at > ? OR (created_at = ? AND rowid > ?))" : ""}`,
      params
    );

    return optionalNumber(row?.message_count) ?? 0;
  }

  pruneExpiredEvents(input: PruneExpiredAgentEventsInput): PruneAgentEventsResult {
    const batchSize = normalizePositiveInteger(input.batchSize);
    const maxBatches = normalizePositiveInteger(input.maxBatches);
    let messageEvents = 0;
    let runEvents = 0;
    let batches = 0;

    // agent_events 是给 SSE 断线重连/刷新恢复用的回放日志，不需要永久保存。
    // 这里分批删除，避免一次 DELETE 太大导致 UI 请求被长时间阻塞。
    while (batches < maxBatches) {
      const deletedEvents = this.deleteExpiredEventBatch(input.nowIso, batchSize);
      const deletedMessageEvents = deletedEvents.messageEvents;
      const deletedRunEvents = deletedEvents.runEvents;

      if (deletedEvents.total === 0) {
        break;
      }

      messageEvents += deletedMessageEvents;
      runEvents += deletedRunEvents;
      batches += 1;

      if (deletedEvents.total < batchSize) {
        break;
      }
    }

    if (messageEvents > 0 || runEvents > 0) {
      this.persist();
    }

    return {
      messageEvents,
      runEvents,
      batches,
      reachedLimit: batches >= maxBatches && this.hasExpiredEvents(input.nowIso)
    };
  }

  createToolCall(input: CreateAgentToolCallInput): AgentToolCallRecord {
    const timestamp = now();
    // tool_call 是审计和 UI trace 的结构化记录：它和原始 stream event 不一样，
    // 适合后续统计“工具成功率/耗时/失败原因”，也能按 message/session 查询。
    const toolCall: AgentToolCallRecord = {
      id: createId("tool_call"),
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: input.messageId,
      iteration: input.iteration,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      status: input.status ?? "running",
      arguments: input.arguments,
      startedAt: timestamp
    };

    this.run(
      `INSERT INTO agent_tool_calls (
         id,
         session_id,
         run_id,
         message_id,
         iteration,
         tool_call_id,
         tool_name,
         status,
         arguments_json,
         result_summary_json,
         error_json,
         started_at,
         completed_at,
         duration_ms
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        toolCall.id,
        toolCall.sessionId,
        toolCall.runId ?? null,
        toolCall.messageId,
        toolCall.iteration,
        toolCall.toolCallId ?? null,
        toolCall.toolName,
        toolCall.status,
        JSON.stringify(toolCall.arguments),
        null,
        null,
        toolCall.startedAt,
        null,
        null
      ]
    );
    this.touchSession(toolCall.sessionId, timestamp);
    this.persist();
    return toolCall;
  }

  updateToolCall(toolCallRowId: string, input: UpdateAgentToolCallInput): AgentToolCallRecord | undefined {
    const existingToolCall = this.getToolCall(toolCallRowId);

    if (!existingToolCall) {
      return undefined;
    }

    const timestamp = now();
    const status = input.status ?? existingToolCall.status;
    const completedAt = input.completedAt ?? (isTerminalToolCallStatus(status) ? existingToolCall.completedAt ?? timestamp : existingToolCall.completedAt);

    this.run(
      `UPDATE agent_tool_calls
       SET status = ?,
           result_summary_json = ?,
           error_json = ?,
           completed_at = ?,
           duration_ms = ?
       WHERE id = ?`,
      [
        status,
        input.resultSummary !== undefined ? JSON.stringify(input.resultSummary) : existingToolCall.resultSummary ? JSON.stringify(existingToolCall.resultSummary) : null,
        input.error !== undefined ? JSON.stringify(input.error) : existingToolCall.error ? JSON.stringify(existingToolCall.error) : null,
        completedAt ?? null,
        input.durationMs ?? existingToolCall.durationMs ?? null,
        toolCallRowId
      ]
    );
    this.touchSession(existingToolCall.sessionId, timestamp);
    this.persist();
    return this.getToolCall(toolCallRowId);
  }

  getToolCallByMessageToolCall(messageId: string, toolCallId: string): AgentToolCallRecord | undefined {
    const row = this.queryOne(
      `SELECT
         id,
         session_id,
         run_id,
         message_id,
         iteration,
         tool_call_id,
         tool_name,
         status,
         arguments_json,
         result_summary_json,
         error_json,
         started_at,
         completed_at,
         duration_ms
       FROM agent_tool_calls
       WHERE message_id = ? AND tool_call_id = ?
       ORDER BY started_at DESC, rowid DESC
       LIMIT 1`,
      [messageId, toolCallId]
    );

    return row ? this.toToolCallRecord(row) : undefined;
  }

  getToolCallsBySession(sessionId: string): AgentToolCallRecord[] {
    return this.queryMany(
      `SELECT
         id,
         session_id,
         run_id,
         message_id,
         iteration,
         tool_call_id,
         tool_name,
         status,
         arguments_json,
         result_summary_json,
         error_json,
         started_at,
         completed_at,
         duration_ms
       FROM agent_tool_calls
       WHERE session_id = ?
       ORDER BY started_at ASC, rowid ASC`,
      [sessionId]
    ).map((row) => this.toToolCallRecord(row));
  }

  createResource(input: CreateAgentResourceInput): AgentResourceRecord {
    const timestamp = now();
    // resource 是工具产物的持久化索引，比如生成图片/视频。
    // message part 里只引用 resourceId，真正的 URL、尺寸、状态集中存在这里，后续更新更方便。
    const resource: AgentResourceRecord = {
      id: createId("res"),
      sessionId: input.sessionId,
      messageId: input.messageId,
      toolCallRowId: input.toolCallRowId,
      toolCallId: input.toolCallId,
      type: input.type,
      mime: input.mime,
      url: input.url,
      name: input.name,
      status: input.status,
      width: input.width,
      height: input.height,
      metadata: input.metadata,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.run(
      `INSERT INTO agent_resources (
         id,
         session_id,
         message_id,
         tool_call_row_id,
         tool_call_id,
         type,
         mime,
         url,
         name,
         status,
         width,
         height,
         metadata_json,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resource.id,
        resource.sessionId,
        resource.messageId,
        resource.toolCallRowId ?? null,
        resource.toolCallId ?? null,
        resource.type,
        resource.mime ?? null,
        resource.url ?? null,
        resource.name ?? null,
        resource.status,
        resource.width ?? null,
        resource.height ?? null,
        resource.metadata ? JSON.stringify(resource.metadata) : null,
        resource.createdAt,
        resource.updatedAt
      ]
    );
    this.touchSession(resource.sessionId, timestamp);
    this.persist();
    return resource;
  }

  updateResource(resourceId: string, input: UpdateAgentResourceInput): AgentResourceRecord | undefined {
    const existingResource = this.getResource(resourceId);

    if (!existingResource) {
      return undefined;
    }

    const timestamp = now();

    this.run(
      `UPDATE agent_resources
       SET tool_call_row_id = ?,
           tool_call_id = ?,
           mime = ?,
           url = ?,
           name = ?,
           status = ?,
           width = ?,
           height = ?,
           metadata_json = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        input.toolCallRowId ?? existingResource.toolCallRowId ?? null,
        input.toolCallId ?? existingResource.toolCallId ?? null,
        input.mime ?? existingResource.mime ?? null,
        input.url ?? existingResource.url ?? null,
        input.name ?? existingResource.name ?? null,
        input.status ?? existingResource.status,
        input.width ?? existingResource.width ?? null,
        input.height ?? existingResource.height ?? null,
        input.metadata !== undefined ? JSON.stringify(input.metadata) : existingResource.metadata ? JSON.stringify(existingResource.metadata) : null,
        timestamp,
        resourceId
      ]
    );
    this.touchSession(existingResource.sessionId, timestamp);
    this.persist();
    return this.getResource(resourceId);
  }

  getResourcesByMessages(messageIds: string[]): AgentResourceRecord[] {
    if (messageIds.length === 0) {
      return [];
    }

    const placeholders = messageIds.map(() => "?").join(", ");

    return this.queryMany(
      `SELECT
         id,
         session_id,
         message_id,
         tool_call_row_id,
         tool_call_id,
         type,
         mime,
         url,
         name,
         status,
         width,
         height,
         metadata_json,
         created_at,
         updated_at
       FROM agent_resources
       WHERE message_id IN (${placeholders})
       ORDER BY created_at ASC, rowid ASC`,
      messageIds
    ).map((row) => this.toResourceRecord(row));
  }

  createProcessStep(input: CreateAgentProcessStepInput): AgentProcessStepRecord {
    const timestamp = now();
    // process_step 是给用户看的“任务进度条”，粒度比原始事件更粗。
    // 例如一次工具调用可以对应一个步骤，便于前端稳定渲染而不用理解所有 event 类型。
    const processStep: AgentProcessStepRecord = {
      id: createId("step"),
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: input.messageId,
      toolCallRowId: input.toolCallRowId,
      toolCallId: input.toolCallId,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      status: input.status ?? "running",
      orderIndex: input.orderIndex,
      metadata: input.metadata,
      startedAt: timestamp,
      updatedAt: timestamp,
      completedAt: input.status && isTerminalProcessStepStatus(input.status) ? timestamp : undefined
    };

    this.run(
      `INSERT INTO agent_process_steps (
         id,
         session_id,
         run_id,
         message_id,
         tool_call_row_id,
         tool_call_id,
         kind,
         title,
         summary,
         status,
         order_index,
         metadata_json,
         started_at,
         updated_at,
         completed_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        processStep.id,
        processStep.sessionId,
        processStep.runId ?? null,
        processStep.messageId,
        processStep.toolCallRowId ?? null,
        processStep.toolCallId ?? null,
        processStep.kind,
        processStep.title,
        processStep.summary ?? null,
        processStep.status,
        processStep.orderIndex,
        processStep.metadata ? JSON.stringify(processStep.metadata) : null,
        processStep.startedAt,
        processStep.updatedAt,
        processStep.completedAt ?? null
      ]
    );
    this.touchSession(processStep.sessionId, timestamp);
    this.persist();
    return processStep;
  }

  updateProcessStep(stepId: string, input: UpdateAgentProcessStepInput): AgentProcessStepRecord | undefined {
    const existingStep = this.getProcessStep(stepId);

    if (!existingStep) {
      return undefined;
    }

    const timestamp = now();
    const status = input.status ?? existingStep.status;
    const completedAt = input.completedAt ?? (isTerminalProcessStepStatus(status) ? existingStep.completedAt ?? timestamp : existingStep.completedAt);

    this.run(
      `UPDATE agent_process_steps
       SET tool_call_row_id = ?,
           tool_call_id = ?,
           title = ?,
           summary = ?,
           status = ?,
           metadata_json = ?,
           updated_at = ?,
           completed_at = ?
       WHERE id = ?`,
      [
        input.toolCallRowId ?? existingStep.toolCallRowId ?? null,
        input.toolCallId ?? existingStep.toolCallId ?? null,
        input.title ?? existingStep.title,
        input.summary !== undefined ? input.summary : existingStep.summary ?? null,
        status,
        input.metadata !== undefined ? JSON.stringify(input.metadata) : existingStep.metadata ? JSON.stringify(existingStep.metadata) : null,
        timestamp,
        completedAt ?? null,
        stepId
      ]
    );
    this.touchSession(existingStep.sessionId, timestamp);
    this.persist();
    return this.getProcessStep(stepId);
  }

  getProcessStepsByMessages(messageIds: string[]): AgentProcessStepRecord[] {
    if (messageIds.length === 0) {
      return [];
    }

    const placeholders = messageIds.map(() => "?").join(", ");

    return this.queryMany(
      `SELECT
         id,
         session_id,
         run_id,
         message_id,
         tool_call_row_id,
         tool_call_id,
         kind,
         title,
         summary,
         status,
         order_index,
         metadata_json,
         started_at,
         updated_at,
         completed_at
       FROM agent_process_steps
       WHERE message_id IN (${placeholders})
       ORDER BY message_id ASC, order_index ASC, started_at ASC, rowid ASC`,
      messageIds
    ).map((row) => this.toProcessStepRecord(row));
  }

  appendEvent(messageId: string, event: AgentStreamEvent): StoredAgentEvent | undefined {
    return this.appendStoredEvent({ messageId, event });
  }

  publishTransientEvent(messageId: string, event: AgentStreamEvent): StoredAgentEvent | undefined {
    const storedEvent = this.createTransientStoredEvent(event, { messageId });
    this.publish(storedEvent);
    return storedEvent;
  }

  getEvents(messageId: string, after = 0): StoredAgentEvent[] {
    return this.queryMany(
      `SELECT id, seq, run_id, message_id, payload_json, created_at
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

  appendRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): StoredAgentEvent | undefined {
    return this.appendStoredEvent({ runId, messageId, event });
  }

  publishTransientRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): StoredAgentEvent | undefined {
    const storedEvent = this.createTransientStoredEvent(event, { runId, messageId });
    this.publishRun(storedEvent);
    return storedEvent;
  }

  getRunEvents(runId: string, after = 0): StoredAgentEvent[] {
    return this.queryMany(
      `SELECT id, seq, run_id, message_id, payload_json, created_at
       FROM agent_events
       WHERE run_id = ? AND seq > ?
       ORDER BY seq ASC`,
      [runId, after]
    ).map((row) => this.toStoredEvent(row));
  }

  subscribeRun(runId: string, listener: AgentEventListener): () => void {
    const listeners = this.runSubscribers.get(runId) ?? new Set<AgentEventListener>();
    listeners.add(listener);
    this.runSubscribers.set(runId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.runSubscribers.delete(runId);
      }
    };
  }

  close() {
    if (this.hasUnpersistedChanges) {
      this.persist();
    }

    this.database.close();
  }

  private initializeSchema() {
    // schema 放在代码里初始化，方便本地 demo 零迁移启动。
    // 重要表可以按职责读：
    // sessions/messages 是聊天主数据；runs 是一次执行；events 是 SSE 回放；
    // tool_calls/resources/process_steps 是工具审计、媒体产物和可视化进度。
    this.run(`
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
        parts_json TEXT NOT NULL DEFAULT '[]',
        max_iterations INTEGER,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        message_id TEXT,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        CHECK (run_id IS NOT NULL OR message_id IS NOT NULL)
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        system_message_id TEXT,
        assistant_message_id TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_session_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        summary_json TEXT NOT NULL,
        covered_message_id TEXT NOT NULL,
        covered_message_created_at TEXT NOT NULL,
        source_summary_id TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_tool_calls (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        message_id TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        arguments_json TEXT NOT NULL DEFAULT '{}',
        result_summary_json TEXT,
        error_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS agent_resources (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        tool_call_row_id TEXT,
        tool_call_id TEXT,
        type TEXT NOT NULL,
        mime TEXT,
        url TEXT,
        name TEXT,
        status TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_process_steps (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        message_id TEXT NOT NULL,
        tool_call_row_id TEXT,
        tool_call_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        status TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        metadata_json TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_agent_messages_session_id_created_at
        ON agent_messages (session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_agent_events_message_id_seq
        ON agent_events (message_id, seq);

      CREATE INDEX IF NOT EXISTS idx_agent_runs_session_id_created_at
        ON agent_runs (session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_session_id_started_at
        ON agent_tool_calls (session_id, started_at);

      CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_message_id_tool_call_id
        ON agent_tool_calls (message_id, tool_call_id);

      CREATE INDEX IF NOT EXISTS idx_agent_resources_message_id_created_at
        ON agent_resources (message_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_agent_resources_session_id_created_at
        ON agent_resources (session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_agent_process_steps_message_order
        ON agent_process_steps (message_id, order_index);
    `);
    this.ensureUnifiedEventSchema();
    this.ensureCurrentSchemaIndexes();
  }

  private ensureCurrentSchemaIndexes() {
    this.run(`
      DROP INDEX IF EXISTS idx_agent_run_events_run_id_seq;
      DROP INDEX IF EXISTS idx_agent_run_events_expires_at;

      CREATE INDEX IF NOT EXISTS idx_agent_session_summaries_session_version
        ON agent_session_summaries (session_id, version);

      CREATE INDEX IF NOT EXISTS idx_agent_events_run_id_seq
        ON agent_events (run_id, seq);

      CREATE INDEX IF NOT EXISTS idx_agent_events_message_id_seq
        ON agent_events (message_id, seq);

      CREATE INDEX IF NOT EXISTS idx_agent_events_expires_at
        ON agent_events (expires_at);
    `);
  }

  private ensureUnifiedEventSchema() {
    const eventColumns = this.getTableColumns("agent_events");
    const isLegacyMessageEventTable = eventColumns.length > 0 && !eventColumns.includes("run_id");

    // 旧版本事件按 message 存，新版本按 run 订阅 SSE，同时保留 message_id 方便定位消息。
    // 这里做一次兼容清理，避免历史表结构和新查询混用。
    if (isLegacyMessageEventTable) {
      this.run(`DROP TABLE IF EXISTS agent_events`);
    }

    this.run(`
      DROP TABLE IF EXISTS agent_run_events;

      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        message_id TEXT,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        CHECK (run_id IS NOT NULL OR message_id IS NOT NULL)
      );
    `);
  }

  private getTableColumns(tableName: string): string[] {
    return this.queryMany(`PRAGMA table_info(${tableName})`).map((row) => requiredString(row.name, "name"));
  }

  private getToolCall(toolCallRowId: string): AgentToolCallRecord | undefined {
    const row = this.queryOne(
      `SELECT
         id,
         session_id,
         run_id,
         message_id,
         iteration,
         tool_call_id,
         tool_name,
         status,
         arguments_json,
         result_summary_json,
         error_json,
         started_at,
         completed_at,
         duration_ms
       FROM agent_tool_calls
       WHERE id = ?`,
      [toolCallRowId]
    );

    return row ? this.toToolCallRecord(row) : undefined;
  }

  private getResource(resourceId: string): AgentResourceRecord | undefined {
    const row = this.queryOne(
      `SELECT
         id,
         session_id,
         message_id,
         tool_call_row_id,
         tool_call_id,
         type,
         mime,
         url,
         name,
         status,
         width,
         height,
         metadata_json,
         created_at,
         updated_at
       FROM agent_resources
       WHERE id = ?`,
      [resourceId]
    );

    return row ? this.toResourceRecord(row) : undefined;
  }

  private getProcessStep(stepId: string): AgentProcessStepRecord | undefined {
    const row = this.queryOne(
      `SELECT
         id,
         session_id,
         run_id,
         message_id,
         tool_call_row_id,
         tool_call_id,
         kind,
         title,
         summary,
         status,
         order_index,
         metadata_json,
         started_at,
         updated_at,
         completed_at
       FROM agent_process_steps
       WHERE id = ?`,
      [stepId]
    );

    return row ? this.toProcessStepRecord(row) : undefined;
  }

  private appendStoredEvent(input: { event: AgentStreamEvent; messageId?: string; runId?: string }): StoredAgentEvent {
    if (!input.messageId && !input.runId) {
      throw new Error("SQLite 事件缺少 messageId 或 runId");
    }

    const eventId = createId("event");
    const eventSeq = input.runId ? this.nextRunEventSeq(input.runId) : this.nextMessageEventSeq(input.messageId!);
    const timestamp = now();
    const expiresAt = addDaysIso(timestamp, this.eventRetentionDays);
    // seq 是客户端断线续传的游标：浏览器记住最后收到的 seq，
    // 重连时只请求 seq 之后的事件，就不会重复回放整条流。
    const storedEvent: StoredAgentEvent = {
      id: eventId,
      seq: eventSeq,
      messageId: input.messageId,
      runId: input.runId,
      event: input.event,
      createdAt: timestamp
    };

    this.run(
      `INSERT INTO agent_events (id, run_id, message_id, seq, type, payload_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        input.runId ?? null,
        input.messageId ?? null,
        eventSeq,
        input.event.type,
        JSON.stringify(input.event),
        timestamp,
        expiresAt
      ]
    );
    this.persist();
    // 写库后同时通知内存订阅者。这样当前连接能实时收到事件，
    // 断线后的新连接又能从 SQLite 读到同一批事件。
    this.publish(storedEvent);
    this.publishRun(storedEvent);
    return storedEvent;
  }

  private createTransientStoredEvent(
    event: AgentStreamEvent,
    scope: { messageId?: string; runId?: string }
  ): StoredAgentEvent {
    return {
      id: createId("event_live"),
      seq: 0,
      messageId: scope.messageId,
      runId: scope.runId,
      event,
      createdAt: now(),
      transient: true
    };
  }

  private nextMessageEventSeq(messageId: string): number {
    const row = this.queryOne(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
       FROM agent_events
       WHERE message_id = ? AND run_id IS NULL`,
      [messageId]
    );

    return optionalNumber(row?.next_seq) ?? 1;
  }

  private nextRunEventSeq(runId: string): number {
    const row = this.queryOne(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
       FROM agent_events
       WHERE run_id = ?`,
      [runId]
    );

    return optionalNumber(row?.next_seq) ?? 1;
  }

  private getMessageCursor(messageId: string): MessageCursor | undefined {
    const row = this.queryOne(
      `SELECT rowid, session_id, created_at
       FROM agent_messages
       WHERE id = ?`,
      [messageId]
    );

    if (!row) {
      return undefined;
    }

    return {
      sessionId: requiredString(row.session_id, "session_id"),
      createdAt: requiredString(row.created_at, "created_at"),
      rowid: optionalNumber(row.rowid) ?? 0
    };
  }

  private getSessionCursor(sessionId: string): SessionCursor | undefined {
    const row = this.queryOne(
      `SELECT rowid, updated_at
       FROM agent_sessions
       WHERE id = ?`,
      [sessionId]
    );

    if (!row) {
      return undefined;
    }

    return {
      updatedAt: requiredString(row.updated_at, "updated_at"),
      rowid: optionalNumber(row.rowid) ?? 0
    };
  }

  private publish(event: StoredAgentEvent) {
    if (!event.messageId) {
      return;
    }

    const listeners = this.subscribers.get(event.messageId);

    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  private publishRun(event: StoredAgentEvent) {
    if (!event.runId) {
      return;
    }

    const listeners = this.runSubscribers.get(event.runId);

    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  private touchSession(sessionId: string, timestamp: string) {
    this.run(
      `UPDATE agent_sessions
       SET updated_at = ?
       WHERE id = ?`,
      [timestamp, sessionId]
    );
  }

  private run(sql: string, params?: SqlParams): SqlDatabase {
    const command = this.getSqlCommand(sql);
    const beginsTransaction = command === "BEGIN";
    const endsTransaction = command === "COMMIT" || command === "ROLLBACK";

    // sql.js 是内存数据库，文件只是 export 后的快照。
    // 每次外层写入前先检查磁盘 mtime，可以兼容 API/worker 两个进程交替写同一个 SQLite 文件。
    if (this.transactionDepth === 0) {
      this.refreshFromDiskIfChanged();
    }

    if (beginsTransaction) {
      this.transactionDepth += 1;
    }

    try {
      const result = this.database.run(sql, params);

      if (!beginsTransaction && !endsTransaction) {
        this.hasUnpersistedChanges = true;
      }

      if (endsTransaction) {
        this.transactionDepth = Math.max(0, this.transactionDepth - 1);

        if (command === "ROLLBACK" && this.transactionDepth === 0) {
          this.hasUnpersistedChanges = false;
        }
      }

      return result;
    } catch (error) {
      if (beginsTransaction) {
        this.transactionDepth = Math.max(0, this.transactionDepth - 1);
      }

      throw error;
    }
  }

  private refreshFromDiskIfChanged() {
    if (this.transactionDepth > 0 || !existsSync(this.databasePath)) {
      return;
    }

    const { mtimeMs } = statSync(this.databasePath);

    if (mtimeMs === this.lastLoadedMtimeMs) {
      return;
    }

    // 检测到别的进程已经持久化了新快照，就重新加载数据库。
    // 注意这不是高并发数据库方案，只是本地 demo/单机 worker 下的轻量同步。
    const data = readFileSync(this.databasePath);
    this.database.close();
    this.database = new this.SQL.Database(data) as SqlDatabase;
    this.lastLoadedMtimeMs = mtimeMs;
    this.hasUnpersistedChanges = false;
  }

  private persist() {
    writeFileSync(this.databasePath, this.database.export());
    this.lastLoadedMtimeMs = statSync(this.databasePath).mtimeMs;
    this.hasUnpersistedChanges = false;
  }

  private queryOne(sql: string, params?: SqlParams): SqlRow | undefined {
    return this.queryMany(sql, params)[0];
  }

  private queryMany(sql: string, params?: SqlParams): SqlRow[] {
    this.refreshFromDiskIfChanged();
    const [result] = this.database.exec(sql, params);

    if (!result) {
      return [];
    }

    return result.values.map((values) =>
      Object.fromEntries(result.columns.map((column, index) => [column, values[index] ?? null]))
    );
  }

  private getSqlCommand(sql: string): string {
    return sql.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? "";
  }

  private deleteExpiredEventBatch(nowIso: string, limit: number): { messageEvents: number; runEvents: number; total: number } {
    const expiredMessageEvents = this.queryMany(
      `SELECT id, run_id
       FROM agent_events
       WHERE expires_at <= ?
         AND run_id IS NULL
       ORDER BY expires_at ASC, created_at ASC, seq ASC, id ASC
       LIMIT ?`,
      [nowIso, limit]
    );
    const expiredRunEvents = this.queryMany(
      `SELECT id, run_id
       FROM agent_events
       WHERE expires_at <= ?
         AND run_id IS NOT NULL
       ORDER BY expires_at ASC, created_at ASC, seq ASC, id ASC
       LIMIT ?`,
      [nowIso, limit]
    );
    const expiredEvents = [...expiredMessageEvents, ...expiredRunEvents];

    if (expiredEvents.length === 0) {
      return { messageEvents: 0, runEvents: 0, total: 0 };
    }

    const ids = expiredEvents.map((row) => requiredString(row.id, "id"));
    const placeholders = ids.map(() => "?").join(", ");

    this.run(
      `DELETE FROM agent_events
       WHERE id IN (${placeholders})`,
      ids
    );

    const runEvents = expiredEvents.filter((row) => optionalString(row.run_id)).length;

    return {
      messageEvents: expiredMessageEvents.length,
      runEvents,
      total: expiredEvents.length
    };
  }

  private hasExpiredEvents(nowIso: string): boolean {
    const row = this.queryOne(
      `SELECT id
       FROM agent_events
       WHERE expires_at <= ?
       LIMIT 1`,
      [nowIso]
    );

    return Boolean(row);
  }

  private toSessionRecord(row: SqlRow): AgentSessionRecord {
    return {
      id: requiredString(row.id, "id"),
      title: optionalString(row.title),
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at")
    };
  }

  private toSessionSummaryRecord(row: SqlRow): AgentSessionSummaryRecord {
    const summary = parseJson<AgentSessionSummaryRecord["summary"]>(row.summary_json);

    if (!summary) {
      throw new Error("SQLite 会话摘要 summary_json 为空");
    }

    return {
      id: requiredString(row.id, "id"),
      sessionId: requiredString(row.session_id, "session_id"),
      version: optionalNumber(row.version) ?? 1,
      summary,
      coveredMessageId: requiredString(row.covered_message_id, "covered_message_id"),
      coveredMessageCreatedAt: requiredString(row.covered_message_created_at, "covered_message_created_at"),
      sourceSummaryId: optionalString(row.source_summary_id),
      schemaVersion: optionalNumber(row.schema_version) ?? 1,
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at")
    };
  }

  private toMessageRecord(row: SqlRow): AgentMessageRecord {
    return {
      id: requiredString(row.id, "id"),
      sessionId: requiredString(row.session_id, "session_id"),
      role: requiredString(row.role, "role") as AgentMessageRole,
      status: requiredString(row.status, "status") as AgentMessageStatus,
      parts: parseJson<MessagePart[]>(row.parts_json) ?? [],
      maxIterations: optionalNumber(row.max_iterations),
      error: parseJson<AgentMessageRecord["error"]>(row.error_json),
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at"),
      completedAt: optionalString(row.completed_at)
    };
  }

  private toRunRecord(row: SqlRow): AgentRunRecord {
    return {
      id: requiredString(row.id, "id"),
      sessionId: requiredString(row.session_id, "session_id"),
      status: requiredString(row.status, "status") as AgentRunStatus,
      phase: requiredString(row.phase, "phase") as AgentRunPhase,
      userMessageId: requiredString(row.user_message_id, "user_message_id"),
      systemMessageId: optionalString(row.system_message_id),
      assistantMessageId: optionalString(row.assistant_message_id),
      error: parseJson<AgentRunRecord["error"]>(row.error_json),
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at"),
      completedAt: optionalString(row.completed_at)
    };
  }

  private toToolCallRecord(row: SqlRow): AgentToolCallRecord {
    return {
      id: requiredString(row.id, "id"),
      sessionId: requiredString(row.session_id, "session_id"),
      runId: optionalString(row.run_id),
      messageId: requiredString(row.message_id, "message_id"),
      iteration: optionalNumber(row.iteration) ?? 0,
      toolCallId: optionalString(row.tool_call_id),
      toolName: requiredString(row.tool_name, "tool_name"),
      status: requiredString(row.status, "status") as AgentToolCallRecord["status"],
      arguments: parseJson<AgentToolCallRecord["arguments"]>(row.arguments_json) ?? {},
      resultSummary: parseJson<AgentToolCallRecord["resultSummary"]>(row.result_summary_json),
      error: parseJson<AgentToolCallRecord["error"]>(row.error_json),
      startedAt: requiredString(row.started_at, "started_at"),
      completedAt: optionalString(row.completed_at),
      durationMs: optionalNumber(row.duration_ms)
    };
  }

  private toResourceRecord(row: SqlRow): AgentResourceRecord {
    return {
      id: requiredString(row.id, "id"),
      sessionId: requiredString(row.session_id, "session_id"),
      messageId: requiredString(row.message_id, "message_id"),
      toolCallRowId: optionalString(row.tool_call_row_id),
      toolCallId: optionalString(row.tool_call_id),
      type: requiredString(row.type, "type"),
      mime: optionalString(row.mime),
      url: optionalString(row.url),
      name: optionalString(row.name),
      status: requiredString(row.status, "status") as AgentResourceRecord["status"],
      width: optionalNumber(row.width),
      height: optionalNumber(row.height),
      metadata: parseJson<AgentResourceRecord["metadata"]>(row.metadata_json),
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at")
    };
  }

  private toProcessStepRecord(row: SqlRow): AgentProcessStepRecord {
    return {
      id: requiredString(row.id, "id"),
      sessionId: requiredString(row.session_id, "session_id"),
      runId: optionalString(row.run_id),
      messageId: requiredString(row.message_id, "message_id"),
      toolCallRowId: optionalString(row.tool_call_row_id),
      toolCallId: optionalString(row.tool_call_id),
      kind: requiredString(row.kind, "kind") as AgentProcessStepRecord["kind"],
      title: requiredString(row.title, "title"),
      summary: optionalString(row.summary),
      status: requiredString(row.status, "status") as AgentProcessStepRecord["status"],
      orderIndex: optionalNumber(row.order_index) ?? 0,
      metadata: parseJson<AgentProcessStepRecord["metadata"]>(row.metadata_json),
      startedAt: requiredString(row.started_at, "started_at"),
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
      messageId: optionalString(row.message_id),
      runId: optionalString(row.run_id),
      event,
      createdAt: requiredString(row.created_at, "created_at")
    };
  }
}

function assertValidMessageTransition(from: AgentMessageStatus, to: AgentMessageStatus) {
  if (from === to || from === "running") {
    return;
  }

  throw new Error(`非法 message 状态流转：${from} -> ${to}`);
}

function assertValidRunTransition(from: AgentRunStatus, to: AgentRunStatus) {
  if (from === to || from === "running") {
    return;
  }

  throw new Error(`非法 run 状态流转：${from} -> ${to}`);
}

function assertRunPhaseMatchesStatus(status: AgentRunStatus, phase: AgentRunPhase) {
  if (status === "running" && (phase === "compressing" || phase === "answering")) {
    return;
  }

  if (status !== "running" && phase === status) {
    return;
  }

  throw new Error(`run 终态 phase 不一致：status=${status}, phase=${phase}`);
}
