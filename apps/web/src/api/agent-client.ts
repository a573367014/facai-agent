export interface AgentStep {
  type: "tool_call";
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface AgentSessionRecord {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAssetRecord {
  id: string;
  sessionId: string;
  messageId?: string;
  toolCallId?: string;
  type: "image";
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
  prompt?: string;
  index?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AgentMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  status: "running" | "completed" | "failed" | "cancelled";
  content: string;
  maxIterations?: number;
  steps?: AgentStep[];
  error?: {
    code: string;
    message: string;
  };
  assets: AgentAssetRecord[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type AgentState = "thinking" | "calling_tool" | "observing" | "answering" | "done" | "failed";

export interface ToolCallPayload {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AgentStreamEvent =
  | { type: "iteration_start"; iteration: number }
  | { type: "iteration_end"; iteration: number; outcome: "tool_calls" | "final_answer" }
  | { type: "agent_state"; iteration: number; state: AgentState; label: string }
  | { type: "llm_start"; iteration: number }
  | { type: "answer_delta"; iteration: number; delta: string }
  | { type: "answer_chunk"; iteration: number; text: string }
  | { type: "llm_response"; iteration: number; content?: string; toolCalls?: ToolCallPayload[] }
  | { type: "tool_call_ready"; iteration: number; toolCallId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: "tool_start"; iteration: number; toolCallId?: string; toolName: string; arguments: Record<string, unknown> }
  | { type: "tool_progress"; iteration: number; toolCallId?: string; toolName: string; progress: Record<string, unknown> }
  | { type: "tool_result"; iteration: number; toolCallId?: string; toolName: string; result: unknown; durationMs?: number }
  | {
      type: "tool_error";
      iteration: number;
      toolCallId?: string;
      toolName: string;
      durationMs?: number;
      error: { code: string; message: string; recoverable?: boolean };
    }
  | { type: "cancelled"; reason?: string }
  | { type: "final_answer"; answer: string; steps: AgentStep[] }
  | { type: "error"; code: string; message: string };

export interface StoredAgentEvent {
  id: string;
  seq: number;
  messageId: string;
  event: AgentStreamEvent;
  createdAt: string;
}

export interface StartAgentMessageResponse {
  session: AgentSessionRecord;
  userMessage: AgentMessageRecord;
  assistantMessage: AgentMessageRecord;
}

export interface AgentSessionResponse {
  session: AgentSessionRecord;
  messages: AgentMessageRecord[];
}

export interface AgentSessionsResponse {
  sessions: AgentSessionRecord[];
}

export interface AgentMessageDetailResponse {
  message: AgentMessageRecord;
  events: StoredAgentEvent[];
}

export interface CancelAgentMessageResponse {
  message: AgentMessageRecord;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4001";

function parseSseBlock<T>(block: string): T | null {
  const dataLine = block
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:"));

  if (!dataLine) {
    return null;
  }

  return JSON.parse(dataLine.slice("data:".length).trim()) as T;
}

export async function startAgentMessage(
  input: string,
  maxIterations: number,
  sessionId?: string
): Promise<StartAgentMessageResponse> {
  const response = await fetch(`${apiBaseUrl}/agents/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ input, maxIterations, sessionId })
  });

  const payload = (await response.json()) as StartAgentMessageResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as StartAgentMessageResponse;
}

export async function getAgentSession(sessionId: string): Promise<AgentSessionResponse> {
  const response = await fetch(`${apiBaseUrl}/agents/sessions/${sessionId}`);
  const payload = (await response.json()) as AgentSessionResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as AgentSessionResponse;
}

export async function listAgentSessions(): Promise<AgentSessionsResponse> {
  const response = await fetch(`${apiBaseUrl}/agents/sessions`);
  const payload = (await response.json()) as AgentSessionsResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as AgentSessionsResponse;
}

export async function getAgentMessage(messageId: string): Promise<AgentMessageDetailResponse> {
  const response = await fetch(`${apiBaseUrl}/agents/messages/${messageId}`);
  const payload = (await response.json()) as AgentMessageDetailResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as AgentMessageDetailResponse;
}

export async function cancelAgentMessage(messageId: string): Promise<CancelAgentMessageResponse> {
  const response = await fetch(`${apiBaseUrl}/agents/messages/${messageId}/cancel`, {
    method: "POST"
  });
  const payload = (await response.json()) as CancelAgentMessageResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as CancelAgentMessageResponse;
}

export async function streamAgentMessageEvents(
  messageId: string,
  after: number,
  onEvent: (event: StoredAgentEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/agents/messages/${messageId}/events?after=${after}`, {
    signal,
    headers: {
      accept: "text/event-stream"
    }
  });

  if (!response.ok || !response.body) {
    throw new Error("流式请求失败");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const event = parseSseBlock<StoredAgentEvent>(block);
      if (event) {
        onEvent(event);
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parseSseBlock<StoredAgentEvent>(buffer);
    if (event) {
      onEvent(event);
    }
  }
}
