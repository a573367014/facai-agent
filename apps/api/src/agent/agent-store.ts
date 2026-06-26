import type { AgentExecutionResult, AgentStreamEvent, JsonObject } from "./types.js";
import type { MessagePart } from "./message-parts.js";

export type AgentMessageRole = "user" | "assistant";
export type AgentMessageStatus = "running" | "completed" | "failed" | "cancelled";
export type AgentAssetType = "image";

export interface AgentSessionRecord {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessageRecord {
  id: string;
  sessionId: string;
  role: AgentMessageRole;
  status: AgentMessageStatus;
  parts: MessagePart[];
  // content 只作为旧调用点和旧 SQLite 字段的兼容镜像；新业务逻辑应优先读取 parts。
  content: string;
  maxIterations?: number;
  steps?: AgentExecutionResult["steps"];
  error?: {
    code: string;
    message: string;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentAssetRecord {
  id: string;
  sessionId: string;
  messageId?: string;
  toolCallId?: string;
  type: AgentAssetType;
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
  prompt?: string;
  index?: number;
  metadata?: JsonObject;
  createdAt: string;
}

export interface StoredAgentEvent {
  id: string;
  // seq 是同一个 assistant message 内的递增游标，SSE 重连的 after 参数按它回放后续事件。
  seq: number;
  messageId: string;
  event: AgentStreamEvent;
  createdAt: string;
}

export type AgentEventListener = (event: StoredAgentEvent) => void;

export interface CreateAgentMessageInput {
  sessionId: string;
  role: AgentMessageRole;
  status: AgentMessageStatus;
  content?: string;
  parts?: MessagePart[];
  maxIterations?: number;
  error?: {
    code: string;
    message: string;
  };
}

export interface UpdateAgentMessageInput {
  status?: AgentMessageStatus;
  content?: string;
  parts?: MessagePart[];
  steps?: AgentExecutionResult["steps"];
  error?: {
    code: string;
    message: string;
  };
  completedAt?: string;
}

export interface CreateAgentAssetInput {
  sessionId: string;
  messageId?: string;
  toolCallId?: string;
  type: AgentAssetType;
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
  prompt?: string;
  index?: number;
  metadata?: JsonObject;
}

export interface AgentStore {
  createSession(title?: string): AgentSessionRecord;
  listSessions(): AgentSessionRecord[];
  getSession(sessionId: string): AgentSessionRecord | undefined;
  createMessage(input: CreateAgentMessageInput): AgentMessageRecord;
  updateMessage(messageId: string, input: UpdateAgentMessageInput): AgentMessageRecord | undefined;
  updateMessageParts(messageId: string, parts: MessagePart[]): AgentMessageRecord | undefined;
  getMessage(messageId: string): AgentMessageRecord | undefined;
  getMessagesBySession(sessionId: string): AgentMessageRecord[];
  createAsset(input: CreateAgentAssetInput): AgentAssetRecord;
  getAssetsBySession(sessionId: string): AgentAssetRecord[];
  appendEvent(messageId: string, event: AgentStreamEvent): StoredAgentEvent | undefined;
  getEvents(messageId: string, after?: number): StoredAgentEvent[];
  subscribe(messageId: string, listener: AgentEventListener): () => void;
}
