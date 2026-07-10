import type { AuthSession } from "./auth-types";

const authSessionStorageKey = "agent.auth.session";

export const authSessionChangedEvent = "agent-auth-session-changed";

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
