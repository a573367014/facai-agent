import { apiBaseUrl } from "@/shared/api/api-base-url";
import { getApiErrorMessage, type ApiErrorResponse } from "@/shared/api/types";
import { authenticatedFetch } from "@/features/auth/api/authenticated-fetch";
import type {
  AgentSessionMessagesResponse,
  AgentSessionResponse,
  AgentSessionsResponse
} from "./session-types";

export async function getAgentSession(sessionId: string): Promise<AgentSessionResponse> {
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/sessions/${sessionId}`);
  const payload = (await response.json()) as AgentSessionResponse | ApiErrorResponse;

  if (!response.ok) {
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
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
  const response = await authenticatedFetch(
    `${apiBaseUrl}/agents/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ""}`
  );
  const payload = (await response.json()) as AgentSessionMessagesResponse | ApiErrorResponse;

  if (!response.ok) {
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
  }

  return payload as AgentSessionMessagesResponse;
}

export async function listAgentSessions(
  options: { after?: string; limit?: number } = {}
): Promise<AgentSessionsResponse> {
  const query = new URLSearchParams();

  if (options.after) {
    query.set("after", options.after);
  }

  if (options.limit !== undefined) {
    query.set("limit", String(options.limit));
  }

  const queryString = query.toString();
  const response = await authenticatedFetch(
    `${apiBaseUrl}/agents/sessions${queryString ? `?${queryString}` : ""}`
  );
  const payload = (await response.json()) as AgentSessionsResponse | ApiErrorResponse;

  if (!response.ok) {
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
  }

  return payload as AgentSessionsResponse;
}

export async function deleteAgentSession(sessionId: string): Promise<void> {
  const response = await authenticatedFetch(`${apiBaseUrl}/agents/sessions/${sessionId}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    const errorPayload = (await response.json()) as ApiErrorResponse;
    throw new Error(getApiErrorMessage(errorPayload));
  }
}
