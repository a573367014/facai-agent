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
