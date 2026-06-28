import type { JsonObject, ToolDefinition } from "../tools/types.js";
import type { MessagePart } from "./message-parts.js";

export type { JsonObject, RegisteredTool, ToolDefinition } from "../tools/types.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface AgentExecutionInput {
  input: string;
  parts?: MessagePart[];
  history?: AgentMessage[];
  maxIterations?: number;
  messageId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
}

export interface AgentExecutionResult {
  answer: string;
}

export type AgentState = "thinking" | "calling_tool" | "observing" | "answering" | "done" | "failed";

export interface AgentErrorDetail {
  code: string;
  message: string;
  // recoverable 表示“这不是系统终止级错误，LLM 还有机会根据错误观察继续回复或改参重试”。
  // 例如参数不合法、积分不足适合 recoverable=true；数据库挂了、工具内部异常通常是 false。
  recoverable?: boolean;
}

export interface AgentMessageSnapshot {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  status: "running" | "completed" | "failed" | "cancelled";
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

export type AgentStreamEvent =
  | { type: "iteration_start"; iteration: number }
  | { type: "iteration_end"; iteration: number; outcome: "tool_calls" | "final_answer" }
  | { type: "agent_state"; iteration: number; state: AgentState; label: string }
  | { type: "llm_start"; iteration: number }
  | { type: "session.message.created"; message: AgentMessageSnapshot }
  | { type: "session.message.updated"; message: AgentMessageSnapshot }
  | { type: "message.part.created"; messageId: string; partIndex: number; part: MessagePart }
  | { type: "message.part.delta"; messageId: string; partIndex: number; delta: string }
  | { type: "message.part.updated"; messageId: string; partIndex: number; part: MessagePart }
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
  | { type: "llm_response"; iteration: number; content?: string; toolCalls?: ToolCall[] }
  | { type: "tool_call_ready"; iteration: number; toolCallId: string; toolName: string; arguments: JsonObject }
  | { type: "tool_start"; iteration: number; toolCallId?: string; toolName: string; arguments: JsonObject }
  | { type: "tool_progress"; iteration: number; toolCallId?: string; toolName: string; progress: JsonObject }
  | { type: "tool_result"; iteration: number; toolCallId?: string; toolName: string; result: unknown; durationMs?: number }
  | { type: "tool_error"; iteration: number; toolCallId?: string; toolName: string; durationMs?: number; error: AgentErrorDetail }
  | { type: "cancelled"; reason?: string }
  | { type: "final_answer"; answer: string }
  | { type: "run_completed"; messageId: string }
  | { type: "error"; code: string; message: string };
