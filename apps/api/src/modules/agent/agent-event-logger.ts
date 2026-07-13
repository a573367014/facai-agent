/**
 * 模块职责：把 Agent 执行过程中的事件桥接到 OpenTelemetry 日志管道。
 *
 * Agent 运行时会产生大量结构化事件（token delta、工具调用、步骤更新、错误等）。
 * 这些事件除了推送给前端（SSE）和写入 JSONL 日志外，还需要进入可观测性系统
 *（如 Jaeger、Loki、Datadog）以便做告警、排查和审计。
 *
 * 本模块的职责边界：
 * - 只做"事件 → OTel LogRecord"的转换和发射，不做存储、不做聚合。
 * - 从事件中提取关键维度（run_id、message_id、session_id、tool_name 等）作为
 *   OTel attributes，让日志可以在可观测性平台里按这些维度过滤和聚合。
 * - 关联当前 trace context，让 agent 事件能和上游请求链路串联。
 */
import { logs, SeverityNumber, type AnyValue, type LogAttributes, type Logger } from "@opentelemetry/api-logs";
import { getCurrentTraceContext } from "../../platform/observability/trace-context.js";
import type { AgentStreamEvent } from "./types.js";
import type { StoredAgentEvent } from "./agent-store.js";

/**
 * Agent 事件日志器契约。
 * 只需要一个 log 方法：接收一个已存储的事件，同步发射到日志管道。
 * 同步而非异步：OTel logger.emit 本身是同步的，且日志不应阻塞主流程。
 */
export interface AgentEventLogger {
  log(event: StoredAgentEvent): void;
}

export interface OtelAgentEventLoggerOptions {
  logger?: Pick<Logger, "emit">;
}

/**
 * 基于 OpenTelemetry Logs API 的事件日志器。
 *
 * 为什么用 OTel 而不是直接 console.log：
 * OTel 是厂商无关的标准，日志会自动关联 trace/span，并且可以通过 OTLP 协议
 * 导出到任意后端（Jaeger、Loki、Datadog 等）。直接 console.log 无法做到这些。
 */
export class OtelAgentEventLogger implements AgentEventLogger {
  private readonly logger: Pick<Logger, "emit">;

  constructor(options: OtelAgentEventLoggerOptions = {}) {
    this.logger = options.logger ?? logs.getLogger("agent-events");
  }

  /**
   * 将一个 Agent 事件转换为 OTel LogRecord 并发射。
   *
   * 转换逻辑分三层：
   * 1. severity：根据事件类型映射到 ERROR/WARN/INFO，让日志平台能按级别过滤；
   * 2. attributes：提取结构化维度（run_id、tool_name 等），用于聚合查询；
   * 3. body：把完整事件对象作为 body，保留原始数据供深度排查。
   *
   * trace context 从当前异步上下文获取，让 agent 事件和上游 HTTP 请求的 trace 串联。
   */
  log(event: StoredAgentEvent): void {
    const traceContext = getCurrentTraceContext();
    const severityNumber = getSeverityNumber(event.event);
    const attributes = compactAttributes({
      "event.kind": "agent_event",
      "event.type": event.event.type,
      "agent.event_id": event.id,
      "agent.run_id": event.runId,
      "agent.message_id": event.messageId,
      "agent.session_id": getSessionId(event.event),
      "agent.iteration": getIteration(event.event),
      "tool.call_id": getToolCallId(event.event),
      "tool.name": getToolName(event.event),
      "tool.duration_ms": getDurationMs(event.event),
      "error.code": getErrorCode(event.event),
      "error.message": getErrorMessage(event.event),
      "trace.id": traceContext?.traceId,
      "span.id": traceContext?.spanId
    });

    this.logger.emit({
      eventName: "agent.event",
      timestamp: new Date(event.createdAt),
      severityNumber,
      severityText: severityNumber === SeverityNumber.ERROR ? "ERROR" : severityNumber === SeverityNumber.WARN ? "WARN" : "INFO",
      body: toAnyValue({
        kind: "agent_event",
        eventType: event.event.type,
        event: event.event
      }),
      attributes
    });
  }
}

/**
 * 根据事件类型映射 OTel 严重级别。
 *
 * 设计原则：错误事件（error/tool_error/summary_failed）→ ERROR；
 * 非正常但非致命（cancelled/步骤失败/资源失败）→ WARN；其余 → INFO。
 * 不做映射的话，所有事件都是默认级别，日志平台无法按"出错了"自动告警。
 */
function getSeverityNumber(event: AgentStreamEvent): SeverityNumber {
  if (event.type === "error" || event.type === "tool_error" || event.type === "summary_failed") {
    return SeverityNumber.ERROR;
  }

  if (
    event.type === "cancelled" ||
    (event.type === "process.step.updated" && event.step.status === "failed") ||
    (event.type === "resource.updated" && event.resource.status === "failed")
  ) {
    return SeverityNumber.WARN;
  }

  return SeverityNumber.INFO;
}

/**
 * 过滤掉 undefined 和 null 的属性。
 *
 * 为什么需要：Agent 事件类型多样，不是每个事件都有 toolName/durationMs 等字段。
 * 如果不过滤，OTel attributes 里会塞满 null 值，既浪费存储又干扰查询过滤。
 */
function compactAttributes(attributes: Record<string, AnyValue>): LogAttributes {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null));
}

/**
 * 把任意 JS 值递归转换为 OTel AnyValue 兼容格式。
 *
 * OTel 的 body/attributes 不接受任意 JS 对象（比如 Date、嵌套对象含函数等）。
 * 这个函数做"归一化"：Date → ISO 字符串、数组递归、对象递归、兜底转字符串。
 * 不做这层转换，某些后端会直接拒绝或丢弃整条日志。
 */
function toAnyValue(value: unknown): AnyValue {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Uint8Array
  ) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => toAnyValue(item));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [key, toAnyValue(nestedValue)])
    );
  }

  return String(value);
}

/**
 * 从事件中提取 sessionId。
 * 不同事件类型把 sessionId 放在不同层级（顶层、message、resource、step），
 * 所以需要逐级尝试，取第一个非空值。
 */
function getSessionId(event: AgentStreamEvent): string | undefined {
  return (
    getStringProperty(event, "sessionId") ??
    getNestedStringProperty(event, "message", "sessionId") ??
    getNestedStringProperty(event, "resource", "sessionId") ??
    getNestedStringProperty(event, "step", "sessionId")
  );
}

/**
 * 从事件中提取 toolCallId（工具调用标识）。
 * 同样需要逐级查找：顶层、resource、step。
 */
function getToolCallId(event: AgentStreamEvent): string | undefined {
  return getStringProperty(event, "toolCallId") ?? getNestedStringProperty(event, "resource", "toolCallId") ?? getNestedStringProperty(event, "step", "toolCallId");
}

function getToolName(event: AgentStreamEvent): string | undefined {
  return getStringProperty(event, "toolName");
}

function getDurationMs(event: AgentStreamEvent): number | undefined {
  return getNumberProperty(event, "durationMs");
}

function getIteration(event: AgentStreamEvent): number | undefined {
  return getNumberProperty(event, "iteration");
}

function getErrorCode(event: AgentStreamEvent): string | undefined {
  return getStringProperty(event, "code") ?? getNestedStringProperty(event, "error", "code");
}

function getErrorMessage(event: AgentStreamEvent): string | undefined {
  return getStringProperty(event, "message") ?? getNestedStringProperty(event, "error", "message");
}

/**
 * 类型安全的字符串属性提取：只有当属性值确实是 string 时才返回，否则 undefined。
 * 避免把 number/boolean 误当 string 传给 OTel attributes。
 */
function getStringProperty(value: object, property: string): string | undefined {
  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

/**
 * 类型安全的数字属性提取：只有当属性值确实是 number 时才返回。
 */
function getNumberProperty(value: object, property: string): number | undefined {
  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "number" ? propertyValue : undefined;
}

/**
 * 从嵌套对象中提取字符串属性。
 * 先取外层对象的 nestedProperty 字段（必须是对象），再从中取 property。
 * 用于处理 resource.step.toolCallId 这种二级路径。
 */
function getNestedStringProperty(value: object, nestedProperty: string, property: string): string | undefined {
  const nestedValue = (value as Record<string, unknown>)[nestedProperty];

  if (!nestedValue || typeof nestedValue !== "object") {
    return undefined;
  }

  return getStringProperty(nestedValue, property);
}
