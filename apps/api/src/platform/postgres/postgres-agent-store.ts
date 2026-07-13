/**
 * AgentStore 的 PostgreSQL 实现——整个系统的"长期记忆"持久层。
 *
 * 模块职责：把 Agent 运行过程中产生的所有"事实"（会话、消息、推理 run、工具调用、
 * 资源、进度步骤、知识库文档与向量）可靠地落库，并提供基于游标的稳定分页、
 * 状态机校验的更新、事务化的批量删除等能力。
 *
 * 与其他层的边界：
 * - 这里只负责"持久化"，不负责运行时编排（编排在上层 agent 模块）；
 * - 实时事件（subscribeRun/publishTransientRunEvent）只在本进程内存中转发给当前在线订阅者，
 *   不落库——历史事件回放靠重建（基于已落库的 message/tool_call/process_step），而非事件流存储。
 *
 * 关键设计决策（详见各函数注释）：
 * - SQL 统一用 ? 占位符再由 numberPlaceholders 转 $N，便于书写和跨方言维护；
 * - 排序一律用 (时间戳, seq) 复合排序，保证游标分页的稳定性；
 * - 所有写操作后调用 touchSession 刷新 updated_at，驱动会话列表的时间序。
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { AgentStreamEvent } from "../../modules/agent/types.js";
import type { MessagePart } from "../../modules/agent/message-parts.js";
import type {
  CreateKnowledgeChunkInput,
  CreateKnowledgeDocumentInput,
  KnowledgeChunkSearchResult,
  KnowledgeDocumentRecord,
  SearchKnowledgeChunksInput,
  UpdateKnowledgeDocumentInput
} from "../../modules/knowledge/types.js";
import type {
  AgentEventListener,
  AgentMessageRecord,
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
  StoredAgentEvent,
  UpdateAgentMessageInput,
  UpdateAgentProcessStepInput,
  UpdateAgentResourceInput,
  UpdateAgentRunInput,
  UpdateAgentToolCallInput,
  UpsertAgentSessionSummaryInput
} from "../../modules/agent/agent-store.js";
import { DEFAULT_SESSION_USER_ID } from "./constants.js";
import {
  mapAgentMessageRow,
  mapAgentProcessStepRow,
  mapAgentResourceRow,
  mapAgentRunRow,
  mapAgentSessionRow,
  mapAgentSessionSummaryRow,
  mapAgentToolCallRow,
  mapKnowledgeChunkSearchRow,
  mapKnowledgeDocumentRow,
  optionalNumber,
  requiredString
} from "./record-mappers.js";
import { assertPostgresSchemaReady } from "./schema-readiness.js";

/**
 * SQL 参数的合法值类型。pg 驱动只接受这些原始类型；复杂结构（对象/数组）
 * 在写入前已由调用方 JSON.stringify 或 formatVector 转成字符串。
 */
type SqlValue = string | number | boolean | null;

interface PostgresAgentStoreOptions {
  connectionString: string;
}

/**
 * 消息游标：用于消息列表的前向/后向分页。
 * 因为 created_at 可能重复（同一时刻多条消息），必须额外带 seq 作为 tie-breaker，
 * 否则分页边界会漏取或重复取数据。
 */
interface MessageCursor {
  sessionId: string;
  createdAt: string;
  seq: number;
}

/**
 * 会话游标：用于会话列表分页，原理同 MessageCursor，以 updated_at + seq 排序。
 */
interface SessionCursor {
  updatedAt: string;
  seq: number;
}

/**
 * "上下文消息"过滤条件：构建 LLM 上下文时只保留用户消息和已完成的助手消息。
 *
 * 为什么排除 running 状态的助手消息：未完成的消息可能内容不完整或正在流式生成，
 * 把它喂给模型会引入噪声甚至导致模型"模仿"半截输出。failed 的助手消息保留，
 * 是为了让模型能看到"上一次尝试失败了"的上下文。
 */
const contextMessageFilter = "(role = 'user' OR (role = 'assistant' AND status IN ('completed', 'failed')))";

/**
 * 生成带业务前缀的可读主键（如 session_xxx、msg_xxx）。
 * 前缀让人在排查日志/数据时一眼看出记录类型，比纯 UUID 更易定位问题。
 */
function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

/**
 * 当前 ISO 时间戳。所有时间列统一用 ISO 字符串存储而非 timestamp 类型，
 * 避免时区转换的不确定性，且便于跨数据库迁移。
 */
function now() {
  return new Date().toISOString();
}

/**
 * 规范化分页 limit：向下取整并保证非负。
 * 负数或小数统一收敛为 0，0 表示"不返回数据"（调用方据此短路）。
 */
function normalizeLimit(limit: number): number {
  return Math.max(0, Math.floor(limit));
}

/**
 * 判断工具调用状态是否为终态（成功/失败）。终态后不再允许回到 running。
 */
function isTerminalToolCallStatus(status: AgentToolCallRecord["status"]) {
  return status === "succeeded" || status === "failed";
}

/**
 * 判断进度步骤状态是否为终态（成功/失败/取消）。比工具调用多一个 cancelled。
 */
function isTerminalProcessStepStatus(status: AgentProcessStepRecord["status"]) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/**
 * 把 SQL 中的 ? 占位符按出现顺序转换为 pg 驱动要求的 $1/$2/... 形式。
 *
 * 为什么不直接写 $N：业务 SQL 数量多且字段顺序易变，手写 $N 极易数错导致参数错位
 * （这类 bug 难以排查）。统一用 ? 书写、由本函数自动编号，既减少出错，也让 SQL
 * 更接近通用语法、便于移植到其他方言。代价是一次正则替换的微小开销。
 */
function numberPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${(index += 1)}`);
}

/**
 * 把 number[] 格式化为 pgvector 接受的文本字面量 "[1,2,3]"。
 * pgvector 的写入侧只认这种字面量语法，无法直接传数组参数。
 */
function formatVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export class PostgresAgentStore implements AgentStore {
  // 这个 store 把“长期事实”落在 Postgres：会话、消息、run、工具调用、资源和进度。
  // Redis 仍然只负责运行时协调；实时事件只通知当前 run 的在线订阅者，不落库。
  /**
   * 运行时事件订阅表：runId -> 监听器集合。
   * 仅存活于当前进程内存，进程重启即丢失；历史回放靠重建而非此表。
   */
  private readonly runSubscribers = new Map<string, Set<AgentEventListener>>();

  private constructor(private readonly pool: Pool) {}

  /**
   * 工厂方法：创建连接池并返回 store 实例。
   *
   * 数据库结构由 node-pg-migrate 在进程启动前统一迁移，Store 不再执行 DDL。
   * 这样 API、Worker 和测试面对的是同一个有版本号的 schema，结构变更也不会
   * 随着 Store 实例化而在运行期悄悄发生。
   */
  static async create(options: PostgresAgentStoreOptions): Promise<PostgresAgentStore> {
    const pool = new pg.Pool({ connectionString: options.connectionString });
    try {
      await assertPostgresSchemaReady(pool, "agent_sessions");
      return new PostgresAgentStore(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async createSession(title?: string, userId = DEFAULT_SESSION_USER_ID): Promise<AgentSessionRecord> {
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

    return row ? mapAgentSessionRow(row) : undefined;
  }

  /**
   * 基于游标的会话列表分页（按 updated_at 倒序）。
   *
   * 为什么用游标而非 OFFSET：OFFSET 分页在数据频繁更新时会出现"数据漂移"——
   * 翻页过程中若有新会话写入，后续页会错位。游标分页以"上一页最后一条的排序键"为锚点，
   * 不受并发写入影响，且大偏移量下性能远优于 OFFSET（后者仍需扫描跳过的行）。
   *
   * 排序键是 (updated_at DESC, seq DESC)：updated_at 可能重复，seq 作为唯一 tie-breaker
   * 保证游标边界精确。游标条件 `(updated_at < ? OR (updated_at = ? AND seq < ?))`
   * 正是"严格小于锚点"的复合表达。
   *
   * 边界处理：after 指向的会话不存在（已被删除）时返回空，避免从错误位置开始分页。
   */
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

    return rows.map(mapAgentSessionRow);
  }

  /**
   * 删除会话及其全部关联数据（事务化）。
   *
   * 为什么用事务：会话关联了 6 张子表，若逐条删除中途失败，会留下"半删除"的孤儿数据
   * （如消息还在但会话没了），破坏引用完整性。事务保证"全删或全不删"。
   *
   * 删除顺序遵循外键/业务依赖：先删最底层（resources/tool_calls/process_steps/summaries），
   * 再删 runs、messages，最后删 sessions 主表。这里没有声明数据库级外键约束，
   * 所以顺序由代码保证正确性。
   *
   * BEGIN/COMMIT/ROLLBACK：try 中全部成功才 COMMIT；任意一步抛错则 ROLLBACK 回滚全部，
   * finally 中 release 归还连接（无论成功失败都必须释放，否则连接泄漏）。
   *
   * 删除后清理内存订阅表，避免对已删除 run 的事件投递。
   */
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

  /**
   * 取会话的最新摘要（版本最高）。
   * ORDER BY version DESC, created_at DESC 保证并发写入时取到最新版本。
   */
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

    return row ? mapAgentSessionSummaryRow(row) : undefined;
  }

  /**
   * 找到"覆盖范围严格在目标消息之前"的最新摘要——用于构建该消息处的上下文。
   *
   * 为什么用消息顺序而非时间戳比较：摘要的 coveredMessageId 标记它覆盖到的最后一条消息，
   * 判断"是否可用于某消息的上下文"必须基于消息的先后顺序。这里把会话消息拉到内存建立
   * id->index 的顺序索引，再过滤出 coveredIndex < targetIndex 的摘要，取覆盖范围最大的那个。
   *
   * 排序规则：先按覆盖范围倒序（覆盖越多越优先），再按 version 倒序（越新越优先）。
   * 这样取 [0] 即为"最合适的、覆盖最多历史"的摘要。
   */
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

    return rows.map(mapAgentSessionSummaryRow);
  }

  /**
   * 追加写一个会话摘要（实际是 insert 新版本，而非 update）。
   *
   * 为什么总是 insert 新行而非 update 旧行：摘要需要保留历史版本链（sourceSummaryId 指向上一个），
   * 以便回溯摘要的演化。version = 上一版 + 1，保证单调递增。
   *
   * 校验：coveredMessageId 必须存在且属于同一会话，否则摘要会指向无效消息。
   * 写入后 touchSession 刷新会话更新时间，再回查确认落库成功。
   */
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

  /**
   * 更新 run 状态（事务 + 行锁 + 状态机校验）。
   *
   * 为什么用 SELECT ... FOR UPDATE：run 的状态流转有严格约束（见 assertValidRunTransition），
   * 并发更新同一 run 时必须串行化——先拿到行锁的线程读到最新状态并校验，后续线程才能继续。
   * 若不加锁，两个并发请求可能同时读到 running 并都尝试转为 completed，绕过校验。
   *
   * 事务边界：BEGIN -> 读+锁 -> 校验 -> UPDATE -> COMMIT。校验失败抛错走 ROLLBACK。
   * 注意不存在时仍要 COMMIT（而非 ROLLBACK），因为这只是"无匹配"的正常分支，不是错误。
   */
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

      const existingRun = mapAgentRunRow(selectResult.rows[0]);
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

    return row ? mapAgentRunRow(row) : undefined;
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

    return rows.map(mapAgentRunRow);
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

    return row ? mapAgentMessageRow(row) : undefined;
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

    return rows.map(mapAgentMessageRow);
  }

  /**
   * 取会话最近 N 条消息，并按时间正序返回。
   *
   * 为什么用子查询"先倒序取 N 条再正序排"：业务需要"最近 N 条"但展示顺序是从旧到新。
   * 直接 ORDER BY ASC LIMIT N 取到的是"最早的 N 条"而非最近的。子查询先 DESC LIMIT
   * 截取最近的 N 条，外层再 ASC 还原自然顺序，一次查询完成。
   */
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

    return rows.map(mapAgentMessageRow);
  }

  /**
   * 取最近的"上下文消息"（仅 user/assistant），用于构建 LLM 上下文。
   * 与 getRecentMessagesBySession 同样的子查询手法，额外限定 role。
   */
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

    return rows.map(mapAgentMessageRow);
  }

  /**
   * 取某消息之前的 N 条消息（游标分页，向旧翻页）。
   * 游标条件 `(created_at < ? OR (created_at = ? AND seq < ?))` 表示严格早于锚点消息。
   */
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

    return rows.map(mapAgentMessageRow);
  }

  /**
   * 取某消息之后的消息（游标分页，向新翻页），无游标时从会话开头取全部。
   * 游标条件为严格大于锚点 `(created_at > ? OR (created_at = ? AND seq > ?))`。
   */
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

    return rows.map(mapAgentMessageRow);
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

    return rows.map(mapAgentMessageRow);
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

    return rows.map(mapAgentMessageRow);
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

    return rows.map(mapAgentMessageRow);
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

    return rows.map(mapAgentMessageRow);
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

    return rows.map(mapAgentMessageRow);
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

  /**
   * 更新工具调用状态。
   *
   * 终态自动补全 completedAt：当 status 转为 succeeded/failed 且调用方未显式传 completedAt 时，
   * 自动用当前时间补上。这避免业务层每次都要记得传 completedAt，也防止终态记录缺少结束时间。
   * 非终态则保留原 completedAt（通常为 null）。
   *
   * resultSummary/error 使用 `!== undefined` 判断而非 `??`：因为这些字段合法值包括 null
   * （表示"明确无值"），必须区分"未传"和"传了 null"。
   */
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

    return row ? mapAgentToolCallRow(row) : undefined;
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

    return rows.map(mapAgentToolCallRow);
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

    return rows.map(mapAgentResourceRow);
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

  /**
   * 更新进度步骤。终态自动补全 completedAt，逻辑同 updateToolCall（见其注释）。
   */
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

    return rows.map(mapAgentProcessStepRow);
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

    return row ? mapKnowledgeDocumentRow(row) : undefined;
  }

  async listKnowledgeDocuments(): Promise<KnowledgeDocumentRecord[]> {
    const rows = await this.queryMany(
      `SELECT id, name, source_path, mime_type, status, error_message, content_hash, chunk_count, created_at, updated_at, indexed_at
       FROM knowledge_documents
       ORDER BY updated_at DESC, seq DESC`
    );

    return rows.map(mapKnowledgeDocumentRow);
  }

  /**
   * 删除知识文档及其全部切片（事务化）。
   * 先删 chunks 再删 document，保证不会留下指向已删文档的孤儿切片。
   */
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

  /**
   * 全量替换某文档的全部切片（事务化）：先删后插。
   *
   * 为什么用"删除全部再重插"而非增量 diff：知识库重新切片时，分块策略可能整体变化
   * （chunk_index、边界都不同），逐条比对反而更复杂且易错。整体替换保证结果一致。
   * 必须在事务内完成：若插入中途失败，已删的旧切片不能丢，需整体回滚。
   */
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

  /**
   * 向量相似度检索（RAG 核心）。
   *
   * 原理：pgvector 的 `<=>` 算子计算余弦距离（0 表示方向一致，2 表示完全相反）。
   * score = 1 - 距离，转换为相似度（1 最相似）。ORDER BY <=> 直接按距离升序取最近邻。
   *
   * 为什么 INNER JOIN 并过滤 status = 'ready'：只检索已完成索引的文档，避免返回
   * 处于 pending/indexing 的半成品文档的切片。JOIN 同时带出 document_name 供展示。
   *
   * 排序 tie-breaker：距离相同时按 chunk_index 升序，保证结果稳定。
   * 依赖基线 migration 创建的 HNSW 索引提供近似最近邻加速，否则退化为全表扫描。
   */
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

    return rows.map(mapKnowledgeChunkSearchRow);
  }

  async appendRunEvent(
    runId: string,
    event: AgentStreamEvent,
    messageId?: string
  ): Promise<StoredAgentEvent | undefined> {
    return this.publishTransientRunEvent(runId, event, messageId);
  }

  /**
   * 发布一个"瞬时"运行事件——只通知当前在线订阅者，不落库。
   *
   * 为什么是瞬时：事件流数据量大且时效性强（只在 run 进行中有意义），落库成本高且无回放价值。
   * 历史重建靠已持久化的 message/tool_call/process_step，而非事件流。返回 storedEvent 供
   * 调用方做日志或本地处理。无订阅者时事件即丢弃。
   */
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

  /**
   * 订阅某 run 的事件。返回取消订阅函数（闭包）。
   *
   * 设计：用 Set 存监听器支持去重；最后一个监听器移除后清理 Map 条目，避免内存泄漏。
   * 返回闭包而非要求调用方手动 remove，是为了贴合"注册即持有句柄、用完即弃"的惯用法，
   * 配合 try/finally 或 effect cleanup 使用。
   */
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

  /**
   * 清空全部业务表（仅用于测试/重置环境）。
   * RESTART IDENTITY CASCADE 重置自增 seq 并级联清空依赖表，保证重置后从干净状态开始。
   */
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

  /** 多行查询的统一入口：自动把 ? 占位符转为 $N 再执行。 */
  private async queryMany<T extends QueryResultRow>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(numberPlaceholders(sql), params);
    return result.rows;
  }

  /** 单行查询：复用 queryMany 取首行，不存在返回 undefined。 */
  private async queryOne<T extends QueryResultRow>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    const rows = await this.queryMany<T>(sql, params);
    return rows[0];
  }

  /** 无返回值的写操作（INSERT/UPDATE/DELETE），走连接池自动管理连接。 */
  private async execute(sql: string, params: SqlValue[] = []): Promise<void> {
    await this.pool.query(numberPlaceholders(sql), params);
  }

  /**
   * 在指定 client（事务连接）上执行写操作。静态方法，供事务内多步操作复用。
   * 与 execute 的区别：execute 用池连接（隐式自动提交），exec 用显式 client（受 BEGIN/COMMIT 控制）。
   */
  private static async exec(client: PoolClient, sql: string, params: SqlValue[] = []): Promise<void> {
    await client.query(numberPlaceholders(sql), params);
  }

  /**
   * 刷新会话的 updated_at。几乎所有写操作都会调用它——目的是让会话列表按"最近活动"排序，
   * 任何子表（消息/run/工具调用等）的变更都应体现为会话的活跃度更新。
   */
  private async touchSession(sessionId: string, timestamp: string): Promise<void> {
    await this.execute(`UPDATE agent_sessions SET updated_at = ? WHERE id = ?`, [timestamp, sessionId]);
  }

  /**
   * 读取消息的排序游标（created_at + seq）。游标分页的锚点来源。
   * 消息不存在则返回 undefined，调用方据此判定游标无效。
   */
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

    return row ? mapAgentToolCallRow(row) : undefined;
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

    return row ? mapAgentResourceRow(row) : undefined;
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

    return row ? mapAgentProcessStepRow(row) : undefined;
  }
}

/**
 * 校验 message 状态流转的合法性。
 *
 * 状态机规则：running 是唯一可变中间态，可流向任意终态；终态（completed/failed）不可再变。
 * 允许 from === to（幂等更新，不视为非法）。不这么做会怎样：终态被改回 running 会导致
 * 已结束的消息被当成"进行中"，业务层可能重复处理或状态混乱。
 */
function assertValidMessageTransition(from: AgentMessageStatus, to: AgentMessageStatus) {
  if (from === to || from === "running") {
    return;
  }

  throw new Error(`非法 message 状态流转：${from} -> ${to}`);
}

/**
 * 校验 run 状态流转的合法性。规则同 assertValidMessageTransition。
 */
function assertValidRunTransition(from: AgentRunStatus, to: AgentRunStatus) {
  if (from === to || from === "running") {
    return;
  }

  throw new Error(`非法 run 状态流转：${from} -> ${to}`);
}

/**
 * 校验 run 的 status 与 phase 的一致性。
 *
 * 规则：running 状态下 phase 必须是具体的工作阶段（compressing/answering）；
 * 终态时 phase 必须等于 status（如 completed/completed）。这是为了防止"状态已结束但
 * phase 还停在中间阶段"这种自相矛盾的数据，保证 run 记录语义自洽。
 */
function assertRunPhaseMatchesStatus(status: AgentRunStatus, phase: AgentRunPhase) {
  if (status === "running" && (phase === "compressing" || phase === "answering")) {
    return;
  }

  if (status !== "running" && phase === status) {
    return;
  }

  throw new Error(`run 终态 phase 不一致：status=${status}, phase=${phase}`);
}
