const sessionIdQueryKey = "sessionId";

export function readSessionIdFromUrl(href = window.location.href): string | undefined {
  const sessionId = new URL(href).searchParams.get(sessionIdQueryKey)?.trim();
  return sessionId || undefined;
}

export function buildSessionUrlPath(href: string, sessionId: string): string | undefined {
  const url = new URL(href);

  if (url.searchParams.get(sessionIdQueryKey) === sessionId) {
    return undefined;
  }

  url.searchParams.set(sessionIdQueryKey, sessionId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function buildClearedSessionUrlPath(
  href: string,
  sessionId?: string
): string | undefined {
  const url = new URL(href);

  if (sessionId && url.searchParams.get(sessionIdQueryKey) !== sessionId) {
    return undefined;
  }

  url.searchParams.delete(sessionIdQueryKey);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function writeSessionIdToUrl(sessionId: string) {
  const path = buildSessionUrlPath(window.location.href, sessionId);

  if (path) {
    window.history.replaceState(window.history.state, "", path);
  }
}

export function clearSessionIdFromUrl(sessionId?: string) {
  const path = buildClearedSessionUrlPath(window.location.href, sessionId);

  if (path) {
    window.history.replaceState(window.history.state, "", path);
  }
}
