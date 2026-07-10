import { apiBaseUrl } from "@/shared/api/api-base-url";
import { clearAuthSession, readAuthSession, writeAuthSession } from "./auth-session";
import type { AuthSession, AuthTokenPair } from "./auth-types";

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

export async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
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
