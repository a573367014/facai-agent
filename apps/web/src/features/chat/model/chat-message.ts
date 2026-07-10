import type {
  AgentProcessStepRecord,
  AgentStreamEvent,
  MessagePart
} from "@/features/chat/api/agent-types";

export type ChatMessageStatus = "running" | "completed" | "failed" | "cancelled";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: MessagePart[];
  status?: ChatMessageStatus;
  version?: number;
  processSteps?: AgentProcessStepRecord[];
  events?: AgentStreamEvent[];
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
}
