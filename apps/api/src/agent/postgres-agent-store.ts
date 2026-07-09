import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { AgentStreamEvent } from "./types.js";
import type { MessagePart } from "./message-parts.js";
import type {
  CreateKnowledgeChunkInput,
  CreateKnowledgeDocumentInput,
  KnowledgeChunkSearchResult,
  KnowledgeDocumentRecord,
  SearchKnowledgeChunksInput,
  UpdateKnowledgeDocumentInput
} from "../knowledge/types.js";
import type {
  AgentEventListener,
  AgentMessageRecord,
  AgentMessageRole,
  AgentMessageStatus,
  AgentRunPhase,
  AgentRunRecord,
  AgentRunStatus,
  AgentSessionRecord,
  AgentSessionSummary,
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
  StoredAgentEvent,
  UpdateAgentMessageInput,
  UpdateAgentProcessStepInput,
  UpdateAgentResourceInput,
  UpdateAgentRunInput,
  UpdateAgentToolCallInput,
  UpsertAgentSessionSummaryInput
} from "./agent-store.js";

type SqlValue = string | number | boolean | null;

interface PostgresAgentStoreOptions {
  connectionString: string;
  vectorDimension?: number;
}

interface MessageCursor {
  sessionId: string;
  createdAt: string;
  seq: number;
}

interface SessionCursor {
  updatedAt: string;
  seq: number;
}

const contextMessageFilter = "(role = 'user' OR (role = 'assistant' AND status IN ('completed', 'failed')))";
const defaultSessionUserId = "user_system";

function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function normalizeLimit(limit: number): number {
  return Math.max(0, Math.floor(limit));
}

function isTerminalToolCallStatus(status: AgentToolCallRecord["status"]) {
  return status === "succeeded" || status === "failed";
}

function isTerminalProcessStepStatus(status: AgentProcessStepRecord["status"]) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Postgres 字段 ${field} 不是字符串`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

function readJson<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value.length === 0 ? undefined : (JSON.parse(value) as T);
  }

  return value as T;
}

function numberPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${(index += 1)}`);
}

function formatVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function parseVector(value: unknown): number[] {
  if (typeof value !== "string") {
    return [];
  }

  const inner = value.replace(/^\[/, "").replace(/\]$/, "").trim();

  if (inner === "") {
    return [];
  }

  return inner.split(",").map((part) => Number(part));
}

export class PostgresAgentStore implements AgentStore {
  // 这个 store 把“长期事实”落在 Postgres：会话、消息、run、工具调用、资源和进度。
  // Redis 仍然只负责运行时协调；实时事件只通知当前 run 的在线订阅者，不落库。
  private readonly runSubscribers = new Map<string, Set<AgentEventListener>>();

  private constructor(
    private readonly pool: Pool,
    private readonly vectorDimension: number
  ) {}

  static async create(options: PostgresAgentStoreOptions): Promise<PostgresAgentStore> {
    const pool = new pg.Pool({ connectionString: options.connectionString });
    const vectorDimension = options.vectorDimension ?? 1024;
    const store = new PostgresAgentStore(pool, vectorDimension);

    await store.initializeSchema(options.vectorDimension);
    return store;
  }

  async createSession(title?: string, userId = defaultSessionUserId): Promise<AgentSessionRecord> {
    const timestamp = now();
    const session: AgentSessionRecord = {
      id: createId("session"),
      userId,
      title,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await this.execute(
      `INSERT INTO agent_sessions (id, user_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [session.id, userId, title ?? null, timestamp, timestamp]
    );
    return session;
  }

  async getSession(sessionId: string, userId?: string): Promise<AgentSessionRecord | undefined> {
    const params: SqlValue[] = [sessionId];

    if (userId) {
      params.push(userId);
    }

    const row = await this.queryOne(
      `SELECT id, user_id, title, created_at, updated_at
       FROM agent_sessions
       WHERE id = ?${userId ? " AND user_id = ?" : ""}`,
      params
    );

    return row ? this.toSessionRecord(row) : undefined;
  }

  async listSessions(options: ListAgentSessionsOptions = {}): Promise<AgentSessionRecord[]> {
    const cursor = options.after ? await this.getSessionCursor(options.after, options.userId) : undefined;
    const normalizedLimit = options.limit === undefined ? undefined : normalizeLimit(options.limit);
    const params: SqlValue[] = [];
    const whereClauses: string[] = [];

    if (options.after && !cursor) {
      return [];
    }

    if (options.userId) {
      whereClauses.push("user_id = ?");
      params.push(options.userId);
    }

    if (cursor) {
      whereClauses.push("(updated_at < ? OR (updated_at = ? AND seq < ?))");
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.seq);
    }

    if (normalizedLimit !== undefined) {
      if (normalizedLimit === 0) {
        return [];
      }

      params.push(normalizedLimit);
    }

    const rows = await this.queryMany(
      `SELECT id, user_id, title, created_at, updated_at
       FROM agent_sessions
       ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : ""}
       ORDER BY updated_at DESC, seq DESC
       ${normalizedLimit !== undefined ? "LIMIT ?" : ""}`,
      params
    );

    return rows.map((row) => this.toSessionRecord(row));
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);

    if (!session) {
      return false;
    }

    const runIdRows = await this.queryMany<{ id: string }>(`SELECT id FROM agent_runs WHERE session_id = ?`, [
      sessionId
    ]);
    const runIds = runIdRows.map((row) => row.id);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await PostgresAgentStore.exec(client, `DELETE FROM agent_resources WHERE session_id = ?`, [sessionId]);
      await PostgresAgentStore.exec(client, `DELETE FROM agent_tool_calls WHERE session_id = ?`, [sessionId]);
      await PostgresAgentStore.exec(client, `DELETE FROM agent_process_steps WHERE session_id = ?`, [sessionId]);
      await PostgresAgentStore.exec(client, `DELETE FROM agent_session_summaries WHERE session_id = ?`, [sessionId]);
      await PostgresAgentStore.exec(client, `DELETE FROM agent_runs WHERE session_id = ?`, [sessionId]);
      await PostgresAgentStore.exec(client, `DELETE FROM agent_messages WHERE session_id = ?`, [sessionId]);
      await PostgresAgentStore.exec(client, `DELETE FROM agent_sessions WHERE id = ?`, [sessionId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    for (const runId of runIds) {
      this.runSubscribers.delete(runId);
    }

    return true;
  }

  async getSessionSummary(sessionId: string): Promise<AgentSessionSummaryRecord | undefined> {
    const row = await this.queryOne(
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

  async getSessionSummaryBeforeMessage(
    sessionId: string,
    messageId: string
  ): Promise<AgentSessionSummaryRecord | undefined> {
    const targetMessage = await this.getMessage(messageId);

    if (!targetMessage || targetMessage.sessionId !== sessionId) {
      return undefined;
    }

    const orderedMessages = await this.getMessagesBySession(sessionId);
    const messageOrder = new Map(orderedMessages.map((message, index) => [message.id, index]));
    const targetIndex = messageOrder.get(messageId);

    if (targetIndex === undefined) {
      return undefined;
    }

    const summaries = await this.listSessionSummaries(sessionId);

    return summaries
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

  async listSessionSummaries(sessionId: string): Promise<AgentSessionSummaryRecord[]> {
    const rows = await this.queryMany(
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
    );

    return rows.map((row) => this.toSessionSummaryRecord(row));
  }

  async upsertSessionSummary(input: UpsertAgentSessionSummaryInput): Promise<AgentSessionSummaryRecord> {
    const timestamp = now();
    const previousSummary = await this.getSessionSummary(input.sessionId);
    const coveredMessage = await this.getMessage(input.coveredMessageId);

    if (!coveredMessage || coveredMessage.sessionId !== input.sessionId) {
      throw new Error(`Postgres 会话摘要覆盖消息无效：${input.coveredMessageId}`);
    }

    const summaryId = `summary_${randomUUID()}`;
    const version = (previousSummary?.version ?? 0) + 1;

    await this.execute(
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

    await this.touchSession(input.sessionId, timestamp);

    const storedSummary = (await this.listSessionSummaries(input.sessionId)).find(
      (summary) => summary.id === summaryId
    );

    if (!storedSummary) {
      throw new Error("Postgres 会话摘要写入失败");
    }

    return storedSummary;
  }

  async createRun(input: CreateAgentRunInput): Promise<AgentRunRecord> {
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

    await this.execute(
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
    await this.touchSession(run.sessionId, timestamp);
    return run;
  }

  async updateRun(runId: string, input: UpdateAgentRunInput): Promise<AgentRunRecord | undefined> {
    const timestamp = now();
    const client = await this.pool.connect();
    let sessionId: string | undefined;

    try {
      await client.query("BEGIN");
      const selectResult = await client.query(
        numberPlaceholders(
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
           WHERE id = ?
           FOR UPDATE`
        ),
        [runId]
      );

      if (selectResult.rows.length === 0) {
        await client.query("COMMIT");
        return undefined;
      }

      const existingRun = this.toRunRecord(selectResult.rows[0]);
      sessionId = existingRun.sessionId;

      const status = input.status ?? existingRun.status;
      const phase = input.phase ?? existingRun.phase;
      assertValidRunTransition(existingRun.status, status);
      assertRunPhaseMatchesStatus(status, phase);
      const systemMessageId = input.systemMessageId ?? existingRun.systemMessageId;
      const assistantMessageId = input.assistantMessageId ?? existingRun.assistantMessageId;
      const error = input.error;
      const completedAt = input.completedAt ?? existingRun.completedAt;

      await PostgresAgentStore.exec(
        client,
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
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    if (sessionId) {
      await this.touchSession(sessionId, timestamp);
    }
    return this.getRun(runId);
  }

  async getRun(runId: string): Promise<AgentRunRecord | undefined> {
    const row = await this.queryOne(
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

  async getRunsByMessageId(messageId: string): Promise<AgentRunRecord[]> {
    const rows = await this.queryMany(
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
       ORDER BY created_at ASC, seq ASC`,
      [messageId, messageId, messageId]
    );

    return rows.map((row) => this.toRunRecord(row));
  }

  async createMessage(input: CreateAgentMessageInput): Promise<AgentMessageRecord> {
    const timestamp = input.createdAt ?? now();
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

    await this.execute(
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
    await this.touchSession(message.sessionId, timestamp);
    return message;
  }

  async updateMessage(messageId: string, input: UpdateAgentMessageInput): Promise<AgentMessageRecord | undefined> {
    const existingMessage = await this.getMessage(messageId);

    if (!existingMessage) {
      return undefined;
    }

    const timestamp = now();
    const status = input.status ?? existingMessage.status;
    assertValidMessageTransition(existingMessage.status, status);
    const parts = input.parts ?? existingMessage.parts;
    const error = input.error;
    const completedAt = input.completedAt ?? existingMessage.completedAt;

    await this.execute(
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
    await this.touchSession(existingMessage.sessionId, timestamp);
    return this.getMessage(messageId);
  }

  async updateMessageParts(messageId: string, parts: MessagePart[]): Promise<AgentMessageRecord | undefined> {
    return this.updateMessage(messageId, { parts });
  }

  async getMessage(messageId: string): Promise<AgentMessageRecord | undefined> {
    const row = await this.queryOne(
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

  async getMessagesBySession(sessionId: string): Promise<AgentMessageRecord[]> {
    const rows = await this.queryMany(
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
       ORDER BY created_at ASC, seq ASC`,
      [sessionId]
    );

    return rows.map((row) => this.toMessageRecord(row));
  }

  async getRecentMessagesBySession(sessionId: string, limit: number): Promise<AgentMessageRecord[]> {
    const normalizedLimit = normalizeLimit(limit);

    if (normalizedLimit === 0) {
      return [];
    }

    const rows = await this.queryMany(
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
         SELECT *
         FROM agent_messages
         WHERE session_id = ?
         ORDER BY created_at DESC, seq DESC
         LIMIT ?
       ) AS recent
       ORDER BY created_at ASC, seq ASC`,
      [sessionId, normalizedLimit]
    );

    return rows.map((row) => this.toMessageRecord(row));
  }

  async getRecentContextMessagesBySession(sessionId: string, limit: number): Promise<AgentMessageRecord[]> {
    const normalizedLimit = normalizeLimit(limit);

    if (normalizedLimit === 0) {
      return [];
    }

    const rows = await this.queryMany(
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
         SELECT *
         FROM agent_messages
         WHERE session_id = ?
           AND role IN ('user', 'assistant')
         ORDER BY created_at DESC, seq DESC
         LIMIT ?
       ) AS recent
       ORDER BY created_at ASC, seq ASC`,
      [sessionId, normalizedLimit]
    );

    return rows.map((row) => this.toMessageRecord(row));
  }

  async getMessagesBefore(sessionId: string, beforeMessageId: string, limit: number): Promise<AgentMessageRecord[]> {
    const normalizedLimit = normalizeLimit(limit);
    const cursor = await this.getMessageCursor(beforeMessageId);

    if (normalizedLimit === 0 || !cursor || cursor.sessionId !== sessionId) {
      return [];
    }

    const rows = await this.queryMany(
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
         SELECT *
         FROM agent_messages
         WHERE session_id = ?
           AND (created_at < ? OR (created_at = ? AND seq < ?))
         ORDER BY created_at DESC, seq DESC
         LIMIT ?
       ) AS recent
       ORDER BY created_at ASC, seq ASC`,
      [sessionId, cursor.createdAt, cursor.createdAt, cursor.seq, normalizedLimit]
    );

    return rows.map((row) => this.toMessageRecord(row));
  }

  async getMessagesAfter(
    sessionId: string,
    afterMessageId: string | undefined,
    limit?: number
  ): Promise<AgentMessageRecord[]> {
    const cursor = afterMessageId ? await this.getMessageCursor(afterMessageId) : undefined;
    const hasCursor = Boolean(cursor && cursor.sessionId === sessionId);
    const normalizedLimit = limit === undefined ? undefined : normalizeLimit(limit);

    if (normalizedLimit === 0) {
      return [];
    }

    const limitClause = normalizedLimit === undefined ? "" : "LIMIT ?";
    const params: SqlValue[] = hasCursor
      ? [sessionId, cursor?.createdAt ?? "", cursor?.createdAt ?? "", cursor?.seq ?? 0]
      : [sessionId];

    if (normalizedLimit !== undefined) {
      params.push(normalizedLimit);
    }

    const rows = await this.queryMany(
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
         ${hasCursor ? "AND (created_at > ? OR (created_at = ? AND seq > ?))" : ""}
       ORDER BY created_at ASC, seq ASC
       ${limitClause}`,
      params
    );

    return rows.map((row) => this.toMessageRecord(row));
  }

  async getRecentMessagesAfter(
    sessionId: string,
    afterMessageId: string | undefined,
    limit: number
  ): Promise<AgentMessageRecord[]> {
    const normalizedLimit = normalizeLimit(limit);
    const cursor = afterMessageId ? await this.getMessageCursor(afterMessageId) : undefined;
    const hasCursor = Boolean(cursor && cursor.sessionId === sessionId);
    const params: SqlValue[] = hasCursor
      ? [sessionId, cursor?.createdAt ?? "", cursor?.createdAt ?? "", cursor?.seq ?? 0, normalizedLimit]
      : [sessionId, normalizedLimit];

    if (normalizedLimit === 0) {
      return [];
    }

    const rows = await this.queryMany(
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
         SELECT *
         FROM agent_messages
         WHERE session_id = ?
           ${hasCursor ? "AND (created_at > ? OR (created_at = ? AND seq > ?))" : ""}
         ORDER BY created_at DESC, seq DESC
         LIMIT ?
       ) AS recent
       ORDER BY created_at ASC, seq ASC`,
      params
    );

    return rows.map((row) => this.toMessageRecord(row));
  }

  async countMessagesAfter(sessionId: string, afterMessageId?: string): Promise<number> {
    const cursor = afterMessageId ? await this.getMessageCursor(afterMessageId) : undefined;
    const hasCursor = Boolean(cursor && cursor.sessionId === sessionId);
    const row = await this.queryOne(
      `SELECT COUNT(*) AS message_count
       FROM agent_messages
       WHERE session_id = ?
         ${hasCursor ? "AND (created_at > ? OR (created_at = ? AND seq > ?))" : ""}`,
      hasCursor ? [sessionId, cursor?.createdAt ?? "", cursor?.createdAt ?? "", cursor?.seq ?? 0] : [sessionId]
    );

    return optionalNumber(row?.message_count) ?? 0;
  }

  async getContextMessagesAfter(
    sessionId: string,
    afterMessageId: string | undefined,
    limit?: number
  ): Promise<AgentMessageRecord[]> {
    const cursor = afterMessageId ? await this.getMessageCursor(afterMessageId) : undefined;
    const hasCursor = Boolean(cursor && cursor.sessionId === sessionId);
    const normalizedLimit = limit === undefined ? undefined : normalizeLimit(limit);

    if (normalizedLimit === 0) {
      return [];
    }

    const limitClause = normalizedLimit === undefined ? "" : "LIMIT ?";
    const params: SqlValue[] = hasCursor
      ? [sessionId, cursor?.createdAt ?? "", cursor?.createdAt ?? "", cursor?.seq ?? 0]
      : [sessionId];

    if (normalizedLimit !== undefined) {
      params.push(normalizedLimit);
    }

    const rows = await this.queryMany(
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
         ${hasCursor ? "AND (created_at > ? OR (created_at = ? AND seq > ?))" : ""}
       ORDER BY created_at ASC, seq ASC
       ${limitClause}`,
      params
    );

    return rows.map((row) => this.toMessageRecord(row));
  }

  async getRecentContextMessagesAfter(
    sessionId: string,
    afterMessageId: string | undefined,
    limit: number
  ): Promise<AgentMessageRecord[]> {
    const normalizedLimit = normalizeLimit(limit);
    const cursor = afterMessageId ? await this.getMessageCursor(afterMessageId) : undefined;
    const hasCursor = Boolean(cursor && cursor.sessionId === sessionId);
    const params: SqlValue[] = hasCursor
      ? [sessionId, cursor?.createdAt ?? "", cursor?.createdAt ?? "", cursor?.seq ?? 0, normalizedLimit]
      : [sessionId, normalizedLimit];

    if (normalizedLimit === 0) {
      return [];
    }

    const rows = await this.queryMany(
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
         SELECT *
         FROM agent_messages
         WHERE session_id = ?
           AND role IN ('user', 'assistant')
           ${hasCursor ? "AND (created_at > ? OR (created_at = ? AND seq > ?))" : ""}
         ORDER BY created_at DESC, seq DESC
         LIMIT ?
       ) AS recent
       ORDER BY created_at ASC, seq ASC`,
      params
    );

    return rows.map((row) => this.toMessageRecord(row));
  }

  async countContextMessagesAfter(sessionId: string, afterMessageId?: string): Promise<number> {
    const cursor = afterMessageId ? await this.getMessageCursor(afterMessageId) : undefined;
    const hasCursor = Boolean(cursor && cursor.sessionId === sessionId);
    const row = await this.queryOne(
      `SELECT COUNT(*) AS message_count
       FROM agent_messages
       WHERE session_id = ?
         AND ${contextMessageFilter}
         ${hasCursor ? "AND (created_at > ? OR (created_at = ? AND seq > ?))" : ""}`,
      hasCursor ? [sessionId, cursor?.createdAt ?? "", cursor?.createdAt ?? "", cursor?.seq ?? 0] : [sessionId]
    );

    return optionalNumber(row?.message_count) ?? 0;
  }

  async getContextMessagesBefore(
    sessionId: string,
    beforeMessageId: string,
    afterMessageId: string | undefined,
    limit?: number
  ): Promise<AgentMessageRecord[]> {
    const beforeCursor = await this.getMessageCursor(beforeMessageId);
    const afterCursor = afterMessageId ? await this.getMessageCursor(afterMessageId) : undefined;
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
      beforeCursor.seq
    ];

    if (hasAfterCursor) {
      params.push(afterCursor?.createdAt ?? "", afterCursor?.createdAt ?? "", afterCursor?.seq ?? 0);
    }

    if (normalizedLimit !== undefined) {
      params.push(normalizedLimit);
    }

    const rows = await this.queryMany(
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
         AND (created_at < ? OR (created_at = ? AND seq < ?))
         ${hasAfterCursor ? "AND (created_at > ? OR (created_at = ? AND seq > ?))" : ""}
       ORDER BY created_at ASC, seq ASC
       ${limitClause}`,
      params
    );

    return rows.map((row) => this.toMessageRecord(row));
  }

  async getRecentContextMessagesBefore(
    sessionId: string,
    beforeMessageId: string,
    afterMessageId: string | undefined,
    limit: number
  ): Promise<AgentMessageRecord[]> {
    const beforeCursor = await this.getMessageCursor(beforeMessageId);
    const afterCursor = afterMessageId ? await this.getMessageCursor(afterMessageId) : undefined;
    const hasAfterCursor = Boolean(afterCursor && afterCursor.sessionId === sessionId);
    const normalizedLimit = normalizeLimit(limit);

    if (normalizedLimit === 0 || !beforeCursor || beforeCursor.sessionId !== sessionId) {
      return [];
    }

    const params: SqlValue[] = [
      sessionId,
      beforeCursor.createdAt,
      beforeCursor.createdAt,
      beforeCursor.seq
    ];

    if (hasAfterCursor) {
      params.push(afterCursor?.createdAt ?? "", afterCursor?.createdAt ?? "", afterCursor?.seq ?? 0);
    }

    params.push(normalizedLimit);

    const rows = await this.queryMany(
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
         SELECT *
         FROM agent_messages
         WHERE session_id = ?
           AND role IN ('user', 'assistant')
           AND (created_at < ? OR (created_at = ? AND seq < ?))
           ${hasAfterCursor ? "AND (created_at > ? OR (created_at = ? AND seq > ?))" : ""}
         ORDER BY created_at DESC, seq DESC
         LIMIT ?
       ) AS recent
       ORDER BY created_at ASC, seq ASC`,
      params
    );

    return rows.map((row) => this.toMessageRecord(row));
  }

  async countContextMessagesBefore(
    sessionId: string,
    beforeMessageId: string,
    afterMessageId?: string
  ): Promise<number> {
    const beforeCursor = await this.getMessageCursor(beforeMessageId);
    const afterCursor = afterMessageId ? await this.getMessageCursor(afterMessageId) : undefined;
    const hasAfterCursor = Boolean(afterCursor && afterCursor.sessionId === sessionId);

    if (!beforeCursor || beforeCursor.sessionId !== sessionId) {
      return 0;
    }

    const params: SqlValue[] = [
      sessionId,
      beforeCursor.createdAt,
      beforeCursor.createdAt,
      beforeCursor.seq
    ];

    if (hasAfterCursor) {
      params.push(afterCursor?.createdAt ?? "", afterCursor?.createdAt ?? "", afterCursor?.seq ?? 0);
    }

    const row = await this.queryOne(
      `SELECT COUNT(*) AS message_count
       FROM agent_messages
       WHERE session_id = ?
         AND ${contextMessageFilter}
         AND (created_at < ? OR (created_at = ? AND seq < ?))
         ${hasAfterCursor ? "AND (created_at > ? OR (created_at = ? AND seq > ?))" : ""}`,
      params
    );

    return optionalNumber(row?.message_count) ?? 0;
  }

  async createToolCall(input: CreateAgentToolCallInput): Promise<AgentToolCallRecord> {
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

    await this.execute(
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
    await this.touchSession(toolCall.sessionId, timestamp);
    return toolCall;
  }

  async updateToolCall(
    toolCallRowId: string,
    input: UpdateAgentToolCallInput
  ): Promise<AgentToolCallRecord | undefined> {
    const existingToolCall = await this.getToolCall(toolCallRowId);

    if (!existingToolCall) {
      return undefined;
    }

    const timestamp = now();
    const status = input.status ?? existingToolCall.status;
    const completedAt =
      input.completedAt ??
      (isTerminalToolCallStatus(status) ? existingToolCall.completedAt ?? timestamp : existingToolCall.completedAt);

    await this.execute(
      `UPDATE agent_tool_calls
       SET status = ?,
           result_summary_json = ?,
           error_json = ?,
           completed_at = ?,
           duration_ms = ?
       WHERE id = ?`,
      [
        status,
        input.resultSummary !== undefined
          ? JSON.stringify(input.resultSummary)
          : existingToolCall.resultSummary
            ? JSON.stringify(existingToolCall.resultSummary)
            : null,
        input.error !== undefined
          ? JSON.stringify(input.error)
          : existingToolCall.error
            ? JSON.stringify(existingToolCall.error)
            : null,
        completedAt ?? null,
        input.durationMs ?? existingToolCall.durationMs ?? null,
        toolCallRowId
      ]
    );
    await this.touchSession(existingToolCall.sessionId, timestamp);
    return this.getToolCall(toolCallRowId);
  }

  async getToolCallByMessageToolCall(
    messageId: string,
    toolCallId: string
  ): Promise<AgentToolCallRecord | undefined> {
    const row = await this.queryOne(
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
       ORDER BY started_at DESC, seq DESC
       LIMIT 1`,
      [messageId, toolCallId]
    );

    return row ? this.toToolCallRecord(row) : undefined;
  }

  async getToolCallsBySession(sessionId: string): Promise<AgentToolCallRecord[]> {
    const rows = await this.queryMany(
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
       ORDER BY started_at ASC, seq ASC`,
      [sessionId]
    );

    return rows.map((row) => this.toToolCallRecord(row));
  }

  async createResource(input: CreateAgentResourceInput): Promise<AgentResourceRecord> {
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

    await this.execute(
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
    await this.touchSession(resource.sessionId, timestamp);
    return resource;
  }

  async updateResource(
    resourceId: string,
    input: UpdateAgentResourceInput
  ): Promise<AgentResourceRecord | undefined> {
    const existingResource = await this.getResource(resourceId);

    if (!existingResource) {
      return undefined;
    }

    const timestamp = now();

    await this.execute(
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
        input.metadata !== undefined
          ? JSON.stringify(input.metadata)
          : existingResource.metadata
            ? JSON.stringify(existingResource.metadata)
            : null,
        timestamp,
        resourceId
      ]
    );
    await this.touchSession(existingResource.sessionId, timestamp);
    return this.getResource(resourceId);
  }

  async getResourcesByMessages(messageIds: string[]): Promise<AgentResourceRecord[]> {
    if (messageIds.length === 0) {
      return [];
    }

    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = await this.queryMany(
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
       ORDER BY created_at ASC, seq ASC`,
      messageIds
    );

    return rows.map((row) => this.toResourceRecord(row));
  }

  async createProcessStep(input: CreateAgentProcessStepInput): Promise<AgentProcessStepRecord> {
    const timestamp = now();
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

    await this.execute(
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
        processStep.title ?? null,
        processStep.summary ?? null,
        processStep.status,
        processStep.orderIndex,
        processStep.metadata ? JSON.stringify(processStep.metadata) : null,
        processStep.startedAt,
        processStep.updatedAt,
        processStep.completedAt ?? null
      ]
    );
    await this.touchSession(processStep.sessionId, timestamp);
    return processStep;
  }

  async updateProcessStep(
    stepId: string,
    input: UpdateAgentProcessStepInput
  ): Promise<AgentProcessStepRecord | undefined> {
    const existingStep = await this.getProcessStep(stepId);

    if (!existingStep) {
      return undefined;
    }

    const timestamp = now();
    const status = input.status ?? existingStep.status;
    const completedAt =
      input.completedAt ??
      (isTerminalProcessStepStatus(status) ? existingStep.completedAt ?? timestamp : existingStep.completedAt);

    await this.execute(
      `UPDATE agent_process_steps
       SET title = ?,
           summary = ?,
           status = ?,
           metadata_json = ?,
           updated_at = ?,
           completed_at = ?
       WHERE id = ?`,
      [
        input.title ?? existingStep.title ?? null,
        input.summary !== undefined ? input.summary : existingStep.summary ?? null,
        status,
        input.metadata !== undefined
          ? JSON.stringify(input.metadata)
          : existingStep.metadata
            ? JSON.stringify(existingStep.metadata)
            : null,
        timestamp,
        completedAt ?? null,
        stepId
      ]
    );
    await this.touchSession(existingStep.sessionId, timestamp);
    return this.getProcessStep(stepId);
  }

  async getProcessStepsByMessages(messageIds: string[]): Promise<AgentProcessStepRecord[]> {
    if (messageIds.length === 0) {
      return [];
    }

    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = await this.queryMany(
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
       ORDER BY started_at ASC, seq ASC`,
      messageIds
    );

    return rows.map((row) => this.toProcessStepRecord(row));
  }

  async createKnowledgeDocument(input: CreateKnowledgeDocumentInput): Promise<KnowledgeDocumentRecord> {
    const timestamp = now();
    const document: KnowledgeDocumentRecord = {
      id: createId("doc"),
      name: input.name,
      sourcePath: input.sourcePath,
      mimeType: input.mimeType,
      status: input.status ?? "pending",
      contentHash: input.contentHash,
      chunkCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await this.execute(
      `INSERT INTO knowledge_documents (id, name, source_path, mime_type, status, error_message, content_hash, chunk_count, created_at, updated_at, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        document.id,
        document.name,
        document.sourcePath,
        document.mimeType,
        document.status,
        null,
        document.contentHash,
        0,
        timestamp,
        timestamp,
        null
      ]
    );
    return document;
  }

  async updateKnowledgeDocument(
    documentId: string,
    input: UpdateKnowledgeDocumentInput
  ): Promise<KnowledgeDocumentRecord | undefined> {
    const existingDocument = await this.getKnowledgeDocument(documentId);

    if (!existingDocument) {
      return undefined;
    }

    const timestamp = now();

    await this.execute(
      `UPDATE knowledge_documents
       SET status = ?,
           error_message = ?,
           chunk_count = ?,
           indexed_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        input.status ?? existingDocument.status,
        input.errorMessage !== undefined ? input.errorMessage : existingDocument.errorMessage ?? null,
        input.chunkCount ?? existingDocument.chunkCount,
        input.indexedAt ?? existingDocument.indexedAt ?? null,
        timestamp,
        documentId
      ]
    );
    return this.getKnowledgeDocument(documentId);
  }

  async getKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentRecord | undefined> {
    const row = await this.queryOne(
      `SELECT id, name, source_path, mime_type, status, error_message, content_hash, chunk_count, created_at, updated_at, indexed_at
       FROM knowledge_documents
       WHERE id = ?`,
      [documentId]
    );

    return row ? this.toKnowledgeDocumentRecord(row) : undefined;
  }

  async listKnowledgeDocuments(): Promise<KnowledgeDocumentRecord[]> {
    const rows = await this.queryMany(
      `SELECT id, name, source_path, mime_type, status, error_message, content_hash, chunk_count, created_at, updated_at, indexed_at
       FROM knowledge_documents
       ORDER BY updated_at DESC, seq DESC`
    );

    return rows.map((row) => this.toKnowledgeDocumentRecord(row));
  }

  async deleteKnowledgeDocument(documentId: string): Promise<boolean> {
    const document = await this.getKnowledgeDocument(documentId);

    if (!document) {
      return false;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await PostgresAgentStore.exec(client, `DELETE FROM knowledge_chunks WHERE document_id = ?`, [documentId]);
      await PostgresAgentStore.exec(client, `DELETE FROM knowledge_documents WHERE id = ?`, [documentId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return true;
  }

  async replaceKnowledgeChunks(documentId: string, chunks: CreateKnowledgeChunkInput[]): Promise<void> {
    const timestamp = now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await PostgresAgentStore.exec(client, `DELETE FROM knowledge_chunks WHERE document_id = ?`, [documentId]);

      for (const chunk of chunks) {
        await PostgresAgentStore.exec(
          client,
          `INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, source_label, embedding_model, embedding, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            createId("chunk"),
            documentId,
            chunk.chunkIndex,
            chunk.content,
            chunk.sourceLabel,
            chunk.embeddingModel,
            formatVector(chunk.embedding),
            chunk.metadata ? JSON.stringify(chunk.metadata) : null,
            timestamp
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async searchKnowledgeChunks(input: SearchKnowledgeChunksInput): Promise<KnowledgeChunkSearchResult[]> {
    const normalizedLimit = normalizeLimit(input.limit ?? 10);

    if (normalizedLimit === 0) {
      return [];
    }

    const queryVector = formatVector(input.queryEmbedding);

    const rows = await this.queryMany(
      `SELECT
         chunks.id,
         chunks.document_id,
         documents.name AS document_name,
         chunks.chunk_index,
         chunks.content,
         chunks.source_label,
         chunks.embedding_model,
         chunks.embedding,
         chunks.metadata_json,
         chunks.created_at,
         1 - (chunks.embedding <=> ?) AS score
       FROM knowledge_chunks chunks
       INNER JOIN knowledge_documents documents ON documents.id = chunks.document_id
       WHERE documents.status = 'ready'
       ORDER BY chunks.embedding <=> ?, chunks.chunk_index ASC
       LIMIT ?`,
      [queryVector, queryVector, normalizedLimit]
    );

    return rows.map((row) => this.toKnowledgeChunkSearchResult(row));
  }

  async appendRunEvent(
    runId: string,
    event: AgentStreamEvent,
    messageId?: string
  ): Promise<StoredAgentEvent | undefined> {
    return this.publishTransientRunEvent(runId, event, messageId);
  }

  async publishTransientRunEvent(
    runId: string,
    event: AgentStreamEvent,
    messageId?: string
  ): Promise<StoredAgentEvent | undefined> {
    const storedEvent: StoredAgentEvent = {
      id: `evt_${randomUUID()}`,
      runId,
      messageId,
      event,
      createdAt: now()
    };

    this.runSubscribers.get(runId)?.forEach((listener) => {
      listener(storedEvent);
    });

    return storedEvent;
  }

  subscribeRun(runId: string, listener: AgentEventListener): () => void {
    let subscribers = this.runSubscribers.get(runId);

    if (!subscribers) {
      subscribers = new Set();
      this.runSubscribers.set(runId, subscribers);
    }

    subscribers.add(listener);

    return () => {
      const currentSubscribers = this.runSubscribers.get(runId);

      if (!currentSubscribers) {
        return;
      }

      currentSubscribers.delete(listener);

      if (currentSubscribers.size === 0) {
        this.runSubscribers.delete(runId);
      }
    };
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("TRUNCATE TABLE agent_resources, agent_tool_calls, agent_process_steps, agent_session_summaries, agent_runs, agent_messages, agent_sessions, knowledge_chunks, knowledge_documents RESTART IDENTITY CASCADE");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async queryMany<T extends QueryResultRow>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(numberPlaceholders(sql), params);
    return result.rows;
  }

  private async queryOne<T extends QueryResultRow>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    const rows = await this.queryMany<T>(sql, params);
    return rows[0];
  }

  private async execute(sql: string, params: SqlValue[] = []): Promise<void> {
    await this.pool.query(numberPlaceholders(sql), params);
  }

  private static async exec(client: PoolClient, sql: string, params: SqlValue[] = []): Promise<void> {
    await client.query(numberPlaceholders(sql), params);
  }

  private async touchSession(sessionId: string, timestamp: string): Promise<void> {
    await this.execute(`UPDATE agent_sessions SET updated_at = ? WHERE id = ?`, [timestamp, sessionId]);
  }

  private async getMessageCursor(messageId: string): Promise<MessageCursor | undefined> {
    const row = await this.queryOne<{ session_id: string; created_at: string; seq: number }>(
      `SELECT session_id, created_at, seq FROM agent_messages WHERE id = ?`,
      [messageId]
    );

    if (!row) {
      return undefined;
    }

    return {
      sessionId: requiredString(row.session_id, "session_id"),
      createdAt: requiredString(row.created_at, "created_at"),
      seq: optionalNumber(row.seq) ?? 0
    };
  }

  private async getSessionCursor(sessionId: string, userId?: string): Promise<SessionCursor | undefined> {
    const params: SqlValue[] = [sessionId];

    if (userId) {
      params.push(userId);
    }

    const row = await this.queryOne<{ updated_at: string; seq: number }>(
      `SELECT updated_at, seq FROM agent_sessions WHERE id = ?${userId ? " AND user_id = ?" : ""}`,
      params
    );

    if (!row) {
      return undefined;
    }

    return {
      updatedAt: requiredString(row.updated_at, "updated_at"),
      seq: optionalNumber(row.seq) ?? 0
    };
  }

  private async getToolCall(toolCallRowId: string): Promise<AgentToolCallRecord | undefined> {
    const row = await this.queryOne(
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

  private async getResource(resourceId: string): Promise<AgentResourceRecord | undefined> {
    const row = await this.queryOne(
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

  private async getProcessStep(stepId: string): Promise<AgentProcessStepRecord | undefined> {
    const row = await this.queryOne(
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

  private toSessionRecord(row: QueryResultRow): AgentSessionRecord {
    return {
      id: requiredString(row.id, "id"),
      userId: requiredString(row.user_id, "user_id"),
      title: optionalString(row.title),
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at")
    };
  }

  private toMessageRecord(row: QueryResultRow): AgentMessageRecord {
    return {
      id: requiredString(row.id, "id"),
      sessionId: requiredString(row.session_id, "session_id"),
      role: requiredString(row.role, "role") as AgentMessageRole,
      status: requiredString(row.status, "status") as AgentMessageStatus,
      parts: readJson<MessagePart[]>(row.parts_json) ?? [],
      maxIterations: optionalNumber(row.max_iterations),
      error: readJson(row.error_json),
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at"),
      completedAt: optionalString(row.completed_at)
    };
  }

  private toRunRecord(row: QueryResultRow): AgentRunRecord {
    return {
      id: requiredString(row.id, "id"),
      sessionId: requiredString(row.session_id, "session_id"),
      status: requiredString(row.status, "status") as AgentRunStatus,
      phase: requiredString(row.phase, "phase") as AgentRunPhase,
      userMessageId: requiredString(row.user_message_id, "user_message_id"),
      systemMessageId: optionalString(row.system_message_id),
      assistantMessageId: optionalString(row.assistant_message_id),
      error: readJson(row.error_json),
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at"),
      completedAt: optionalString(row.completed_at)
    };
  }

  private toSessionSummaryRecord(row: QueryResultRow): AgentSessionSummaryRecord {
    return {
      id: requiredString(row.id, "id"),
      sessionId: requiredString(row.session_id, "session_id"),
      version: optionalNumber(row.version) ?? 1,
      summary: readJson<AgentSessionSummary>(row.summary_json) as AgentSessionSummary,
      coveredMessageId: requiredString(row.covered_message_id, "covered_message_id"),
      coveredMessageCreatedAt: requiredString(row.covered_message_created_at, "covered_message_created_at"),
      sourceSummaryId: optionalString(row.source_summary_id),
      schemaVersion: optionalNumber(row.schema_version) ?? 1,
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at")
    };
  }

  private toToolCallRecord(row: QueryResultRow): AgentToolCallRecord {
    return {
      id: requiredString(row.id, "id"),
      sessionId: requiredString(row.session_id, "session_id"),
      runId: optionalString(row.run_id),
      messageId: requiredString(row.message_id, "message_id"),
      iteration: optionalNumber(row.iteration) ?? 0,
      toolCallId: optionalString(row.tool_call_id),
      toolName: requiredString(row.tool_name, "tool_name"),
      status: requiredString(row.status, "status") as AgentToolCallRecord["status"],
      arguments: readJson(row.arguments_json) ?? {},
      resultSummary: readJson(row.result_summary_json),
      error: readJson(row.error_json),
      startedAt: requiredString(row.started_at, "started_at"),
      completedAt: optionalString(row.completed_at),
      durationMs: optionalNumber(row.duration_ms)
    };
  }

  private toResourceRecord(row: QueryResultRow): AgentResourceRecord {
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
      metadata: readJson(row.metadata_json),
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at")
    };
  }

  private toProcessStepRecord(row: QueryResultRow): AgentProcessStepRecord {
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
      metadata: readJson(row.metadata_json),
      startedAt: requiredString(row.started_at, "started_at"),
      updatedAt: requiredString(row.updated_at, "updated_at"),
      completedAt: optionalString(row.completed_at)
    };
  }

  private toKnowledgeDocumentRecord(row: QueryResultRow): KnowledgeDocumentRecord {
    return {
      id: requiredString(row.id, "id"),
      name: requiredString(row.name, "name"),
      sourcePath: requiredString(row.source_path, "source_path"),
      mimeType: requiredString(row.mime_type, "mime_type"),
      status: requiredString(row.status, "status") as KnowledgeDocumentRecord["status"],
      errorMessage: optionalString(row.error_message),
      contentHash: requiredString(row.content_hash, "content_hash"),
      chunkCount: optionalNumber(row.chunk_count) ?? 0,
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at"),
      indexedAt: optionalString(row.indexed_at)
    };
  }

  private toKnowledgeChunkSearchResult(row: QueryResultRow): KnowledgeChunkSearchResult {
    return {
      id: requiredString(row.id, "id"),
      documentId: requiredString(row.document_id, "document_id"),
      documentName: requiredString(row.document_name, "document_name"),
      chunkIndex: optionalNumber(row.chunk_index) ?? 0,
      content: requiredString(row.content, "content"),
      sourceLabel: requiredString(row.source_label, "source_label"),
      embeddingModel: requiredString(row.embedding_model, "embedding_model"),
      embedding: parseVector(row.embedding),
      metadata: readJson(row.metadata_json),
      createdAt: requiredString(row.created_at, "created_at"),
      score: optionalNumber(row.score) ?? 0
    };
  }

  private async initializeSchema(vectorDimension?: number): Promise<void> {
    await this.execute(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.execute(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await this.execute(
      `CREATE TABLE IF NOT EXISTS agent_sessions (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL DEFAULT '${defaultSessionUserId}',
         title TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         seq SERIAL
       )`
    );

    await this.execute(
      `CREATE TABLE IF NOT EXISTS agent_messages (
         id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         role TEXT NOT NULL,
         status TEXT NOT NULL,
         parts_json JSONB NOT NULL DEFAULT '[]',
         max_iterations INTEGER,
         error_json JSONB,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         completed_at TEXT,
         seq SERIAL
       )`
    );

    await this.execute(
      `CREATE TABLE IF NOT EXISTS agent_runs (
         id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         status TEXT NOT NULL,
         phase TEXT NOT NULL,
         user_message_id TEXT,
         system_message_id TEXT,
         assistant_message_id TEXT,
         error_json JSONB,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         completed_at TEXT,
         seq SERIAL
       )`
    );

    await this.execute(
      `CREATE TABLE IF NOT EXISTS agent_session_summaries (
         id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         version INTEGER NOT NULL,
         summary_json JSONB NOT NULL,
         covered_message_id TEXT NOT NULL,
         covered_message_created_at TEXT NOT NULL,
         source_summary_id TEXT,
         schema_version INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         seq SERIAL
       )`
    );

    await this.execute(
      `CREATE TABLE IF NOT EXISTS agent_tool_calls (
         id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         run_id TEXT,
         message_id TEXT NOT NULL,
         iteration INTEGER NOT NULL,
         tool_call_id TEXT,
         tool_name TEXT NOT NULL,
         status TEXT NOT NULL,
         arguments_json JSONB NOT NULL DEFAULT '{}',
         result_summary_json JSONB,
         error_json JSONB,
         started_at TEXT NOT NULL,
         completed_at TEXT,
         duration_ms INTEGER,
         seq SERIAL
       )`
    );

    await this.execute(
      `CREATE TABLE IF NOT EXISTS agent_resources (
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
         metadata_json JSONB,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         seq SERIAL
       )`
    );

    await this.execute(
      `CREATE TABLE IF NOT EXISTS agent_process_steps (
         id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         run_id TEXT,
         message_id TEXT NOT NULL,
         tool_call_row_id TEXT,
         tool_call_id TEXT,
         kind TEXT NOT NULL,
         title TEXT,
         summary TEXT,
         status TEXT NOT NULL,
         order_index INTEGER NOT NULL,
         metadata_json JSONB,
         started_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         completed_at TEXT,
         seq SERIAL
       )`
    );

    await this.execute(
      `CREATE TABLE IF NOT EXISTS knowledge_documents (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         source_path TEXT NOT NULL,
         mime_type TEXT NOT NULL,
         status TEXT NOT NULL,
         error_message TEXT,
         content_hash TEXT NOT NULL,
         chunk_count INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         indexed_at TEXT,
         seq SERIAL
       )`
    );

    const effectiveDimension = vectorDimension ?? 1024;

    await this.execute(
      `CREATE TABLE IF NOT EXISTS knowledge_chunks (
         id TEXT PRIMARY KEY,
         document_id TEXT NOT NULL,
         chunk_index INTEGER NOT NULL,
         content TEXT NOT NULL,
         source_label TEXT NOT NULL,
         embedding_model TEXT NOT NULL,
         embedding vector(${effectiveDimension}),
         metadata_json JSONB,
         created_at TEXT NOT NULL,
         seq SERIAL
       )`
    );

    if (vectorDimension !== undefined) {
      await this.migrateVectorDimension(vectorDimension);
    }

    await this.ensureAgentSessionUserScope();
    await this.createIndexes();
  }

  private async ensureAgentSessionUserScope(): Promise<void> {
    const row = await this.queryOne<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_name = 'agent_sessions'
           AND column_name = 'user_id'
       ) AS exists`
    );

    if (row?.exists) {
      return;
    }

    await this.execute(
      `TRUNCATE TABLE agent_resources,
                      agent_tool_calls,
                      agent_process_steps,
                      agent_session_summaries,
                      agent_runs,
                      agent_messages,
                      agent_sessions
       RESTART IDENTITY CASCADE`
    );
    await this.execute(`ALTER TABLE agent_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT '${defaultSessionUserId}'`);
  }

  private async migrateVectorDimension(vectorDimension: number): Promise<void> {
    const row = await this.queryOne<{ dimension: number }>(
      `SELECT atttypmod AS dimension
       FROM pg_attribute
       WHERE attrelid = 'knowledge_chunks'::regclass
         AND attname = 'embedding'`
    );

    if (!row || row.dimension === vectorDimension) {
      return;
    }

    await this.execute(`DROP INDEX IF EXISTS idx_knowledge_chunks_embedding_hnsw`);
    await this.execute(
      `ALTER TABLE knowledge_chunks ALTER COLUMN embedding TYPE vector(${vectorDimension})`
    );
  }

  private async createIndexes(): Promise<void> {
    await this.execute(
      `CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_updated_at
       ON agent_sessions (user_id, updated_at, seq)`
    );
    await this.execute(
      `CREATE INDEX IF NOT EXISTS idx_agent_messages_session_id_created_at
       ON agent_messages (session_id, created_at)`
    );
    await this.execute(
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_session_id_created_at
       ON agent_runs (session_id, created_at)`
    );
    await this.execute(
      `CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_session_id_started_at
       ON agent_tool_calls (session_id, started_at)`
    );
    await this.execute(
      `CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_message_id_tool_call_id
       ON agent_tool_calls (message_id, tool_call_id)`
    );
    await this.execute(
      `CREATE INDEX IF NOT EXISTS idx_agent_resources_message_id_created_at
       ON agent_resources (message_id, created_at)`
    );
    await this.execute(
      `CREATE INDEX IF NOT EXISTS idx_agent_resources_session_id_created_at
       ON agent_resources (session_id, created_at)`
    );
    await this.execute(
      `CREATE INDEX IF NOT EXISTS idx_agent_process_steps_message_order
       ON agent_process_steps (message_id, order_index)`
    );
    await this.execute(
      `CREATE INDEX IF NOT EXISTS idx_knowledge_documents_status_updated_at
       ON knowledge_documents (status, updated_at)`
    );
    await this.execute(
      `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document_id_index
       ON knowledge_chunks (document_id, chunk_index)`
    );
    await this.execute(
      `CREATE INDEX IF NOT EXISTS idx_agent_session_summaries_session_version
       ON agent_session_summaries (session_id, version)`
    );
    await this.execute(
      `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_hnsw
       ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)`
    );
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
