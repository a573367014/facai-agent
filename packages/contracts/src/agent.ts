import type { JsonObject, PageInfo } from "./common.js";
import type { MessagePart, ResourcePart } from "./messages.js";

export type AgentMessageRole = "user" | "assistant" | "system";
export type AgentMessageStatus = "running" | "completed" | "failed" | "cancelled";
export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";
export type AgentRunPhase = "compressing" | "answering" | "completed" | "failed" | "cancelled";
export type AgentResourceStatus = "pending" | "succeeded" | "failed";
export type AgentProcessStepKind = "thinking" | "tool" | "resource" | "summary" | "error";
export type AgentProcessStepStatus = "running" | "succeeded" | "failed" | "cancelled";
export type AgentState = "thinking" | "calling_tool" | "observing" | "answering" | "done" | "failed";

export interface AgentErrorDetail {
  code: string;
  message: string;
  recoverable?: boolean;
}

export interface AgentSessionDto {
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

export interface AgentSessionSummaryDto {
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

export interface AgentMessageDto {
  id: string;
  sessionId: string;
  role: AgentMessageRole;
  status: AgentMessageStatus;
  parts: MessagePart[];
  maxIterations?: number;
  error?: Pick<AgentErrorDetail, "code" | "message">;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentRunDto {
  id: string;
  sessionId: string;
  status: AgentRunStatus;
  phase: AgentRunPhase;
  userMessageId: string;
  systemMessageId?: string;
  assistantMessageId?: string;
  error?: Pick<AgentErrorDetail, "code" | "message">;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentResourceDto {
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

export interface AgentProcessStepDto {
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

export interface ToolCallPayload {
  id: string;
  name: string;
  arguments: JsonObject;
}

export type AgentStreamEvent =
  | { type: "iteration_start"; iteration: number }
  | { type: "iteration_end"; iteration: number; outcome: "tool_calls" | "final_answer" }
  | { type: "agent_state"; iteration: number; state: AgentState; label: string }
  | { type: "llm_start"; iteration: number }
  | { type: "session.message.created"; message: AgentMessageDto }
  | { type: "session.message.updated"; message: AgentMessageDto }
  | {
      type: "message.snapshot";
      message: AgentMessageDto;
      resources: AgentResourceDto[];
      processSteps?: AgentProcessStepDto[];
      version?: number;
    }
  | { type: "message.part.created"; messageId: string; partIndex: number; part: MessagePart; version?: number }
  | { type: "message.part.delta"; messageId: string; partIndex: number; delta: string; version?: number }
  | { type: "message.part.updated"; messageId: string; partIndex: number; part: MessagePart; version?: number }
  | { type: "resource.created"; resource: AgentResourceDto }
  | { type: "resource.updated"; resource: AgentResourceDto }
  | { type: "process.step.created"; step: AgentProcessStepDto }
  | { type: "process.step.updated"; step: AgentProcessStepDto }
  | {
      type: "summary_start";
      sessionId: string;
      messageId: string;
      uncoveredMessageCount: number;
      summarizedMessageCount: number;
    }
  | {
      type: "summary_completed";
      sessionId: string;
      messageId: string;
      uncoveredMessageCount: number;
      summarizedMessageCount: number;
      coveredMessageId: string;
      durationMs: number;
    }
  | {
      type: "summary_failed";
      sessionId: string;
      messageId: string;
      uncoveredMessageCount: number;
      summarizedMessageCount: number;
      durationMs: number;
      error: AgentErrorDetail;
    }
  | { type: "answer_delta"; iteration: number; delta: string }
  | { type: "llm_response"; iteration: number; content?: string; toolCalls?: ToolCallPayload[] }
  | { type: "tool_call_ready"; iteration: number; toolCallId: string; toolName: string; arguments: JsonObject }
  | { type: "tool_start"; iteration: number; toolCallId?: string; toolName: string; arguments: JsonObject }
  | { type: "tool_progress"; iteration: number; toolCallId?: string; toolName: string; progress: JsonObject }
  | { type: "tool_result"; iteration: number; toolCallId?: string; toolName: string; result: unknown; durationMs?: number }
  | { type: "tool_error"; iteration: number; toolCallId?: string; toolName: string; durationMs?: number; error: AgentErrorDetail }
  | { type: "cancelled"; reason?: string }
  | { type: "final_answer"; answer: string }
  | { type: "run_completed"; messageId: string }
  | { type: "error"; code: string; message: string };

export interface StoredAgentEventDto {
  id: string;
  messageId?: string;
  runId?: string;
  event: AgentStreamEvent;
  createdAt: string;
  transient?: boolean;
}

export interface StartAgentRunResponse {
  run: AgentRunDto;
  session: AgentSessionDto;
  userMessage: AgentMessageDto;
  traceId?: string;
}

export type RegenerateAgentMessageResponse = StartAgentRunResponse;

export interface AgentSessionResponse {
  session: AgentSessionDto;
  messages: AgentMessageDto[];
  resources?: AgentResourceDto[];
  processSteps?: AgentProcessStepDto[];
  pageInfo?: PageInfo;
  summary?: AgentSessionSummaryDto;
}

export interface AgentSessionMessagesResponse {
  messages: AgentMessageDto[];
  resources?: AgentResourceDto[];
  processSteps?: AgentProcessStepDto[];
  pageInfo: PageInfo;
}

export interface AgentSessionsResponse {
  sessions: AgentSessionDto[];
  pageInfo?: PageInfo;
}

export interface AgentMessageDetailResponse {
  message: AgentMessageDto;
  resources?: AgentResourceDto[];
  processSteps?: AgentProcessStepDto[];
  version?: number;
}

export interface AgentRunDetailResponse {
  run: AgentRunDto;
}

export interface CancelAgentRunResponse {
  run: AgentRunDto;
}

export interface UploadAgentResourceResponse {
  file: ResourcePart;
}
