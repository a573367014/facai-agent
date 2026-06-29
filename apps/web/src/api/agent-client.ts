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

export interface PartExtra {
  placeholder?: {
    type: "text" | "input" | "select" | "image" | "skill";
    label: string;
    defaultValue?: string;
    options?: Array<{ label: string; value: string; icon?: string }>;
    [key: string]: unknown;
  };
  lifecycle?: {
    state: "pending" | "succeeded" | "failed";
    error?: {
      code: string;
      message: string;
    };
  };
  tool?: {
    name: string;
    toolCallId: string;
    toolCallRowId?: string;
    outputIndex?: number;
  };
  resource?: {
    id: string;
  };
  generation?: {
    prompt?: string;
    provider?: string;
    model?: string;
  };
  [key: string]: unknown;
}

export interface TextPart {
  type: "text";
  value: string;
  extra?: PartExtra;
}

export interface MediaPart {
  type: "media";
  mime?: string;
  url?: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  extra?: PartExtra;
}

export type MessagePart = TextPart | MediaPart;

export interface AgentMessageRecord {
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

export interface AgentRunRecord {
  id: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: "compressing" | "answering" | "completed" | "failed" | "cancelled";
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
  status: "pending" | "succeeded" | "failed";
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessagePageInfo {
  hasMore: boolean;
  oldestCursor?: string;
  limit: number;
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
  | { type: "session.message.created"; message: AgentMessageRecord }
  | { type: "session.message.updated"; message: AgentMessageRecord }
  | { type: "message.snapshot"; message: AgentMessageRecord; resources: AgentResourceRecord[]; version?: number }
  | { type: "message.part.created"; messageId: string; partIndex: number; part: MessagePart; version?: number }
  | { type: "message.part.delta"; messageId: string; partIndex: number; delta: string; version?: number }
  | { type: "message.part.updated"; messageId: string; partIndex: number; part: MessagePart; version?: number }
  | { type: "resource.created"; resource: AgentResourceRecord }
  | { type: "resource.updated"; resource: AgentResourceRecord }
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
      error: { code: string; message: string; recoverable?: boolean };
    }
  | { type: "answer_delta"; iteration: number; delta: string }
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
  | { type: "final_answer"; answer: string }
  | { type: "run_completed"; messageId: string }
  | { type: "error"; code: string; message: string };

export interface StoredAgentEvent {
  id: string;
  seq: number;
  messageId?: string;
  runId?: string;
  event: AgentStreamEvent;
  createdAt: string;
  transient?: boolean;
}

export interface StartAgentMessageResponse {
  session: AgentSessionRecord;
  userMessage: AgentMessageRecord;
  assistantMessage: AgentMessageRecord;
}

export interface StartAgentRunResponse {
  run: AgentRunRecord;
  session: AgentSessionRecord;
  userMessage: AgentMessageRecord;
}

export interface RegenerateAgentMessageResponse {
  run: AgentRunRecord;
  session: AgentSessionRecord;
  userMessage: AgentMessageRecord;
}

export interface AgentSessionResponse {
  session: AgentSessionRecord;
  messages: AgentMessageRecord[];
  resources?: AgentResourceRecord[];
  pageInfo?: AgentMessagePageInfo;
  summary?: AgentSessionSummaryRecord;
}

export interface AgentSessionMessagesResponse {
  messages: AgentMessageRecord[];
  resources?: AgentResourceRecord[];
  pageInfo: AgentMessagePageInfo;
}

export interface AgentSessionsResponse {
  sessions: AgentSessionRecord[];
}

export interface AgentMessageDetailResponse {
  message: AgentMessageRecord;
  resources?: AgentResourceRecord[];
  events: StoredAgentEvent[];
  version?: number;
}

export interface AgentRunDetailResponse {
  run: AgentRunRecord;
  events: StoredAgentEvent[];
}

export interface CancelAgentMessageResponse {
  message: AgentMessageRecord;
}

export interface CancelAgentRunResponse {
  run: AgentRunRecord;
}

export interface UploadAgentImageResponse {
  file: MediaPart;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

const defaultApiPort = "4001";

export function resolveApiBaseUrl(configuredBaseUrl?: string, pageHref = window.location.href): string {
  const pageUrl = new URL(pageHref);
  const configured = configuredBaseUrl?.trim();

  if (!configured) {
    return `${pageUrl.protocol}//${pageUrl.hostname}:${defaultApiPort}`;
  }

  if (configured.startsWith("/")) {
    return trimTrailingSlash(configured);
  }

  try {
    const configuredUrl = new URL(configured);

    if (isLoopbackHost(configuredUrl.hostname) && !isLoopbackHost(pageUrl.hostname)) {
      configuredUrl.hostname = pageUrl.hostname;
    }

    return trimTrailingSlash(configuredUrl.toString());
  } catch {
    return trimTrailingSlash(configured);
  }
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}

export const apiBaseUrl = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

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
  input: string | MessagePart[],
  sessionId?: string
): Promise<StartAgentMessageResponse> {
  const requestPayload = Array.isArray(input) ? { parts: input, sessionId } : { input, sessionId };
  const response = await fetch(`${apiBaseUrl}/agents/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(requestPayload)
  });

  const payload = (await response.json()) as StartAgentMessageResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as StartAgentMessageResponse;
}

export async function startAgentRun(
  input: string | MessagePart[],
  sessionId?: string
): Promise<StartAgentRunResponse> {
  const requestPayload = Array.isArray(input) ? { parts: input, sessionId } : { input, sessionId };
  const response = await fetch(`${apiBaseUrl}/agents/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(requestPayload)
  });

  const payload = (await response.json()) as StartAgentRunResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as StartAgentRunResponse;
}

export async function regenerateAgentMessage(messageId: string): Promise<RegenerateAgentMessageResponse> {
  const response = await fetch(`${apiBaseUrl}/agents/messages/${messageId}/regenerate`, {
    method: "POST"
  });
  const payload = (await response.json()) as RegenerateAgentMessageResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as RegenerateAgentMessageResponse;
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

export async function getAgentSessionMessages(
  sessionId: string,
  options: { before?: string; limit?: number } = {}
): Promise<AgentSessionMessagesResponse> {
  const query = new URLSearchParams();

  if (options.before) {
    query.set("before", options.before);
  }

  if (options.limit !== undefined) {
    query.set("limit", String(options.limit));
  }

  const queryString = query.toString();
  const response = await fetch(`${apiBaseUrl}/agents/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ""}`);
  const payload = (await response.json()) as AgentSessionMessagesResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as AgentSessionMessagesResponse;
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

export async function getAgentRun(runId: string): Promise<AgentRunDetailResponse> {
  const response = await fetch(`${apiBaseUrl}/agents/runs/${runId}`);
  const payload = (await response.json()) as AgentRunDetailResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as AgentRunDetailResponse;
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

export async function cancelAgentRun(runId: string): Promise<CancelAgentRunResponse> {
  const response = await fetch(`${apiBaseUrl}/agents/runs/${runId}/cancel`, {
    method: "POST"
  });
  const payload = (await response.json()) as CancelAgentRunResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as CancelAgentRunResponse;
}

export async function uploadAgentImage(file: File): Promise<MediaPart> {
  const body = new FormData();
  body.append("image", file);

  const response = await fetch(`${apiBaseUrl}/agents/uploads/images`, {
    method: "POST",
    body
  });
  const payload = (await response.json()) as UploadAgentImageResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return (payload as UploadAgentImageResponse).file;
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
