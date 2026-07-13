/**
 * Agent 响应序列化映射器。
 *
 * 本文件负责把内部存储模型（*Record 类型，来自 agent-store.ts）转换成
 * 对外 API 契约（*Response / *Dto 类型，来自 @agent/contracts）。它是
 * "存储层"和"传输层"之间的防腐层（Anti-Corruption Layer）。
 *
 * 为什么需要这层映射：
 * 1. 存储模型和对外 DTO 的字段不完全一致——存储模型可能有内部字段
 *    （如索引、外键）不适合暴露给前端；
 * 2. 存储模型可能随数据库 schema 变化，而对外契约需要保持稳定——
 *    有了映射层，存储变了只改 mapper，不影响 API 契约；
 * 3. 聚合响应（如 toAgentSessionResponse）需要把多个 Record 组装成
 *    一个完整的响应对象，这个组装逻辑集中在这里，路由层不用关心。
 *
 * 边界说明：本文件只做字段映射和结构组装，不做业务逻辑——
 * 不查数据库、不做权限判断、不做数据转换。纯函数，输入 Record 输出 DTO。
 */
import type {
  AgentMessageDetailResponse,
  AgentMessageDto,
  AgentProcessStepDto,
  AgentResourceDto,
  AgentRunDetailResponse,
  AgentRunDto,
  AgentSessionDto,
  AgentSessionMessagesResponse,
  AgentSessionResponse,
  AgentSessionsResponse,
  AgentSessionSummaryDto,
  CancelAgentRunResponse,
  RegenerateAgentMessageResponse,
  StartAgentRunResponse
} from "@agent/contracts";
import type {
  AgentMessagePageInfo,
  AgentMessageRecord,
  AgentProcessStepRecord,
  AgentResourceRecord,
  AgentRunRecord,
  AgentSessionRecord,
  AgentSessionSummaryRecord,
  AgentSessionPageInfo
} from "../agent-store.js";

/**
 * 把会话记录映射为对外 DTO。
 *
 * 只保留前端需要的字段（id/title/时间戳），不暴露内部存储细节。
 */
export function toAgentSessionDto(record: AgentSessionRecord): AgentSessionDto {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

/**
 * 把消息记录映射为对外 DTO。
 *
 * 消息是 Agent 对话的核心实体，包含 role/status/parts/maxIterations/error
 * 等字段。parts 是结构化消息片段（文本/资源），直接透传不做转换——
 * 因为 parts 的结构在存储和传输层是一致的。
 */
export function toAgentMessageDto(record: AgentMessageRecord): AgentMessageDto {
  return {
    id: record.id,
    sessionId: record.sessionId,
    role: record.role,
    status: record.status,
    parts: record.parts,
    maxIterations: record.maxIterations,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt
  };
}

/**
 * 把运行记录映射为对外 DTO。
 *
 * Run 代表一次 Agent 执行（从用户输入到最终答案），包含状态机字段
 *（status/phase）和关联消息 ID（userMessageId/assistantMessageId 等）。
 */
export function toAgentRunDto(record: AgentRunRecord): AgentRunDto {
  return {
    id: record.id,
    sessionId: record.sessionId,
    status: record.status,
    phase: record.phase,
    userMessageId: record.userMessageId,
    systemMessageId: record.systemMessageId,
    assistantMessageId: record.assistantMessageId,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt
  };
}

/**
 * 把资源记录映射为对外 DTO。
 *
 * 资源是工具执行产生的附属物（图片/视频/文档等），包含 URL、MIME、
 * 尺寸等元数据。toolCallRowId/toolCallId 用于把资源关联回产生它的
 * 那次工具调用，前端据此展示"这个资源是哪一步生成的"。
 */
export function toAgentResourceDto(record: AgentResourceRecord): AgentResourceDto {
  return {
    id: record.id,
    sessionId: record.sessionId,
    messageId: record.messageId,
    toolCallRowId: record.toolCallRowId,
    toolCallId: record.toolCallId,
    type: record.type,
    mime: record.mime,
    url: record.url,
    name: record.name,
    status: record.status,
    width: record.width,
    height: record.height,
    metadata: record.metadata,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

/**
 * 把过程步骤记录映射为对外 DTO。
 *
 * 过程步骤记录 Agent 执行中的每个关键节点（如"调用工具 X"、"生成图片"），
 * 用于前端展示执行时间线。orderIndex 保证步骤按正确顺序展示。
 */
export function toAgentProcessStepDto(record: AgentProcessStepRecord): AgentProcessStepDto {
  return {
    id: record.id,
    sessionId: record.sessionId,
    runId: record.runId,
    messageId: record.messageId,
    toolCallRowId: record.toolCallRowId,
    toolCallId: record.toolCallId,
    kind: record.kind,
    title: record.title,
    summary: record.summary,
    status: record.status,
    orderIndex: record.orderIndex,
    metadata: record.metadata,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt
  };
}

/**
 * 把会话摘要记录映射为对外 DTO。
 *
 * 会话摘要是长对话的压缩版，用于在上下文超长时替代完整历史喂给 LLM。
 * 包含版本号（version）和覆盖范围（coveredMessageId），用于判断摘要
 * 是否需要更新。
 */
function toAgentSessionSummaryDto(record: AgentSessionSummaryRecord): AgentSessionSummaryDto {
  return {
    id: record.id,
    sessionId: record.sessionId,
    version: record.version,
    summary: record.summary,
    coveredMessageId: record.coveredMessageId,
    coveredMessageCreatedAt: record.coveredMessageCreatedAt,
    sourceSummaryId: record.sourceSummaryId,
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

/**
 * 组装"发起运行"的聚合响应。
 *
 * 一次运行发起后，前端需要同时拿到 run（运行状态）、session（会话信息）、
 * userMessage（用户消息记录）和 traceId（链路追踪 ID），这里把多个 Record
 * 聚合成一个完整的响应对象。
 */
export function toStartAgentRunResponse(input: {
  run: AgentRunRecord;
  session: AgentSessionRecord;
  userMessage: AgentMessageRecord;
  traceId?: string;
}): StartAgentRunResponse {
  return {
    run: toAgentRunDto(input.run),
    session: toAgentSessionDto(input.session),
    userMessage: toAgentMessageDto(input.userMessage),
    traceId: input.traceId
  };
}

/**
 * 组装"重新生成消息"的聚合响应。
 *
 * 重新生成的响应结构和发起运行完全一致（都是 run + session + userMessage），
 * 所以直接复用 toStartAgentRunResponse，避免重复代码。
 */
export function toRegenerateAgentMessageResponse(input: {
  run: AgentRunRecord;
  session: AgentSessionRecord;
  userMessage: AgentMessageRecord;
  traceId?: string;
}): RegenerateAgentMessageResponse {
  return toStartAgentRunResponse(input);
}

/**
 * 组装"会话列表"的聚合响应。
 *
 * 把多个会话记录映射为 DTO 数组，并附带分页信息（pageInfo）。
 */
export function toAgentSessionsResponse(input: {
  sessions: AgentSessionRecord[];
  pageInfo?: AgentSessionPageInfo;
}): AgentSessionsResponse {
  return {
    sessions: input.sessions.map(toAgentSessionDto),
    pageInfo: input.pageInfo
  };
}

/**
 * 组装"会话详情"的聚合响应。
 *
 * 这是信息量最大的响应：会话本身 + 消息列表 + 资源列表 + 过程步骤列表
 * + 分页信息 + 会话摘要。前端打开一个会话时用这个接口一次性拿到
 * 渲染所需的所有数据，避免多次请求。
 *
 * resources/processSteps/summary 都是可选的，不存在时对应字段为 undefined，
 * 前端需要做空值处理。
 */
export function toAgentSessionResponse(input: {
  session: AgentSessionRecord;
  messages: AgentMessageRecord[];
  resources?: AgentResourceRecord[];
  processSteps?: AgentProcessStepRecord[];
  pageInfo?: AgentMessagePageInfo;
  summary?: AgentSessionSummaryRecord;
}): AgentSessionResponse {
  return {
    session: toAgentSessionDto(input.session),
    messages: input.messages.map(toAgentMessageDto),
    resources: input.resources?.map(toAgentResourceDto),
    processSteps: input.processSteps?.map(toAgentProcessStepDto),
    pageInfo: input.pageInfo,
    summary: input.summary ? toAgentSessionSummaryDto(input.summary) : undefined
  };
}

/**
 * 组装"会话消息列表"的聚合响应。
 *
 * 与 toAgentSessionResponse 类似，但不包含 session 本身，只返回消息、
 * 资源、过程步骤和分页信息。用于前端在已有 session 的情况下翻页加载
 * 更多历史消息。
 */
export function toAgentSessionMessagesResponse(input: {
  messages: AgentMessageRecord[];
  resources?: AgentResourceRecord[];
  processSteps?: AgentProcessStepRecord[];
  pageInfo: AgentMessagePageInfo;
}): AgentSessionMessagesResponse {
  return {
    messages: input.messages.map(toAgentMessageDto),
    resources: input.resources?.map(toAgentResourceDto),
    processSteps: input.processSteps?.map(toAgentProcessStepDto),
    pageInfo: input.pageInfo
  };
}

/**
 * 组装"消息详情"的聚合响应。
 *
 * 返回单条消息的完整快照：消息本身 + 关联资源 + 过程步骤 + 版本号。
 * version 用于乐观并发控制——前端编辑时带上 version，提交时校验是否
 * 期间被其他人改过。
 */
export function toAgentMessageDetailResponse(input: {
  message: AgentMessageRecord;
  resources?: AgentResourceRecord[];
  processSteps?: AgentProcessStepRecord[];
  version?: number;
}): AgentMessageDetailResponse {
  return {
    message: toAgentMessageDto(input.message),
    resources: input.resources?.map(toAgentResourceDto),
    processSteps: input.processSteps?.map(toAgentProcessStepDto),
    version: input.version
  };
}

/**
 * 组装"运行详情"的响应。
 *
 * 只返回 run 本身，结构简单。前端查询单个运行状态时用。
 */
export function toAgentRunDetailResponse(input: { run: AgentRunRecord }): AgentRunDetailResponse {
  return { run: toAgentRunDto(input.run) };
}

/**
 * 组装"取消运行"的响应。
 *
 * 取消后返回最新的 run 状态（status 应为 cancelled），
 * 前端据此更新 UI。
 */
export function toCancelAgentRunResponse(input: { run: AgentRunRecord }): CancelAgentRunResponse {
  return { run: toAgentRunDto(input.run) };
}
