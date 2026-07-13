/**
 * 模块职责：Agent 持久化抽象层。
 *
 * 这个文件定义了 Agent 系统所有持久化实体的"契约"——接口、记录结构、输入/输出类型。
 * 它是业务编排层（coordinator / projector / service）和具体数据库实现（SQLite / Postgres）
 * 之间的隔离带：上层只依赖 AgentStore 接口，不关心数据怎么存；下层实现这个接口即可替换存储。
 *
 * 边界：
 * - 这里只有类型定义，没有任何运行时逻辑。
 * - 不包含查询语义（如"按时间倒序"），排序和过滤由实现层决定。
 * - AgentStore 继承 KnowledgeRepository，是因为知识库检索和 Agent 共享同一套会话/消息存储。
 */
import type { AgentStreamEvent } from "./types.js";
import type { MessagePart } from "./message-parts.js";
import type { JsonObject } from "../tools/types.js";
import type { KnowledgeRepository } from "../knowledge/knowledge-repository.js";

/**
 * 消息角色。system 角色专用于上下文压缩产生的摘要消息，不暴露给用户。
 */
export type AgentMessageRole = "user" | "assistant" | "system";

/**
 * 消息状态机：running → completed | failed | cancelled。
 * running 表示模型正在生成；终态一旦写入就不再回退，保证审计可追溯。
 */
export type AgentMessageStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Run 状态机，和消息状态平行但独立。
 * 一个 run 可能关联多条消息（system 压缩消息 + assistant 回答消息），run 的终态决定整体结论。
 */
export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Run 阶段，比 status 更细粒度。
 * compressing：正在做上下文压缩；answering：正在生成回答。
 * 前端用 phase 展示"压缩中/回答中"的进度，而不只是笼统的 running。
 */
export type AgentRunPhase = "compressing" | "answering" | "completed" | "failed" | "cancelled";

/**
 * 工具调用状态机：pending（已排队）→ running（执行中）→ succeeded | failed。
 * 注意：批量生图"部分成功"时 tool_call 整体仍算 succeeded，单项失败体现在 resource 层。
 */
export type AgentToolCallStatus = "pending" | "running" | "succeeded" | "failed";

/**
 * 资源状态机：pending（生成中占位）→ succeeded | failed。
 * pending 占位让用户在工具执行期间就能看到"图片生成中"的卡片。
 */
export type AgentResourceStatus = "pending" | "succeeded" | "failed";

/**
 * 过程步骤种类，对应前端进度列表的不同展示形态。
 * thinking：理解需求；tool：工具调用；resource：资源产出；summary：整理回答；error：全局错误。
 */
export type AgentProcessStepKind = "thinking" | "tool" | "resource" | "summary" | "error";

/**
 * 过程步骤状态机。和 run/message 状态对齐，completeRunning 时统一收尾。
 */
export type AgentProcessStepStatus = "running" | "succeeded" | "failed" | "cancelled";

/**
 * 会话记录。一个会话是用户和 Agent 的一段连续对话，包含多条消息和多个 run。
 * userId 用于多租户隔离；title 通常取首条用户消息的前若干字符。
 */
export interface AgentSessionRecord {
  id: string;
  userId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 结构化会话摘要。由摘要服务调用 LLM 生成，写入 SQLite 后作为后续对话的 system 记忆。
 * 采用结构化字段（而非自由文本）是为了让 ContextBuilder 能按字段拼装上下文，
 * 也方便前端在会话列表展示"当前目标/已做决策"等概要信息。
 */
export interface AgentSessionSummary {
  userGoal?: string;
  currentTask?: string;
  decisions: string[];
  preferences: string[];
  constraints: string[];
  importantFacts: string[];
  openQuestions: string[];
  recentProgress: string[];
}

/**
 * 摘要记录的持久化形态。
 * coveredMessageId 标记这份摘要"覆盖到哪条消息"，后续查询上下文时从这条消息之后取原文。
 * version 用于乐观并发控制；sourceSummaryId 记录这份摘要基于哪份旧摘要增量合并。
 */
export interface AgentSessionSummaryRecord {
  id: string;
  sessionId: string;
  version: number;
  summary: AgentSessionSummary;
  coveredMessageId: string;
  coveredMessageCreatedAt: string;
  sourceSummaryId?: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPageInfo {
  hasMore: boolean;
  nextCursor?: string;
  limit: number;
}

export type AgentMessagePageInfo = AgentPageInfo;

export interface AgentMessagePage {
  messages: AgentMessageRecord[];
  pageInfo: AgentMessagePageInfo;
}

export interface ListAgentSessionsOptions {
  userId?: string;
  after?: string;
  limit?: number;
}

export type AgentSessionPageInfo = AgentPageInfo;

/**
 * 消息记录。是 Agent 系统的核心实体：用户输入、助手回答、系统压缩消息都存在同一张表。
 * parts 是 MessagePart 数组，承载文本、资源占位、资源结果等结构化内容。
 * 运行中 parts 先写 Redis 草稿，run 完成后才固化回 SQLite，避免高频写库。
 */
export interface AgentMessageRecord {
  id: string;
  sessionId: string;
  role: AgentMessageRole;
  status: AgentMessageStatus;
  parts: MessagePart[];
  maxIterations?: number;
  error?: {
    code: string;
    message: string;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/**
 * Run 记录。一次 run = 用户发一条消息 → Agent 执行（可能含压缩+多轮工具调用）→ 产出回答。
 * userMessageId / systemMessageId / assistantMessageId 把 run 和它涉及的消息关联起来。
 * phase 比 status 更细：compressing 阶段可能产出 system 消息，answering 阶段产出 assistant 消息。
 */
export interface AgentRunRecord {
  id: string;
  sessionId: string;
  status: AgentRunStatus;
  phase: AgentRunPhase;
  userMessageId: string;
  systemMessageId?: string;
  assistantMessageId?: string;
  error?: {
    code: string;
    message: string;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/**
 * 已存储的 Agent 事件。事件是 run 执行过程中产生的流式信号（answer_delta / tool_start / tool_result 等）。
 * transient=true 表示只走内存/Redis 实时推送，不持久化（如高频 delta）；
 * transient=false 或 undefined 表示写入持久存储，供断线重连回放和审计排查。
 */
export interface StoredAgentEvent {
  id: string;
  messageId?: string;
  runId?: string;
  event: AgentStreamEvent;
  createdAt: string;
  transient?: boolean;
}

/**
 * 事件监听器。store.subscribeRun 返回取消订阅函数，调用方在 SSE 断开时清理。
 */
export type AgentEventListener = (event: StoredAgentEvent) => void;

/**
 * 工具调用记录。用于审计：哪个工具、什么参数、执行多久、成功还是失败。
 * iteration 标记第几轮迭代（模型可能多轮调工具）；toolCallId 是模型侧的调用 ID。
 * resultSummary 只存摘要，完整结果由 resource/message part 承载，避免审计表膨胀。
 */
export interface AgentToolCallRecord {
  id: string;
  sessionId: string;
  runId?: string;
  messageId: string;
  iteration: number;
  toolCallId?: string;
  toolName: string;
  status: AgentToolCallStatus;
  arguments: JsonObject;
  resultSummary?: JsonObject;
  error?: {
    code: string;
    message: string;
  };
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

/**
 * 资源记录。图片、视频、文档等工具产出的长期资源都存在这张表。
 * 和 message part 的区别：resource 是"资源本身"的元数据（URL/尺寸/状态），
 * message part 是"资源在聊天正文中的展示位"。一个 resource 可被多个 part 引用。
 * toolCallRowId 把资源和产生它的工具调用关联起来，便于审计追溯。
 */
export interface AgentResourceRecord {
  id: string;
  sessionId: string;
  messageId: string;
  toolCallRowId?: string;
  toolCallId?: string;
  type: string;
  mime?: string;
  url?: string;
  name?: string;
  status: AgentResourceStatus;
  width?: number;
  height?: number;
  metadata?: JsonObject;
  createdAt: string;
  updatedAt: string;
}

/**
 * 过程步骤记录。把底层流式事件翻译成"用户能看懂的任务进度"。
 * kind 决定前端展示形态（思考中/工具执行中/整理回答等）；orderIndex 保证按创建顺序稳定排列。
 * 和 tool_call 的区别：process_step 面向用户展示，tool_call 面向审计；一个 tool_call 对应一个 tool step。
 */
export interface AgentProcessStepRecord {
  id: string;
  sessionId: string;
  runId?: string;
  messageId: string;
  toolCallRowId?: string;
  toolCallId?: string;
  kind: AgentProcessStepKind;
  title: string;
  summary?: string;
  status: AgentProcessStepStatus;
  orderIndex: number;
  metadata?: JsonObject;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CreateAgentMessageInput {
  sessionId: string;
  role: AgentMessageRole;
  status: AgentMessageStatus;
  parts: MessagePart[];
  maxIterations?: number;
  error?: {
    code: string;
    message: string;
  };
  createdAt?: string;
}

export interface CreateAgentRunInput {
  sessionId: string;
  userMessageId: string;
  status: AgentRunStatus;
  phase: AgentRunPhase;
  systemMessageId?: string;
  assistantMessageId?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface UpdateAgentMessageInput {
  status?: AgentMessageStatus;
  parts?: MessagePart[];
  error?: {
    code: string;
    message: string;
  };
  completedAt?: string;
}

export interface UpdateAgentRunInput {
  status?: AgentRunStatus;
  phase?: AgentRunPhase;
  systemMessageId?: string;
  assistantMessageId?: string;
  error?: {
    code: string;
    message: string;
  };
  completedAt?: string;
}

export interface UpsertAgentSessionSummaryInput {
  sessionId: string;
  summary: AgentSessionSummary;
  coveredMessageId: string;
  schemaVersion?: number;
}

export interface CreateAgentToolCallInput {
  sessionId: string;
  runId?: string;
  messageId: string;
  iteration: number;
  toolCallId?: string;
  toolName: string;
  arguments: JsonObject;
  status?: AgentToolCallStatus;
}

export interface UpdateAgentToolCallInput {
  status?: AgentToolCallStatus;
  resultSummary?: JsonObject;
  error?: {
    code: string;
    message: string;
  };
  durationMs?: number;
  completedAt?: string;
}

export interface CreateAgentResourceInput {
  sessionId: string;
  messageId: string;
  toolCallRowId?: string;
  toolCallId?: string;
  type: string;
  mime?: string;
  url?: string;
  name?: string;
  status: AgentResourceStatus;
  width?: number;
  height?: number;
  metadata?: JsonObject;
}

export interface UpdateAgentResourceInput {
  toolCallRowId?: string;
  toolCallId?: string;
  mime?: string;
  url?: string;
  name?: string;
  status?: AgentResourceStatus;
  width?: number;
  height?: number;
  metadata?: JsonObject;
}

export interface CreateAgentProcessStepInput {
  sessionId: string;
  runId?: string;
  messageId: string;
  toolCallRowId?: string;
  toolCallId?: string;
  kind: AgentProcessStepKind;
  title: string;
  summary?: string;
  status?: AgentProcessStepStatus;
  orderIndex: number;
  metadata?: JsonObject;
}

export interface UpdateAgentProcessStepInput {
  toolCallRowId?: string;
  toolCallId?: string;
  title?: string;
  summary?: string;
  status?: AgentProcessStepStatus;
  metadata?: JsonObject;
  completedAt?: string;
}

/**
 * Agent 持久化抽象接口。所有业务类（coordinator / projector / service）只依赖这个接口，
 * 不直接碰 SQL 或 Redis。这样做的好处：
 * 1. 测试时可以注入内存实现，不依赖真实数据库；
 * 2. 从 SQLite 迁移到 Postgres 时，只改实现不改业务层；
 * 3. 接口方法签名本身就是"数据契约"，实现层不能偷偷加排序/过滤语义。
 *
 * 事件相关方法（appendRunEvent / publishTransientRunEvent / subscribeRun）同时承担
 * 持久化和实时推送职责：appendRunEvent 写库 + 本进程 fanout，
 * publishTransientRunEvent 只走内存/Redis 不写库（用于高频 delta），
 * subscribeRun 订阅当前进程的事件流。
 */
export interface AgentStore extends KnowledgeRepository {
  createSession(title?: string, userId?: string): Promise<AgentSessionRecord>;
  listSessions(options?: ListAgentSessionsOptions): Promise<AgentSessionRecord[]>;
  getSession(sessionId: string, userId?: string): Promise<AgentSessionRecord | undefined>;
  deleteSession(sessionId: string): Promise<boolean>;
  getSessionSummary(sessionId: string): Promise<AgentSessionSummaryRecord | undefined>;
  getSessionSummaryBeforeMessage(sessionId: string, messageId: string): Promise<AgentSessionSummaryRecord | undefined>;
  listSessionSummaries(sessionId: string): Promise<AgentSessionSummaryRecord[]>;
  upsertSessionSummary(input: UpsertAgentSessionSummaryInput): Promise<AgentSessionSummaryRecord>;
  createRun(input: CreateAgentRunInput): Promise<AgentRunRecord>;
  updateRun(runId: string, input: UpdateAgentRunInput): Promise<AgentRunRecord | undefined>;
  getRun(runId: string): Promise<AgentRunRecord | undefined>;
  getRunsByMessageId(messageId: string): Promise<AgentRunRecord[]>;
  createMessage(input: CreateAgentMessageInput): Promise<AgentMessageRecord>;
  updateMessage(messageId: string, input: UpdateAgentMessageInput): Promise<AgentMessageRecord | undefined>;
  updateMessageParts(messageId: string, parts: MessagePart[]): Promise<AgentMessageRecord | undefined>;
  getMessage(messageId: string): Promise<AgentMessageRecord | undefined>;
  getMessagesBySession(sessionId: string): Promise<AgentMessageRecord[]>;
  getRecentMessagesBySession(sessionId: string, limit: number): Promise<AgentMessageRecord[]>;
  getRecentContextMessagesBySession(sessionId: string, limit: number): Promise<AgentMessageRecord[]>;
  getMessagesBefore(sessionId: string, beforeMessageId: string, limit: number): Promise<AgentMessageRecord[]>;
  getMessagesAfter(sessionId: string, afterMessageId: string | undefined, limit?: number): Promise<AgentMessageRecord[]>;
  getRecentMessagesAfter(sessionId: string, afterMessageId: string | undefined, limit: number): Promise<AgentMessageRecord[]>;
  countMessagesAfter(sessionId: string, afterMessageId?: string): Promise<number>;
  getContextMessagesAfter(sessionId: string, afterMessageId: string | undefined, limit?: number): Promise<AgentMessageRecord[]>;
  getRecentContextMessagesAfter(sessionId: string, afterMessageId: string | undefined, limit: number): Promise<AgentMessageRecord[]>;
  countContextMessagesAfter(sessionId: string, afterMessageId?: string): Promise<number>;
  getContextMessagesBefore(
    sessionId: string,
    beforeMessageId: string,
    afterMessageId: string | undefined,
    limit?: number
  ): Promise<AgentMessageRecord[]>;
  getRecentContextMessagesBefore(
    sessionId: string,
    beforeMessageId: string,
    afterMessageId: string | undefined,
    limit: number
  ): Promise<AgentMessageRecord[]>;
  countContextMessagesBefore(sessionId: string, beforeMessageId: string, afterMessageId?: string): Promise<number>;
  createToolCall(input: CreateAgentToolCallInput): Promise<AgentToolCallRecord>;
  updateToolCall(toolCallRowId: string, input: UpdateAgentToolCallInput): Promise<AgentToolCallRecord | undefined>;
  getToolCallByMessageToolCall(messageId: string, toolCallId: string): Promise<AgentToolCallRecord | undefined>;
  getToolCallsBySession(sessionId: string): Promise<AgentToolCallRecord[]>;
  createResource(input: CreateAgentResourceInput): Promise<AgentResourceRecord>;
  updateResource(resourceId: string, input: UpdateAgentResourceInput): Promise<AgentResourceRecord | undefined>;
  getResourcesByMessages(messageIds: string[]): Promise<AgentResourceRecord[]>;
  createProcessStep(input: CreateAgentProcessStepInput): Promise<AgentProcessStepRecord>;
  updateProcessStep(stepId: string, input: UpdateAgentProcessStepInput): Promise<AgentProcessStepRecord | undefined>;
  getProcessStepsByMessages(messageIds: string[]): Promise<AgentProcessStepRecord[]>;
  appendRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): Promise<StoredAgentEvent | undefined>;
  publishTransientRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): Promise<StoredAgentEvent | undefined>;
  subscribeRun(runId: string, listener: AgentEventListener): () => void;
}
