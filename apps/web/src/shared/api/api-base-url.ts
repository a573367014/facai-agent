const defaultApiPort = "4001";

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
