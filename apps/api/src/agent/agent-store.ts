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
  userId: string;
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
  userId?: string;
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
  createKnowledgeDocument(input: CreateKnowledgeDocumentInput): Promise<KnowledgeDocumentRecord>;
  updateKnowledgeDocument(documentId: string, input: UpdateKnowledgeDocumentInput): Promise<KnowledgeDocumentRecord | undefined>;
  getKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentRecord | undefined>;
  listKnowledgeDocuments(): Promise<KnowledgeDocumentRecord[]>;
  deleteKnowledgeDocument(documentId: string): Promise<boolean>;
  replaceKnowledgeChunks(documentId: string, chunks: CreateKnowledgeChunkInput[]): Promise<void>;
  searchKnowledgeChunks(input: SearchKnowledgeChunksInput): Promise<KnowledgeChunkSearchResult[]>;
  appendRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): Promise<StoredAgentEvent | undefined>;
  publishTransientRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): Promise<StoredAgentEvent | undefined>;
  subscribeRun(runId: string, listener: AgentEventListener): () => void;
}
