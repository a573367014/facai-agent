/**
 * CORS 来源检查器。
 *
 * 职责：决定一个请求 Origin 是否被允许跨域访问本 API，是浏览器同源策略的守门人。
 * 边界：只判断「Origin 是否放行」，不处理 CORS 预检的响应头拼接、不处理凭证策略——
 * 那些由 Fastify CORS 插件在拿到本检查器的结果后统一完成。
 * 安全考量：CORS 是浏览器安全边界，绝不能为图方便放开 "*"——带凭证的请求下 "*"
 * 会被浏览器拒绝，且任意网页都能调用本 API 会造成 CSRF 风险。因此采用「显式白名单优先，
 * 无白名单时仅放行本地开发地址」的策略。
 */
/**
 * 把配置的 Origin 字符串归一化为 URL.origin 形式（scheme + host + port）。
 *
 * 为什么要归一化：用户配置白名单时可能带尾斜杠、带路径、大小写不一，
 * 直接字符串比对会导致 "https://a.com" 与 "https://a.com/" 判为不同来源。
 * 用 URL.origin 统一去掉路径、保留 scheme+host+port，比对才可靠。
 * 非法 URL 返回 undefined：配置笔误时不应让畸形 Origin 通过校验。
 */
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

/**
 * 判断 IPv4 主机名是否属于私有/环回地址段。
 *
 * 覆盖 RFC1918 私有段（10.x、172.16-31.x、192.168.x）、环回段（127.x）、
 * 链路本地段（169.254.x）。这些地址段在公网不可路由，仅用于本地/内网，
 * 因此在「无白名单」兜底模式下视为可信开发来源。
 * 不用 net.isIP / ipaddr 库：只做 IPv4 四段数字解析，足够且零依赖；
 * IPv6 的本地判断在 isLocalDevelopmentOrigin 中用 "::1" 字面量处理。
 */
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

/**
 * 判断一个 Origin 是否属于本地开发环境（localhost / 环回 / 私有网段）。
 *
 * 这是「未配置 CORS_ORIGINS」时的兜底策略：开发阶段前端常从 localhost:5173 等
 * 地址访问 API，没有白名单时若不放行会被浏览器拦截。但只放行本地地址，
 * 避免生产环境误装时裸奔。先校验协议必须是 http/https：防止 file://、chrome-extension:// 等
 * 非网络协议绕过判断。
 */
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

/**
 * 创建一个 CORS Origin 检查器函数。
 *
 * 返回一个闭包而非直接判断：白名单在创建时一次性归一化并冻结进 Set，
 * 后续每次请求只需 O(1) 查询，避免重复解析 URL。无 origin 时返回 true：
 * 同源请求或非浏览器客户端不带 Origin 头，此时不涉及跨域，应予放行。
 */
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
