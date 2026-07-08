import { logs, SeverityNumber, type AnyValue, type LogAttributes, type Logger } from "@opentelemetry/api-logs";
import { getCurrentTraceContext } from "../observability/trace-context.js";
import type { AgentStreamEvent } from "./types.js";
import type { StoredAgentEvent } from "./agent-store.js";

export interface AgentEventLogger {
  log(event: StoredAgentEvent): void;
}

export interface OtelAgentEventLoggerOptions {
  logger?: Pick<Logger, "emit">;
}

export class OtelAgentEventLogger implements AgentEventLogger {
  private readonly logger: Pick<Logger, "emit">;

  constructor(options: OtelAgentEventLoggerOptions = {}) {
    this.logger = options.logger ?? logs.getLogger("agent-events");
  }

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

function compactAttributes(attributes: Record<string, AnyValue>): LogAttributes {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null));
}

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

function getSessionId(event: AgentStreamEvent): string | undefined {
  return (
    getStringProperty(event, "sessionId") ??
    getNestedStringProperty(event, "message", "sessionId") ??
    getNestedStringProperty(event, "resource", "sessionId") ??
    getNestedStringProperty(event, "step", "sessionId")
  );
}

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

function getStringProperty(value: object, property: string): string | undefined {
  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

function getNumberProperty(value: object, property: string): number | undefined {
  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "number" ? propertyValue : undefined;
}

function getNestedStringProperty(value: object, nestedProperty: string, property: string): string | undefined {
  const nestedValue = (value as Record<string, unknown>)[nestedProperty];

  if (!nestedValue || typeof nestedValue !== "object") {
    return undefined;
  }

  return getStringProperty(nestedValue, property);
}
