export interface AgentStep {
  type: "tool_call";
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface AgentRunResponse {
  answer: string;
  steps: AgentStep[];
}

export interface AgentSessionRecord {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunRecord {
  id: string;
  sessionId: string;
  input: string;
  maxIterations?: number;
  status: "running" | "completed" | "failed" | "cancelled";
  answer?: string;
  steps?: AgentStep[];
  error?: {
    code: string;
    message: string;
  };
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
  | { type: "llm_response"; iteration: number; content?: string; toolCalls?: ToolCallPayload[] }
  | { type: "tool_call_ready"; iteration: number; toolCallId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: "tool_start"; iteration: number; toolName: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; iteration: number; toolName: string; result: unknown }
  | { type: "tool_error"; iteration: number; toolName: string; error: { code: string; message: string } }
  | { type: "final_answer"; answer: string; steps: AgentStep[] }
  | { type: "error"; code: string; message: string };

export interface StoredAgentEvent {
  id: number;
  runId: string;
  event: AgentStreamEvent;
  createdAt: string;
}

export interface StartAgentRunResponse {
  session: AgentSessionRecord;
  run: AgentRunRecord;
}

export interface AgentSessionResponse {
  session: AgentSessionRecord;
  runs: AgentRunRecord[];
}

export interface AgentRunDetailResponse {
  run: AgentRunRecord;
  events: StoredAgentEvent[];
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4001";

export async function runAgent(input: string, maxIterations: number): Promise<AgentRunResponse> {
  const response = await fetch(`${apiBaseUrl}/agents/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ input, maxIterations })
  });

  const payload = (await response.json()) as AgentRunResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as AgentRunResponse;
}

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

export async function startAgentRun(input: string, maxIterations: number, sessionId?: string): Promise<StartAgentRunResponse> {
  const response = await fetch(`${apiBaseUrl}/agents/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ input, maxIterations, sessionId })
  });

  const payload = (await response.json()) as StartAgentRunResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as StartAgentRunResponse;
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

export async function getAgentRun(runId: string): Promise<AgentRunDetailResponse> {
  const response = await fetch(`${apiBaseUrl}/agents/runs/${runId}`);
  const payload = (await response.json()) as AgentRunDetailResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as AgentRunDetailResponse;
}

export async function streamAgentRunEvents(
  runId: string,
  after: number,
  onEvent: (event: StoredAgentEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/agents/runs/${runId}/events?after=${after}`, {
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

export async function streamAgent(
  input: string,
  maxIterations: number,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/agents/stream`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ input, maxIterations })
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
      const event = parseSseBlock<AgentStreamEvent>(block);
      if (event) {
        onEvent(event);
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parseSseBlock<AgentStreamEvent>(buffer);
    if (event) {
      onEvent(event);
    }
  }
}
