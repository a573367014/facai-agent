/**
 * 数据库行 -> 业务记录 的映射层（反序列化边界）。
 *
 * 模块职责：把 pg 返回的"弱类型行对象"（列名是 snake_case、值类型不确定）转换为
 * 上层业务使用的"强类型记录"（驼峰命名、明确的 TS 类型）。这是数据库与业务逻辑之间
 * 唯一的翻译层，集中处理类型校验、JSON 反序列化、向量解析等脏活。
 *
 * 为什么单独成层：pg 的 QueryResultRow 本质是 any，直接在业务代码里取值会丢失类型安全，
 * 且 snake_case <-> camelCase 的转换会散落各处。收敛到 mapper 后，schema 变更只需改一处。
 *
 * 边界：本模块只做"读取并转换"，不做任何数据库访问，也不修改数据；写入方向（业务 -> DB）
 * 的序列化在 store 内通过 JSON.stringify 完成。
 */
import type { QueryResultRow } from "pg";
import type { MessagePart } from "../../modules/agent/message-parts.js";
import type {
  AgentMessageRecord,
  AgentMessageRole,
  AgentMessageStatus,
  AgentProcessStepRecord,
  AgentResourceRecord,
  AgentRunPhase,
  AgentRunRecord,
  AgentRunStatus,
  AgentSessionRecord,
  AgentSessionSummary,
  AgentSessionSummaryRecord,
  AgentToolCallRecord
} from "../../modules/agent/agent-store.js";
import type { KnowledgeChunkSearchResult, KnowledgeDocumentRecord } from "../../modules/knowledge/types.js";

/**
 * 断言某列为字符串并返回；非字符串直接抛错。
 *
 * 为什么对"必填字段"采用 fail-fast：这些字段（id、session_id 等）若缺失说明数据库结构
 * 或查询本身出了问题，属于不可恢复的 bug，应立即暴露而非用 undefined 掩盖。
 * field 参数仅用于错误信息定位，方便排查是哪一列出了问题。
 */
export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Postgres 字段 ${field} 不是字符串`);
  }

  return value;
}

/**
 * 可选字符串：是字符串则返回，否则 undefined。用于允许 NULL 的列。
 */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * 可选数字：兼容 number 与数字字符串两种来源。
 *
 * 为什么兼容字符串：pg 的 SERIAL/INTEGER 在某些驱动配置下可能以字符串返回，
 * 而业务层需要 number 做比较和运算。空字符串视为无值（undefined），避免 Number("") 得到 0
 * 这种隐蔽错误。
 */
export function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

/**
 * 读取并反序列化 JSONB 列。
 *
 * 为什么需要这层处理：pg 对 JSONB 列默认会自动解析为对象，但部分场景（如 text 强制转换、
 * 或驱动配置）会返回字符串。这里统一兜底：null/undefined -> undefined，字符串 -> JSON.parse，
 * 对象 -> 直接返回。空字符串也视为无值，避免 JSON.parse("") 报错。
 */
function readJson<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value.length === 0 ? undefined : (JSON.parse(value) as T);
  }

  return value as T;
}

/**
 * 解析 pgvector 的文本表示为 number[]。
 *
 * 背景：pgvector 的 vector 类型在查询结果中以 "[0.1,0.2,...]" 字符串形式返回。
 * 这里手动剥离方括号并按逗号切分，而非依赖额外的 pgvector 解析器，保持零额外依赖。
 * 非字符串或空内容返回空数组，保证调用方拿到稳定结构。
 */
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

/**
 * agent_sessions 行 -> AgentSessionRecord。会话基础信息映射。
 */
export function mapAgentSessionRow(row: QueryResultRow): AgentSessionRecord {
  return {
    id: requiredString(row.id, "id"),
    userId: requiredString(row.user_id, "user_id"),
    title: optionalString(row.title),
    createdAt: requiredString(row.created_at, "created_at"),
    updatedAt: requiredString(row.updated_at, "updated_at")
  };
}

/**
 * agent_messages 行 -> AgentMessageRecord。
 *
 * 注意：parts_json 落库时为 JSONB 数组，这里用 readJson 反序列化；若列为空则兜底为 []，
 * 保证业务层永远拿到数组而非 undefined。role/status 直接断言为字面量联合类型，
 * 类型安全性依赖数据库写入时的约束（写入侧已限定取值范围）。
 */
export function mapAgentMessageRow(row: QueryResultRow): AgentMessageRecord {
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

/**
 * agent_runs 行 -> AgentRunRecord。一次模型推理执行（run）的记录映射。
 */
export function mapAgentRunRow(row: QueryResultRow): AgentRunRecord {
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

/**
 * agent_session_summaries 行 -> AgentSessionSummaryRecord。
 *
 * version 与 schemaVersion 在存量数据缺失时兜底为 1：version 用于多版本摘要的链式追溯，
 * schemaVersion 标记摘要结构版本，二者缺失意味着最早的初始版本。sourceSummaryId 指向
 * 上一个被合并/迭代的摘要，构成摘要链。
 */
export function mapAgentSessionSummaryRow(row: QueryResultRow): AgentSessionSummaryRecord {
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

/**
 * agent_tool_calls 行 -> AgentToolCallRecord。
 *
 * iteration 缺失兜底为 0（表示首轮调用）；arguments 缺失兜底为 {}，保证业务层总能解构。
 * toolCallId 是 LLM 返回的逻辑调用 id（可能与多轮对应同一 id），与数据库主键 id 不同。
 */
export function mapAgentToolCallRow(row: QueryResultRow): AgentToolCallRecord {
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

/**
 * agent_resources 行 -> AgentResourceRecord。工具调用产生的资源（图片、文件等）映射。
 */
export function mapAgentResourceRow(row: QueryResultRow): AgentResourceRecord {
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

/**
 * agent_process_steps 行 -> AgentProcessStepRecord。
 *
 * orderIndex 缺失兜底为 0：前端按 order_index 排序展示步骤进度，缺值时排在最前避免丢失。
 */
export function mapAgentProcessStepRow(row: QueryResultRow): AgentProcessStepRecord {
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

/**
 * knowledge_documents 行 -> KnowledgeDocumentRecord。知识库文档元数据映射。
 * chunkCount 缺失兜底为 0（尚未切片的文档）。
 */
export function mapKnowledgeDocumentRow(row: QueryResultRow): KnowledgeDocumentRecord {
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

/**
 * 知识库向量检索结果行 -> KnowledgeChunkSearchResult。
 *
 * 这是唯一带 JOIN 字段（document_name）和计算字段（score）的 mapper：
 * - score 来自 SQL 中的 `1 - (embedding <=> query)`，即余弦相似度（<=> 返回余弦距离）；
 *   缺失时兜底为 0。
 * - embedding 通过 parseVector 把 pgvector 字符串解析为 number[]，供业务层使用。
 */
export function mapKnowledgeChunkSearchRow(row: QueryResultRow): KnowledgeChunkSearchResult {
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
