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
    type: "text" | "input" | "select" | "image" | "video" | "document" | "skill";
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

export interface ResourcePart {
  type: "resource";
  mime?: string;
  url?: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  extra?: PartExtra;
}

export type MessagePart = TextPart | ResourcePart;

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

export interface AgentProcessStepRecord {
  id: string;
  sessionId: string;
  runId?: string;
  messageId: string;
  toolCallRowId?: string;
  toolCallId?: string;
  kind: "thinking" | "tool" | "resource" | "summary" | "error";
  title: string;
  summary?: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  orderIndex: number;
  metadata?: Record<string, unknown>;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentPageInfo {
  hasMore: boolean;
  nextCursor?: string;
  limit: number;
}

export type AgentMessagePageInfo = AgentPageInfo;

export type AgentSessionPageInfo = AgentPageInfo;

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
  | {
      type: "message.snapshot";
      message: AgentMessageRecord;
      resources: AgentResourceRecord[];
      processSteps?: AgentProcessStepRecord[];
      version?: number;
    }
  | { type: "message.part.created"; messageId: string; partIndex: number; part: MessagePart; version?: number }
  | { type: "message.part.delta"; messageId: string; partIndex: number; delta: string; version?: number }
  | { type: "message.part.updated"; messageId: string; partIndex: number; part: MessagePart; version?: number }
  | { type: "resource.created"; resource: AgentResourceRecord }
  | { type: "resource.updated"; resource: AgentResourceRecord }
  | { type: "process.step.created"; step: AgentProcessStepRecord }
  | { type: "process.step.updated"; step: AgentProcessStepRecord }
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
  messageId?: string;
  runId?: string;
  event: AgentStreamEvent;
  createdAt: string;
  transient?: boolean;
}

export interface StartAgentRunResponse {
  run: AgentRunRecord;
  session: AgentSessionRecord;
  userMessage: AgentMessageRecord;
  traceId?: string;
}

export interface RegenerateAgentMessageResponse {
  run: AgentRunRecord;
  session: AgentSessionRecord;
  userMessage: AgentMessageRecord;
  traceId?: string;
}

export interface AgentSessionResponse {
  session: AgentSessionRecord;
  messages: AgentMessageRecord[];
  resources?: AgentResourceRecord[];
  processSteps?: AgentProcessStepRecord[];
  pageInfo?: AgentMessagePageInfo;
  summary?: AgentSessionSummaryRecord;
}

export interface AgentSessionMessagesResponse {
  messages: AgentMessageRecord[];
  resources?: AgentResourceRecord[];
  processSteps?: AgentProcessStepRecord[];
  pageInfo: AgentMessagePageInfo;
}

export interface AgentSessionsResponse {
  sessions: AgentSessionRecord[];
  pageInfo?: AgentSessionPageInfo;
}

export interface AgentMessageDetailResponse {
  message: AgentMessageRecord;
  resources?: AgentResourceRecord[];
  processSteps?: AgentProcessStepRecord[];
  version?: number;
}

export interface AgentRunDetailResponse {
  run: AgentRunRecord;
}

export interface CancelAgentRunResponse {
  run: AgentRunRecord;
}

export interface UploadAgentImageResponse {
  file: ResourcePart;
}

export type KnowledgeDocumentStatus = "pending" | "indexing" | "ready" | "failed";

export interface KnowledgeDocumentRecord {
  id: string;
  name: string;
  mimeType: string;
  sourcePath: string;
  status: KnowledgeDocumentStatus;
  errorMessage?: string;
  contentHash: string;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
  indexedAt?: string;
}

export interface KnowledgeSearchResult {
  content: string;
  source: string;
  score: number;
  documentId: string;
  chunkId: string;
  documentName: string;
}

export interface KnowledgeDocumentsResponse {
  documents: KnowledgeDocumentRecord[];
}

export interface KnowledgeDocumentResponse {
  document: KnowledgeDocumentRecord;
}

export interface KnowledgeSearchResponse {
  results: KnowledgeSearchResult[];
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export interface AuthUser {
  id: string;
  githubId: string;
  githubLogin: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  githubUrl?: string;
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
}

export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
}

export type GithubLoginResponse = AuthSession;

const defaultApiPort = "4001";
const authSessionStorageKey = "agent.auth.session";
export const authSessionChangedEvent = "agent-auth-session-changed";

export function resolveApiBaseUrl(configuredBaseUrl?: string, pageHref = window.location.href): string {
  const pageUrl = new URL(pageHref);
  const configured = configuredBaseUrl?.trim();

  // 前端可能跑在 localhost，也可能通过局域网 IP 打开。
  // 如果配置里写的是 localhost，但页面不是 localhost，就自动替换成当前页面 hostname，方便手机/其他设备调试。
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

export function readAuthSession(): AuthSession | undefined {
  try {
    const value = localStorage.getItem(authSessionStorageKey);

    if (!value) {
      return undefined;
    }

    const session = JSON.parse(value) as Partial<AuthSession>;

    if (
      !session.user ||
      typeof session.accessToken !== "string" ||
      typeof session.refreshToken !== "string" ||
      typeof session.user.id !== "string" ||
      typeof session.user.githubId !== "string" ||
      typeof session.user.githubLogin !== "string"
    ) {
      return undefined;
    }

    return session as AuthSession;
  } catch {
    return undefined;
  }
}

export function writeAuthSession(session: AuthSession): void {
  localStorage.setItem(authSessionStorageKey, JSON.stringify(session));
  window.dispatchEvent(new Event(authSessionChangedEvent));
}

export function clearAuthSession(): void {
  localStorage.removeItem(authSessionStorageKey);
  window.dispatchEvent(new Event(authSessionChangedEvent));
}

export function getGithubAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function loginWithGithubCode(input: { code: string; redirectUri?: string }): Promise<AuthSession> {
  const response = await fetch(`${apiBaseUrl}/auth/github/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });
  const payload = (await response.json()) as GithubLoginResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  const session = payload as GithubLoginResponse;
  writeAuthSession(session);
  return session;
}

async function refreshAuthSession(): Promise<AuthSession | undefined> {
  const currentSession = readAuthSession();

  if (!currentSession) {
    return undefined;
  }

  const response = await fetch(`${apiBaseUrl}/auth/refresh`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ refreshToken: currentSession.refreshToken })
  });

  if (!response.ok) {
    clearAuthSession();
    return undefined;
  }

  const tokenPair = (await response.json()) as AuthTokenPair;
  const nextSession: AuthSession = {
    ...currentSession,
    ...tokenPair
  };
  writeAuthSession(nextSession);
  return nextSession;
}

async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const firstResponse = await fetch(input, withAuthHeader(init));

  if (firstResponse.status !== 401 || !readAuthSession()) {
    return firstResponse;
  }

  const refreshedSession = await refreshAuthSession();

  if (!refreshedSession) {
    return firstResponse;
  }

  return fetch(input, withAuthHeader(init, refreshedSession.accessToken));
}

function withAuthHeader(init?: RequestInit, accessToken = readAuthSession()?.accessToken): RequestInit | undefined {
  if (!accessToken) {
    return init;
  }

  return {
    ...init,
    headers: {
      ...headersToObject(init?.headers),
      authorization: `Bearer ${accessToken}`
    }
  };
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
}

// W3C traceparent 响应头格式：00-{traceId(32hex)}-{spanId(16hex)}-{traceFlags(2hex)}
// 解析出中间的 traceId，用于去 Jaeger/SigNoz 搜索完整链路。
// 后端 OTel 未启用或未采样时不会返回该头，此时返回 undefined，调用方不应假设它一定存在。
export function parseTraceId(traceparent: string | null): string | undefined {
  if (!traceparent) {
    return undefined;
  }

  const parts = traceparent.split("-");
  // 格式：version-traceId-spanId-flags，共 4 段，traceId 是第 2 段（32 位 hex）
  if (parts.length !== 4 || parts[1].length !== 32) {
    return undefined;
  }

  return parts[1];
}

function parseSseBlock<T>(block: string): T | null {
  // 后端 SSE 每个事件块形如：
  // data: {"id":"event_live_...","event":...}
  // 这里先只解析 data 行，event/id/retry 这些字段当前业务不依赖。
  const dataLine = block
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:"));

  if (!dataLine) {
    return null;
  }

  return JSON.parse(dataLine.slice("data:".length).trim()) as T;
}

export async function startAgentRun(
  input: string | MessagePart[],
  sessionId?: string
): Promise<StartAgentRunResponse> {
  // 新流程统一从 run 开始：一次用户提交会创建 user message + run，
  // assistant/system 消息由后端执行过程中通过 SSE 逐步推给前端。
  const requestPayload = Array.isArray(input) ? { parts: input, sessionId } : { input, sessionId };
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/runs`, {
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

  const successPayload = payload as StartAgentRunResponse;
  // traceId 来自响应头 traceparent，后端 OTel 未启用时为 undefined。
  // 这里把它附到响应体上，方便调用方按需取用，不必直接读 header。
  successPayload.traceId = parseTraceId(response.headers?.get("traceparent") ?? null);
  return successPayload;
}

export async function regenerateAgentMessage(messageId: string): Promise<RegenerateAgentMessageResponse> {
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/messages/${messageId}/regenerate`, {
    method: "POST"
  });
  const payload = (await response.json()) as RegenerateAgentMessageResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  const successPayload = payload as RegenerateAgentMessageResponse;
  successPayload.traceId = parseTraceId(response.headers?.get("traceparent") ?? null);
  return successPayload;
}

export async function getAgentSession(sessionId: string): Promise<AgentSessionResponse> {
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/sessions/${sessionId}`);
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
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ""}`);
  const payload = (await response.json()) as AgentSessionMessagesResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as AgentSessionMessagesResponse;
}

export async function listAgentSessions(options: { after?: string; limit?: number } = {}): Promise<AgentSessionsResponse> {
  const query = new URLSearchParams();

  if (options.after) {
    query.set("after", options.after);
  }

  if (options.limit !== undefined) {
    query.set("limit", String(options.limit));
  }

  const queryString = query.toString();
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/sessions${queryString ? `?${queryString}` : ""}`);
  const payload = (await response.json()) as AgentSessionsResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as AgentSessionsResponse;
}

export async function deleteAgentSession(sessionId: string): Promise<void> {
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/sessions/${sessionId}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    const errorPayload = (await response.json()) as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }
}

export async function getAgentMessage(messageId: string): Promise<AgentMessageDetailResponse> {
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/messages/${messageId}`);
  const payload = (await response.json()) as AgentMessageDetailResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as AgentMessageDetailResponse;
}

export async function getAgentRun(runId: string): Promise<AgentRunDetailResponse> {
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/runs/${runId}`);
  const payload = (await response.json()) as AgentRunDetailResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as AgentRunDetailResponse;
}

export async function cancelAgentRun(runId: string): Promise<CancelAgentRunResponse> {
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/runs/${runId}/cancel`, {
    method: "POST"
  });
  const payload = (await response.json()) as CancelAgentRunResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as CancelAgentRunResponse;
}

export async function uploadAgentImage(file: File): Promise<ResourcePart> {
  const body = new FormData();
  body.append("image", file);

  const response = await authenticatedFetch(`${apiBaseUrl}/agents/uploads/images`, {
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

export async function listKnowledgeDocuments(): Promise<KnowledgeDocumentRecord[]> {
  const response = await authenticatedFetch(`${apiBaseUrl}/knowledge/documents`);
  const payload = (await response.json()) as KnowledgeDocumentsResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return (payload as KnowledgeDocumentsResponse).documents;
}

export async function uploadKnowledgeDocument(file: File): Promise<KnowledgeDocumentRecord> {
  const body = new FormData();
  body.append("document", file);

  const response = await authenticatedFetch(`${apiBaseUrl}/knowledge/documents/upload`, {
    method: "POST",
    body
  });
  const payload = (await response.json()) as KnowledgeDocumentResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return (payload as KnowledgeDocumentResponse).document;
}

export async function deleteKnowledgeDocument(documentId: string): Promise<void> {
  const response = await authenticatedFetch(`${apiBaseUrl}/knowledge/documents/${documentId}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    const errorPayload = (await response.json()) as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }
}

export async function reindexKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentRecord> {
  const response = await authenticatedFetch(`${apiBaseUrl}/knowledge/documents/${documentId}/reindex`, {
    method: "POST"
  });
  const payload = (await response.json()) as KnowledgeDocumentResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return (payload as KnowledgeDocumentResponse).document;
}

export async function searchKnowledge(query: string, limit = 5): Promise<KnowledgeSearchResult[]> {
  const response = await authenticatedFetch(`${apiBaseUrl}/knowledge/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ query, limit })
  });
  const payload = (await response.json()) as KnowledgeSearchResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return (payload as KnowledgeSearchResponse).results;
}

export async function streamAgentRunEvents(
  runId: string,
  onEvent: (event: StoredAgentEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/runs/${runId}/stream`, {
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

  // fetch reader 每次给的是网络 chunk，不一定刚好等于一个 SSE 事件。
  // 用 buffer 累积文本，只有遇到空行分隔符 \n\n 才把完整事件交给 parseSseBlock。
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
    // 流结束时如果还有最后一个未用 \n\n 结尾的 block，也要补处理一次。
    const event = parseSseBlock<StoredAgentEvent>(buffer);
    if (event) {
      onEvent(event);
    }
  }
}
