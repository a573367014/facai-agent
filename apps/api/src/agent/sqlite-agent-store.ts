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
  AgentToolCallRecord,
  CreateAgentMessageInput,
  CreateAgentResourceInput,
  CreateAgentToolCallInput,
  CreateAgentRunInput,
  AgentResourceRecord,
  PruneExpiredAgentEventsInput,
  PruneAgentEventsResult,
  StoredAgentEvent,
  UpdateAgentMessageInput,
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

function isTerminalToolCallStatus(status: AgentToolCallRecord["status"]) {
  return status === "succeeded" || status === "failed";
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
  private readonly runSubscribers = new Map<string, Set<AgentEventListener>>();
  private readonly eventRetentionDays: number;

  private constructor(
    private readonly databasePath: string,
    private readonly database: SqlDatabase,
    options: { eventRetentionDays: number }
  ) {
    this.eventRetentionDays = options.eventRetentionDays;
  }

  static async create(options: SqliteAgentStoreOptions): Promise<SqliteAgentStore> {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    const SQL = await initSqlJs();
    const data = existsSync(options.databasePath) ? readFileSync(options.databasePath) : undefined;
    const database = new SQL.Database(data) as SqlDatabase;
    const store = new SqliteAgentStore(options.databasePath, database, {
      eventRetentionDays: normalizePositiveInteger(options.eventRetentionDays ?? 3)
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

    if (!coveredMessage || coveredMessage.sessionId !== input.sessionId) {
      throw new Error(`SQLite 会话摘要覆盖消息无效：${input.coveredMessageId}`);
    }

    const summaryId = `summary_${randomUUID()}`;
    const version = (previousSummary?.version ?? 0) + 1;

    this.database.run(
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
    assertValidRunTransition(existingRun.status, status);
    assertRunPhaseMatchesStatus(status, phase);
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
    assertValidMessageTransition(existingMessage.status, status);
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

  pruneExpiredEvents(input: PruneExpiredAgentEventsInput): PruneAgentEventsResult {
    const batchSize = normalizePositiveInteger(input.batchSize);
    const maxBatches = normalizePositiveInteger(input.maxBatches);
    let messageEvents = 0;
    let runEvents = 0;
    let batches = 0;

    while (batches < maxBatches) {
      const deletedMessageEvents = this.deleteExpiredEventBatch("agent_events", input.nowIso, batchSize);
      const deletedRunEvents = this.deleteExpiredEventBatch("agent_run_events", input.nowIso, batchSize);

      if (deletedMessageEvents === 0 && deletedRunEvents === 0) {
        break;
      }

      messageEvents += deletedMessageEvents;
      runEvents += deletedRunEvents;
      batches += 1;

      if (deletedMessageEvents < batchSize && deletedRunEvents < batchSize) {
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

    this.database.run(
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

    this.database.run(
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

    this.database.run(
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

    this.database.run(
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

  appendEvent(messageId: string, event: AgentStreamEvent): StoredAgentEvent | undefined {
    return this.appendStoredEvent(messageId, event);
  }

  publishTransientEvent(messageId: string, event: AgentStreamEvent): StoredAgentEvent | undefined {
    const storedEvent = this.createTransientStoredEvent(event, { messageId });
    this.publish(storedEvent);
    return storedEvent;
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

  publishTransientRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): StoredAgentEvent | undefined {
    const storedEvent = this.createTransientStoredEvent(event, { runId, messageId });
    this.publishRun(storedEvent);
    return storedEvent;
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
        expires_at TEXT NOT NULL,
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
        expires_at TEXT NOT NULL,
        UNIQUE (run_id, seq)
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

      CREATE INDEX IF NOT EXISTS idx_agent_messages_session_id_created_at
        ON agent_messages (session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_agent_events_message_id_seq
        ON agent_events (message_id, seq);

      CREATE INDEX IF NOT EXISTS idx_agent_runs_session_id_created_at
        ON agent_runs (session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_id_seq
        ON agent_run_events (run_id, seq);

      CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_session_id_started_at
        ON agent_tool_calls (session_id, started_at);

      CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_message_id_tool_call_id
        ON agent_tool_calls (message_id, tool_call_id);

      CREATE INDEX IF NOT EXISTS idx_agent_resources_message_id_created_at
        ON agent_resources (message_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_agent_resources_session_id_created_at
        ON agent_resources (session_id, created_at);
    `);
    this.ensureSessionSummaryVersionSchema();
    this.ensureEventExpirationColumns();
  }

  private ensureSessionSummaryVersionSchema() {
    const columns = this.database.exec("PRAGMA table_info(agent_session_summaries)")[0]?.values ?? [];
    const hasVersionSchema = columns.some((row) => row[1] === "id") && columns.some((row) => row[1] === "version");

    if (hasVersionSchema) {
      this.database.run(`
        CREATE INDEX IF NOT EXISTS idx_agent_session_summaries_session_version
          ON agent_session_summaries (session_id, version);
      `);
      return;
    }

    const legacyRows = this.queryMany(
      `SELECT
         session_id,
         summary_json,
         covered_message_id,
         schema_version,
         created_at,
         updated_at
       FROM agent_session_summaries`
    );

    this.database.run(`
      ALTER TABLE agent_session_summaries RENAME TO agent_session_summaries_legacy;

      CREATE TABLE agent_session_summaries (
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
    `);

    for (const row of legacyRows) {
      const sessionId = requiredString(row.session_id, "session_id");
      const coveredMessageId = requiredString(row.covered_message_id, "covered_message_id");
      const coveredMessage = this.getMessage(coveredMessageId);
      const createdAt = requiredString(row.created_at, "created_at");

      this.database.run(
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
          `summary_${randomUUID()}`,
          sessionId,
          1,
          requiredString(row.summary_json, "summary_json"),
          coveredMessageId,
          coveredMessage?.createdAt ?? createdAt,
          null,
          optionalNumber(row.schema_version) ?? 1,
          createdAt,
          requiredString(row.updated_at, "updated_at")
        ]
      );
    }

    this.database.run(`
      DROP TABLE agent_session_summaries_legacy;

      CREATE INDEX IF NOT EXISTS idx_agent_session_summaries_session_version
        ON agent_session_summaries (session_id, version);
    `);
  }

  private ensureEventExpirationColumns() {
    this.ensureColumn("agent_events", "expires_at", "TEXT");
    this.ensureColumn("agent_run_events", "expires_at", "TEXT");
    this.backfillEventExpiration("agent_events");
    this.backfillEventExpiration("agent_run_events");
    this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_agent_events_expires_at
        ON agent_events (expires_at);

      CREATE INDEX IF NOT EXISTS idx_agent_run_events_expires_at
        ON agent_run_events (expires_at);
    `);
  }

  private ensureColumn(tableName: "agent_events" | "agent_run_events", columnName: string, definition: string) {
    const columns = this.database.exec(`PRAGMA table_info(${tableName})`)[0]?.values ?? [];
    const hasColumn = columns.some((row) => row[1] === columnName);

    if (!hasColumn) {
      this.database.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }

  private backfillEventExpiration(tableName: "agent_events" | "agent_run_events") {
    this.database.run(
      `UPDATE ${tableName}
       SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, ?)
       WHERE expires_at IS NULL OR expires_at = ''`,
      [`+${this.eventRetentionDays} days`]
    );
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
        DROP TABLE IF EXISTS agent_resources;
        DROP TABLE IF EXISTS agent_tool_calls;
        DROP TABLE IF EXISTS agent_run_events;
        DROP TABLE IF EXISTS agent_runs;
        DROP TABLE IF EXISTS agent_events;
        DROP TABLE IF EXISTS agent_messages;
        DROP TABLE IF EXISTS agent_assets;
        DROP TABLE IF EXISTS agent_sessions;
      `);
    }
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

  private appendStoredEvent(messageId: string, event: AgentStreamEvent): StoredAgentEvent {
    const eventId = createId("event");
    const eventSeq = this.nextEventSeq(messageId);
    const timestamp = now();
    const expiresAt = addDaysIso(timestamp, this.eventRetentionDays);
    const storedEvent: StoredAgentEvent = {
      id: eventId,
      seq: eventSeq,
      messageId,
      event,
      createdAt: timestamp
    };

    this.database.run(
      `INSERT INTO agent_events (id, message_id, seq, type, payload_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [eventId, messageId, eventSeq, event.type, JSON.stringify(event), timestamp, expiresAt]
    );
    this.persist();
    this.publish(storedEvent);
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

  private appendStoredRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): StoredAgentEvent {
    const eventId = createId("event");
    const eventSeq = this.nextRunEventSeq(runId);
    const timestamp = now();
    const expiresAt = addDaysIso(timestamp, this.eventRetentionDays);
    const storedEvent: StoredAgentEvent = {
      id: eventId,
      seq: eventSeq,
      runId,
      messageId,
      event,
      createdAt: timestamp
    };

    this.database.run(
      `INSERT INTO agent_run_events (id, run_id, message_id, seq, type, payload_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [eventId, runId, messageId ?? null, eventSeq, event.type, JSON.stringify(event), timestamp, expiresAt]
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

  private deleteExpiredEventBatch(tableName: "agent_events" | "agent_run_events", nowIso: string, limit: number): number {
    const row = this.queryOne(
      `SELECT COUNT(*) AS row_count
       FROM (
         SELECT id
         FROM ${tableName}
         WHERE expires_at <= ?
         ORDER BY expires_at ASC, created_at ASC, seq ASC, id ASC
         LIMIT ?
       ) expired_events`,
      [nowIso, limit]
    );
    const rowCount = optionalNumber(row?.row_count) ?? 0;

    if (rowCount === 0) {
      return 0;
    }

    this.database.run(
      `DELETE FROM ${tableName}
       WHERE id IN (
         SELECT id
         FROM (
           SELECT id
           FROM ${tableName}
           WHERE expires_at <= ?
           ORDER BY expires_at ASC, created_at ASC, seq ASC, id ASC
           LIMIT ?
         ) expired_events
       )`,
      [nowIso, limit]
    );
    return rowCount;
  }

  private hasExpiredEvents(nowIso: string): boolean {
    return (
      this.hasExpiredEventsInTable("agent_events", nowIso) ||
      this.hasExpiredEventsInTable("agent_run_events", nowIso)
    );
  }

  private hasExpiredEventsInTable(tableName: "agent_events" | "agent_run_events", nowIso: string): boolean {
    const row = this.queryOne(
      `SELECT id
       FROM ${tableName}
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
