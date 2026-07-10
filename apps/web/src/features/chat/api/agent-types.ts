/**
 * Chat's public transport types come from the workspace contract package.
 * Local aliases preserve the UI vocabulary while keeping one source of truth.
 */
export type {
  AgentErrorDetail,
  AgentMessageDto as AgentMessageRecord,
  AgentProcessStepDto as AgentProcessStepRecord,
  AgentResourceDto as AgentResourceRecord,
  AgentRunDto as AgentRunRecord,
  AgentState,
  AgentStreamEvent,
  CancelAgentRunResponse,
  MessagePart,
  PartExtra,
  RegenerateAgentMessageResponse,
  ResourcePart,
  StartAgentRunResponse,
  StoredAgentEventDto as StoredAgentEvent,
  TextPart,
  ToolCallPayload,
  AgentMessageDetailResponse,
  AgentRunDetailResponse
} from "@agent/contracts";
