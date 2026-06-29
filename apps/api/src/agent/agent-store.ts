import type { AgentStreamEvent } from "./types.js";
import type { MessagePart } from "./message-parts.js";
import type { JsonObject } from "../tools/types.js";

export type AgentMessageRole = "user" | "assistant" | "system";
export type AgentMessageStatus = "running" | "completed" | "failed" | "cancelled";
export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";
export type AgentRunPhase = "compressing" | "answering" | "completed" | "failed" | "cancelled";
export type AgentToolCallStatus = "pending" | "running" | "succeeded" | "failed";
export type AgentResourceStatus = "pending" | "succeeded" | "failed";

export interface AgentSessionRecord {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

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

export interface AgentMessagePageInfo {
  hasMore: boolean;
  oldestCursor?: string;
  limit: number;
}

export interface AgentMessagePage {
  messages: AgentMessageRecord[];
  pageInfo: AgentMessagePageInfo;
}

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

export interface StoredAgentEvent {
  id: string;
  // seq > 0 表示持久化事件游标；seq = 0 表示只用于当前连接的 live/snapshot 事件，不参与回放。
  seq: number;
  messageId?: string;
  runId?: string;
  event: AgentStreamEvent;
  createdAt: string;
  transient?: boolean;
}

export type AgentEventListener = (event: StoredAgentEvent) => void;

export interface PruneAgentEventsResult {
  messageEvents: number;
  runEvents: number;
  batches: number;
  reachedLimit: boolean;
}

export interface PruneExpiredAgentEventsInput {
  nowIso: string;
  batchSize: number;
  maxBatches: number;
}

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

export interface AgentStore {
  createSession(title?: string): AgentSessionRecord;
  listSessions(): AgentSessionRecord[];
  getSession(sessionId: string): AgentSessionRecord | undefined;
  getSessionSummary(sessionId: string): AgentSessionSummaryRecord | undefined;
  getSessionSummaryBeforeMessage(sessionId: string, messageId: string): AgentSessionSummaryRecord | undefined;
  listSessionSummaries(sessionId: string): AgentSessionSummaryRecord[];
  upsertSessionSummary(input: UpsertAgentSessionSummaryInput): AgentSessionSummaryRecord;
  createRun(input: CreateAgentRunInput): AgentRunRecord;
  updateRun(runId: string, input: UpdateAgentRunInput): AgentRunRecord | undefined;
  getRun(runId: string): AgentRunRecord | undefined;
  getRunsByMessageId(messageId: string): AgentRunRecord[];
  createMessage(input: CreateAgentMessageInput): AgentMessageRecord;
  updateMessage(messageId: string, input: UpdateAgentMessageInput): AgentMessageRecord | undefined;
  updateMessageParts(messageId: string, parts: MessagePart[]): AgentMessageRecord | undefined;
  getMessage(messageId: string): AgentMessageRecord | undefined;
  getMessagesBySession(sessionId: string): AgentMessageRecord[];
  getRecentMessagesBySession(sessionId: string, limit: number): AgentMessageRecord[];
  getRecentContextMessagesBySession(sessionId: string, limit: number): AgentMessageRecord[];
  getMessagesBefore(sessionId: string, beforeMessageId: string, limit: number): AgentMessageRecord[];
  getMessagesAfter(sessionId: string, afterMessageId: string | undefined, limit?: number): AgentMessageRecord[];
  getRecentMessagesAfter(sessionId: string, afterMessageId: string | undefined, limit: number): AgentMessageRecord[];
  countMessagesAfter(sessionId: string, afterMessageId?: string): number;
  getContextMessagesAfter(sessionId: string, afterMessageId: string | undefined, limit?: number): AgentMessageRecord[];
  getRecentContextMessagesAfter(sessionId: string, afterMessageId: string | undefined, limit: number): AgentMessageRecord[];
  countContextMessagesAfter(sessionId: string, afterMessageId?: string): number;
  getContextMessagesBefore(
    sessionId: string,
    beforeMessageId: string,
    afterMessageId: string | undefined,
    limit?: number
  ): AgentMessageRecord[];
  getRecentContextMessagesBefore(
    sessionId: string,
    beforeMessageId: string,
    afterMessageId: string | undefined,
    limit: number
  ): AgentMessageRecord[];
  countContextMessagesBefore(sessionId: string, beforeMessageId: string, afterMessageId?: string): number;
  pruneExpiredEvents(input: PruneExpiredAgentEventsInput): PruneAgentEventsResult;
  createToolCall(input: CreateAgentToolCallInput): AgentToolCallRecord;
  updateToolCall(toolCallRowId: string, input: UpdateAgentToolCallInput): AgentToolCallRecord | undefined;
  getToolCallByMessageToolCall(messageId: string, toolCallId: string): AgentToolCallRecord | undefined;
  getToolCallsBySession(sessionId: string): AgentToolCallRecord[];
  createResource(input: CreateAgentResourceInput): AgentResourceRecord;
  updateResource(resourceId: string, input: UpdateAgentResourceInput): AgentResourceRecord | undefined;
  getResourcesByMessages(messageIds: string[]): AgentResourceRecord[];
  appendEvent(messageId: string, event: AgentStreamEvent): StoredAgentEvent | undefined;
  publishTransientEvent(messageId: string, event: AgentStreamEvent): StoredAgentEvent | undefined;
  getEvents(messageId: string, after?: number): StoredAgentEvent[];
  subscribe(messageId: string, listener: AgentEventListener): () => void;
  appendRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): StoredAgentEvent | undefined;
  publishTransientRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): StoredAgentEvent | undefined;
  getRunEvents(runId: string, after?: number): StoredAgentEvent[];
  subscribeRun(runId: string, listener: AgentEventListener): () => void;
}
