import type { ZodTypeAny } from "zod";

export type JsonObject = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
}

export interface RegisteredTool extends ToolDefinition {
  argumentSchema?: ZodTypeAny;
  execute: (args: JsonObject) => Promise<unknown>;
}

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

export interface AgentStep {
  type: "tool_call";
  toolName: string;
  arguments: JsonObject;
  result: unknown;
}

export interface AgentRunInput {
  input: string;
  history?: AgentMessage[];
  maxIterations?: number;
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
}

export interface AgentRunResult {
  answer: string;
  steps: AgentStep[];
}

export type AgentState = "thinking" | "calling_tool" | "observing" | "answering" | "done" | "failed";

export interface AgentErrorDetail {
  code: string;
  message: string;
}

export type AgentStreamEvent =
  | { type: "iteration_start"; iteration: number }
  | { type: "iteration_end"; iteration: number; outcome: "tool_calls" | "final_answer" }
  | { type: "agent_state"; iteration: number; state: AgentState; label: string }
  | { type: "llm_start"; iteration: number }
  | { type: "answer_delta"; iteration: number; delta: string }
  | { type: "llm_response"; iteration: number; content?: string; toolCalls?: ToolCall[] }
  | { type: "tool_call_ready"; iteration: number; toolCallId: string; toolName: string; arguments: JsonObject }
  | { type: "tool_start"; iteration: number; toolName: string; arguments: JsonObject }
  | { type: "tool_result"; iteration: number; toolName: string; result: unknown }
  | { type: "tool_error"; iteration: number; toolName: string; error: AgentErrorDetail }
  | { type: "final_answer"; answer: string; steps: AgentStep[] }
  | { type: "error"; code: string; message: string };
