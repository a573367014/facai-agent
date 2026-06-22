import type { AgentMessage, ToolCall, ToolDefinition } from "../agent/types.js";

export interface LlmProviderRequest {
  messages: AgentMessage[];
  tools: ToolDefinition[];
}

export interface LlmProviderResponse {
  content?: string;
  toolCalls?: ToolCall[];
}

export type LlmDeltaHandler = (delta: string) => void | Promise<void>;

export interface LlmProvider {
  complete(request: LlmProviderRequest): Promise<LlmProviderResponse>;
  completeStream?(request: LlmProviderRequest, onDelta: LlmDeltaHandler): Promise<LlmProviderResponse>;
}
