import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  CreateAgentMessageInput,
  CreateAgentRunInput,
  StoredAgentEvent,
  UpdateAgentMessageInput,
  UpdateAgentRunInput,
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

interface SqliteAgentStoreOptions {
  databasePath: string;
}

type SqlRow = Record<string, SqlValue>;

interface MessageCursor {
  sessionId: string;
  createdAt: string;
  rowid: number;
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function normalizeLimit(limit: number): number {
  return Math.max(0, Math.floor(limit));
}

const contextMessageFilter = "(role = 'user' OR (role = 'assistant' AND status IN ('completed', 'failed')))";

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
  private readonly runSubscribers = new Map<string, Set<AgentEventListener>>();

  private constructor(
    private readonly databasePath: string,
    private readonly database: SqlDatabase
  ) {}

  static async create(options: SqliteAgentStoreOptions): Promise<SqliteAgentStore> {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    const SQL = await initSqlJs();
    const data = existsSync(options.databasePath) ? readFileSync(options.databasePath) : undefined;
    const database = new SQL.Database(data) as SqlDatabase;
    const store = new SqliteAgentStore(options.databasePath, database);

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

  getSessionSummary(sessionId: string): AgentSessionSummaryRecord | undefined {
    const row = this.queryOne(
      `SELECT
         session_id,
         summary_json,
         covered_message_id,
         schema_version,
         created_at,
         updated_at
       FROM agent_session_summaries
       WHERE session_id = ?`,
      [sessionId]
    );

    return row ? this.toSessionSummaryRecord(row) : undefined;
  }

  upsertSessionSummary(input: UpsertAgentSessionSummaryInput): AgentSessionSummaryRecord {
    const timestamp = now();
    const existingSummary = this.getSessionSummary(input.sessionId);

    if (existingSummary) {
      this.database.run(
        `UPDATE agent_session_summaries
         SET summary_json = ?,
             covered_message_id = ?,
             schema_version = ?,
             updated_at = ?
         WHERE session_id = ?`,
        [
          JSON.stringify(input.summary),
          input.coveredMessageId,
          input.schemaVersion ?? existingSummary.schemaVersion,
          timestamp,
          input.sessionId
        ]
      );
    } else {
      this.database.run(
        `INSERT INTO agent_session_summaries (
           session_id,
           summary_json,
           covered_message_id,
           schema_version,
           created_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.sessionId,
          JSON.stringify(input.summary),
          input.coveredMessageId,
          input.schemaVersion ?? 1,
          timestamp,
          timestamp
        ]
      );
    }

    this.touchSession(input.sessionId, timestamp);
    this.persist();
    const storedSummary = this.getSessionSummary(input.sessionId);

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

    this.database.run(
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
    const systemMessageId = input.systemMessageId ?? existingRun.systemMessageId;
    const assistantMessageId = input.assistantMessageId ?? existingRun.assistantMessageId;
    const error = input.error;
    const completedAt = input.completedAt ?? existingRun.completedAt;

    this.database.run(
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

    this.database.run(
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
    const parts = input.parts ?? existingMessage.parts;
    const error = input.error;
    const completedAt = input.completedAt ?? existingMessage.completedAt;

    this.database.run(
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

  appendEvent(messageId: string, event: AgentStreamEvent): StoredAgentEvent | undefined {
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

  appendRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): StoredAgentEvent | undefined {
    return this.appendStoredRunEvent(runId, event, messageId);
  }

  getRunEvents(runId: string, after = 0): StoredAgentEvent[] {
    return this.queryMany(
      `SELECT id, seq, run_id, message_id, payload_json, created_at
       FROM agent_run_events
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
    this.persist();
    this.database.close();
  }

  private initializeSchema() {
    this.resetLegacySchemaIfNeeded();
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
        parts_json TEXT NOT NULL DEFAULT '[]',
        max_iterations INTEGER,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
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

      CREATE TABLE IF NOT EXISTS agent_run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        message_id TEXT,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, seq)
      );

      CREATE TABLE IF NOT EXISTS agent_session_summaries (
        session_id TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL,
        covered_message_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_messages_session_id_created_at
        ON agent_messages (session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_agent_events_message_id_seq
        ON agent_events (message_id, seq);

      CREATE INDEX IF NOT EXISTS idx_agent_runs_session_id_created_at
        ON agent_runs (session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_id_seq
        ON agent_run_events (run_id, seq);
    `);
  }

  private resetLegacySchemaIfNeeded() {
    const columns = this.database.exec(`PRAGMA table_info(agent_messages)`)[0]?.values ?? [];
    const hasLegacyMessageColumns = columns.some((row) => row[1] === "content" || row[1] === "steps_json");
    const hasLegacyAssetsTable = this.queryMany(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = 'agent_assets'`
    ).length > 0;

    if (hasLegacyMessageColumns || hasLegacyAssetsTable) {
      this.database.run(`
        DROP TABLE IF EXISTS agent_run_events;
        DROP TABLE IF EXISTS agent_runs;
        DROP TABLE IF EXISTS agent_events;
        DROP TABLE IF EXISTS agent_messages;
        DROP TABLE IF EXISTS agent_assets;
        DROP TABLE IF EXISTS agent_sessions;
      `);
    }
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

  private appendStoredRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): StoredAgentEvent {
    const eventId = createId("event");
    const eventSeq = this.nextRunEventSeq(runId);
    const timestamp = now();
    const storedEvent: StoredAgentEvent = {
      id: eventId,
      seq: eventSeq,
      runId,
      messageId,
      event,
      createdAt: timestamp
    };

    this.database.run(
      `INSERT INTO agent_run_events (id, run_id, message_id, seq, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [eventId, runId, messageId ?? null, eventSeq, event.type, JSON.stringify(event), timestamp]
    );
    this.persist();
    this.publishRun(storedEvent);
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

  private nextRunEventSeq(runId: string): number {
    const row = this.queryOne(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
       FROM agent_run_events
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

  private toSessionSummaryRecord(row: SqlRow): AgentSessionSummaryRecord {
    const summary = parseJson<AgentSessionSummaryRecord["summary"]>(row.summary_json);

    if (!summary) {
      throw new Error("SQLite 会话摘要 summary_json 为空");
    }

    return {
      sessionId: requiredString(row.session_id, "session_id"),
      summary,
      coveredMessageId: requiredString(row.covered_message_id, "covered_message_id"),
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
