import { apiBaseUrl } from "@/shared/api/api-base-url";
import { getApiErrorMessage, type ApiErrorResponse } from "@/shared/api/types";
import { writeAuthSession } from "./auth-session";
import type { AuthSession, GithubLoginResponse } from "./auth-types";

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
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
  }

  const session = payload as GithubLoginResponse;
  writeAuthSession(session);
  return session;
}
