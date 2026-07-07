import { trace, context, TraceFlags, type Span, type SpanContext } from "@opentelemetry/api";

export interface TraceContextCarrier {
  traceId: string;
  spanId: string;
}

const tracer = trace.getTracer("agent-runtime");

export function getCurrentTraceContext(): TraceContextCarrier | null {
  const span = trace.getSpan(context.active());
  if (!span) {
    return null;
  }

  const ctx = span.spanContext();
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

// W3C traceparent 响应头格式：00-{traceId(32hex)}-{spanId(16hex)}-{traceFlags(2hex)}
// 这是全行业通用的跨进程 trace 传递协议，浏览器 DevTools、CDN、APM 工具都认。
// 前端拿到后可以直接用 traceId 去 Jaeger/SigNoz 搜索链路，建立 runId ↔ traceId 的临时映射。
// 返回 null 表示当前没有 active span（OTel 未启用或未采样），此时不应伪造假的 traceId。
export function buildTraceparent(spanContext: SpanContext): string {
  const traceFlags = spanContext.traceFlags ?? TraceFlags.SAMPLED;
  return `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlags.toString(16).padStart(2, "0")}`;
}

export function getCurrentTraceparent(): string | null {
  const span = trace.getSpan(context.active());
  if (!span) {
    return null;
  }

  return buildTraceparent(span.spanContext());
}

// 手动管理 Fastify 请求 span。
// 背景：@opentelemetry/instrumentation-fastify 依赖 CommonJS 模块 patch（require-in-the-middle），
// 在 tsx 的 ESM loader 下不生效，导致 Fastify 路由没有 server span，onSend 钩子拿不到 traceId。
// 这里用 Fastify 的 onRequest/onResponse 钩子手动创建 server span，把 span 挂到 request 上，
// onSend 时直接从 request 取 spanContext 构建 traceparent，不依赖 active context 的延续。
const requestSpanStore = new WeakMap<object, Span>();

export function startRequestSpan(request: object, routePath: string, method: string): Span {
  const span = tracer.startSpan(`${method} ${routePath}`, {
    attributes: {
      "http.method": method,
      "http.route": routePath,
      "http.target": routePath
    }
  });
  requestSpanStore.set(request, span);
  return span;
}

export function getRequestSpan(request: object): Span | undefined {
  return requestSpanStore.get(request);
}

// 从 request 关联的 server span 取 traceContext，用于跨进程（API → Worker）传递。
// 不能用 getCurrentTraceContext()：它依赖 active context，而 startRequestSpan 为了
// 规避 tsx ESM 下 Fastify 自动埋点失效，故意只把 span 存进 WeakMap、不设 active context。
// 所以这里直接从 WeakMap 取，和 startRequestSpan/endRequestSpan 走同一条路径。
export function getRequestTraceContext(request: object): TraceContextCarrier | null {
  const span = requestSpanStore.get(request);
  if (!span) {
    return null;
  }

  const ctx = span.spanContext();
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

export function endRequestSpan(request: object, statusCode: number): void {
  const span = requestSpanStore.get(request);
  if (!span) {
    return;
  }

  span.setAttribute("http.status_code", statusCode);
  span.end();
  requestSpanStore.delete(request);
}

export function getRequestTraceparent(request: object): string | null {
  const span = requestSpanStore.get(request);
  if (!span) {
    return null;
  }

  return buildTraceparent(span.spanContext());
}

export function runWithParentSpan<T>(
  parent: TraceContextCarrier | null,
  spanName: string,
  fn: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  if (!parent) {
    return fn();
  }

  const spanContext: SpanContext = {
    traceId: parent.traceId,
    spanId: parent.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true
  };
  const parentContext = trace.setSpanContext(context.active(), spanContext);

  return context.with(parentContext, () => {
    return tracer.startActiveSpan(spanName, { attributes }, async (span) => {
      try {
        return await fn();
      } finally {
        span.end();
      }
    });
  });
}

