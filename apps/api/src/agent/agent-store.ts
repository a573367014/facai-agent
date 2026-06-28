import type { AgentStreamEvent } from "./types.js";
import type { MessagePart } from "./message-parts.js";

export type AgentMessageRole = "user" | "assistant" | "system";
export type AgentMessageStatus = "running" | "completed" | "failed" | "cancelled";
export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";
export type AgentRunPhase = "compressing" | "answering" | "completed" | "failed" | "cancelled";

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
  sessionId: string;
  summary: AgentSessionSummary;
  coveredMessageId: string;
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
  // seq 是同一个 assistant message 或 run 内的递增游标，SSE 重连的 after 参数按它回放后续事件。
  seq: number;
  messageId?: string;
  runId?: string;
  event: AgentStreamEvent;
  createdAt: string;
}

export type AgentEventListener = (event: StoredAgentEvent) => void;

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

export interface AgentStore {
  createSession(title?: string): AgentSessionRecord;
  listSessions(): AgentSessionRecord[];
  getSession(sessionId: string): AgentSessionRecord | undefined;
  getSessionSummary(sessionId: string): AgentSessionSummaryRecord | undefined;
  upsertSessionSummary(input: UpsertAgentSessionSummaryInput): AgentSessionSummaryRecord;
  createRun(input: CreateAgentRunInput): AgentRunRecord;
  updateRun(runId: string, input: UpdateAgentRunInput): AgentRunRecord | undefined;
  getRun(runId: string): AgentRunRecord | undefined;
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
  appendEvent(messageId: string, event: AgentStreamEvent): StoredAgentEvent | undefined;
  getEvents(messageId: string, after?: number): StoredAgentEvent[];
  subscribe(messageId: string, listener: AgentEventListener): () => void;
  appendRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): StoredAgentEvent | undefined;
  getRunEvents(runId: string, after?: number): StoredAgentEvent[];
  subscribeRun(runId: string, listener: AgentEventListener): () => void;
}
