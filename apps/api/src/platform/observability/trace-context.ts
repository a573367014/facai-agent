/**
 * Trace 上下文管理。
 *
 * 职责：在当前进程内获取/传递 OpenTelemetry trace 上下文，并把它序列化为
 * W3C traceparent 字符串用于跨进程传递（API → Worker、响应头 → 前端 DevTools）。
 * 边界：只管上下文的提取与搬运，不管 span 的业务语义（span 名、属性由调用方设定）、
 * 不负责 OTel SDK 初始化（由 otel 模块完成）。
 * 特殊处理：因 tsx ESM 下 Fastify 自动埋点失效，本模块手动管理请求级 server span，
 * 用 WeakMap 把 span 挂到 request 对象上，绕过对 active context 的依赖。
 */
import { trace, context, TraceFlags, type Span, type SpanContext } from "@opentelemetry/api";

/**
 * 跨进程传递所需的最小 trace 标识。
 *
 * 只带 traceId 和 spanId，不带 traceFlags/isRemote：跨进程传递时由接收方
 * 重新组装完整的 SpanContext（见 runWithParentSpan），这里只是搬运工。
 */
export interface TraceContextCarrier {
  traceId: string;
  spanId: string;
}

const tracer = trace.getTracer("agent-runtime");

/**
 * 获取当前 active span 的 trace 上下文。
 *
 * 返回 null 表示当前没有 active span（OTel 未启用或未采样）。
 * 调用方应将 null 视为「无链路可传递」，不应伪造假 traceId。
 * 注意：此函数依赖 OTel 的 active context 机制，在手动管理 span 的场景
 * （见 getRequestTraceContext）下不可用，需改用 getRequestTraceContext。
 */
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

/**
 * 获取当前 active span 的 traceparent 字符串。
 *
 * 用于在响应头里返回 traceparent，让前端 DevTools 能关联到本次请求的链路。
 * 无 active span 时返回 null，调用方应跳过设置响应头而非写入空值。
 */
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

/**
 * 为一次 Fastify 请求创建 server span 并存入 WeakMap。
 *
 * 在 onRequest 钩子中调用。span 名用 "METHOD /route" 格式，符合 OTel HTTP 语义约定。
 * 不设 active context：故意绕过 context.active() 机制，因为 Fastify 钩子与路由处理
 * 之间的 context 传递在 tsx ESM 下不可靠，改用 WeakMap 显式存取更稳定。
 */
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

/**
 * 取出与 request 关联的 server span，未找到返回 undefined。
 *
 * 用于在 onSend 钩子中获取 span 以构建 traceparent 响应头。
 */
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

/**
 * 结束 request 关联的 server span 并清理 WeakMap。
 *
 * 在 onResponse 钩子中调用。必须调用 span.end()，否则 span 不会被导出，
 * 链路会断在「进行中」状态。delete 清理 WeakMap 条目：虽然 request 被 GC 后
 * 条目会自动消失，但显式删除能让 span 在响应发出后立即落盘，不依赖 GC 时机。
 * 无 span 时静默返回：onResponse 可能在未走 startRequestSpan 的路径上触发。
 */
export function endRequestSpan(request: object, statusCode: number): void {
  const span = requestSpanStore.get(request);
  if (!span) {
    return;
  }

  span.setAttribute("http.status_code", statusCode);
  span.end();
  requestSpanStore.delete(request);
}

/**
 * 从 request 关联的 server span 构建 traceparent 响应头。
 *
 * 与 getRequestTraceContext 走同一条 WeakMap 路径，区别在于这里直接输出
 * W3C traceparent 字符串，供 onSend 钩子写入响应头。
 */
export function getRequestTraceparent(request: object): string | null {
  const span = requestSpanStore.get(request);
  if (!span) {
    return null;
  }

  return buildTraceparent(span.spanContext());
}

/**
 * 在指定父 span 上下文中执行 fn，自动创建并结束子 span。
 *
 * 用途：Worker 进程从队列消息里取出 traceContext 后，用本函数把链路接续起来，
 * 让 Worker 侧的 span 挂在 API 侧的 trace 树下，形成完整跨进程链路。
 * parent 为 null 时直接执行 fn 不创建 span：无链路可接续时不应伪造空 span，
 * 否则会产生孤立的 trace 噪声。isRemote: true 标记此 SpanContext 来自外部进程，
 * OTel 据此正确处理采样决策。finally 中 span.end() 保证异常路径也能结束 span。
 */
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

