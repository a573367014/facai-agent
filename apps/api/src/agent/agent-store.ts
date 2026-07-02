import type { AgentStreamEvent } from "./types.js";
import type { MessagePart } from "./message-parts.js";
import type { JsonObject } from "../tools/types.js";
import type {
  CreateKnowledgeChunkInput,
  CreateKnowledgeDocumentInput,
  KnowledgeChunkSearchResult,
  KnowledgeDocumentRecord,
  SearchKnowledgeChunksInput,
  UpdateKnowledgeDocumentInput
} from "../knowledge/types.js";

export type AgentMessageRole = "user" | "assistant" | "system";
export type AgentMessageStatus = "running" | "completed" | "failed" | "cancelled";
export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";
export type AgentRunPhase = "compressing" | "answering" | "completed" | "failed" | "cancelled";
export type AgentToolCallStatus = "pending" | "running" | "succeeded" | "failed";
export type AgentResourceStatus = "pending" | "succeeded" | "failed";
export type AgentProcessStepKind = "thinking" | "tool" | "resource" | "summary" | "error";
export type AgentProcessStepStatus = "running" | "succeeded" | "failed" | "cancelled";

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
  after?: string;
  limit?: number;
}

export type AgentSessionPageInfo = AgentPageInfo;

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
  messageId?: string;
  runId?: string;
  event: AgentStreamEvent;
  createdAt: string;
  transient?: boolean;
}

export type AgentEventListener = (event: StoredAgentEvent) => void;

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

export interface AgentStore {
  createSession(title?: string): AgentSessionRecord;
  listSessions(options?: ListAgentSessionsOptions): AgentSessionRecord[];
  getSession(sessionId: string): AgentSessionRecord | undefined;
  deleteSession(sessionId: string): boolean;
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
  createToolCall(input: CreateAgentToolCallInput): AgentToolCallRecord;
  updateToolCall(toolCallRowId: string, input: UpdateAgentToolCallInput): AgentToolCallRecord | undefined;
  getToolCallByMessageToolCall(messageId: string, toolCallId: string): AgentToolCallRecord | undefined;
  getToolCallsBySession(sessionId: string): AgentToolCallRecord[];
  createResource(input: CreateAgentResourceInput): AgentResourceRecord;
  updateResource(resourceId: string, input: UpdateAgentResourceInput): AgentResourceRecord | undefined;
  getResourcesByMessages(messageIds: string[]): AgentResourceRecord[];
  createProcessStep(input: CreateAgentProcessStepInput): AgentProcessStepRecord;
  updateProcessStep(stepId: string, input: UpdateAgentProcessStepInput): AgentProcessStepRecord | undefined;
  getProcessStepsByMessages(messageIds: string[]): AgentProcessStepRecord[];
  createKnowledgeDocument(input: CreateKnowledgeDocumentInput): KnowledgeDocumentRecord;
  updateKnowledgeDocument(documentId: string, input: UpdateKnowledgeDocumentInput): KnowledgeDocumentRecord | undefined;
  getKnowledgeDocument(documentId: string): KnowledgeDocumentRecord | undefined;
  listKnowledgeDocuments(): KnowledgeDocumentRecord[];
  deleteKnowledgeDocument(documentId: string): boolean;
  replaceKnowledgeChunks(documentId: string, chunks: CreateKnowledgeChunkInput[]): void;
  searchKnowledgeChunks(input: SearchKnowledgeChunksInput): KnowledgeChunkSearchResult[];
  appendRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): StoredAgentEvent | undefined;
  publishTransientRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): StoredAgentEvent | undefined;
  subscribeRun(runId: string, listener: AgentEventListener): () => void;
}
