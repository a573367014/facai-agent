function normalizeOrigin(origin: string): string | undefined {
  const trimmed = origin.trim();

  if (!trimmed) {
    return undefined;
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
}

function isPrivateOrLoopbackIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));

  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [first, second] = parts;

  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isLocalDevelopmentOrigin(origin: string): boolean {
  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  const hostname = url.hostname.toLowerCase();

  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || isPrivateOrLoopbackIpv4(hostname);
}

export function createCorsOriginChecker(configuredOrigins?: string[]) {
  const allowedOrigins = new Set(configuredOrigins?.map(normalizeOrigin).filter((origin): origin is string => Boolean(origin)));

  // CORS 是浏览器安全边界，不能为了局域网调试直接放开 "*":
  // 有显式 CORS_ORIGINS 时只认白名单；没配时才进入本地开发兜底，
  // 允许 localhost / 127.0.0.1 / 私有网段访问，方便手机或同网段机器调试。
  return (origin?: string) => {
    if (!origin) {
      return true;
    }

    const normalizedOrigin = normalizeOrigin(origin);

    if (!normalizedOrigin) {
      return false;
    }

    if (allowedOrigins.size > 0) {
      return allowedOrigins.has(normalizedOrigin);
    }

    return isLocalDevelopmentOrigin(normalizedOrigin);
  };
}
