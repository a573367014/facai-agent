import { apiBaseUrl } from "@/shared/api/api-base-url";
import { authenticatedFetch } from "@/features/auth/api/authenticated-fetch";
import { getApiErrorMessage, type ApiErrorResponse } from "@/shared/api/types";
import { parseTraceId } from "@/shared/api/tracing";
import { streamSse } from "./sse";
import type {
  AgentMessageDetailResponse,
  AgentRunDetailResponse,
  CancelAgentRunResponse,
  MessagePart,
  RegenerateAgentMessageResponse,
  StartAgentRunResponse,
  StoredAgentEvent
} from "./agent-types";

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
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
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
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
  }

  const successPayload = payload as RegenerateAgentMessageResponse;
  successPayload.traceId = parseTraceId(response.headers?.get("traceparent") ?? null);
  return successPayload;
}

export async function getAgentMessage(messageId: string): Promise<AgentMessageDetailResponse> {
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/messages/${messageId}`);
  const payload = (await response.json()) as AgentMessageDetailResponse | ApiErrorResponse;

  if (!response.ok) {
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
  }

  return payload as AgentMessageDetailResponse;
}

export async function getAgentRun(runId: string): Promise<AgentRunDetailResponse> {
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/runs/${runId}`);
  const payload = (await response.json()) as AgentRunDetailResponse | ApiErrorResponse;

  if (!response.ok) {
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
  }

  return payload as AgentRunDetailResponse;
}

export async function cancelAgentRun(runId: string): Promise<CancelAgentRunResponse> {
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/runs/${runId}/cancel`, {
    method: "POST"
  });
  const payload = (await response.json()) as CancelAgentRunResponse | ApiErrorResponse;

  if (!response.ok) {
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
  }

  return payload as CancelAgentRunResponse;
}

export async function streamAgentRunEvents(
  runId: string,
  onEvent: (event: StoredAgentEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  return streamSse(`${apiBaseUrl}/agents/runs/${runId}/stream`, onEvent, signal);
}
