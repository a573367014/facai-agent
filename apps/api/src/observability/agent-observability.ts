import { context, trace, type Attributes, type Counter, type Histogram, type Meter } from "@opentelemetry/api";
import { getMeter } from "./otel.js";

export type AgentObservationStatus = "succeeded" | "completed" | "failed" | "cancelled" | "skipped";

export interface AgentRunObservation {
  runId: string;
  sessionId?: string;
  messageId?: string;
  status: AgentObservationStatus;
  phase?: string;
  durationMs: number;
  errorCode?: string;
}

export interface AgentLlmCallObservation {
  sessionId?: string;
  messageId?: string;
  iteration: number;
  provider: string;
  model: string;
  mode: "tool_bound" | "final" | "summary";
  status: AgentObservationStatus;
  durationMs: number;
  errorCode?: string;
}

export interface AgentToolCallObservation {
  sessionId?: string;
  messageId?: string;
  toolCallId?: string;
  toolName: string;
  status: AgentObservationStatus;
  durationMs: number;
  errorCode?: string;
}

export interface AgentResourceTransferObservation {
  resourceType: "image" | "video" | "document";
  mime?: string;
  status: AgentObservationStatus;
  durationMs: number;
  bytes?: number;
  errorCode?: string;
}

export interface AgentObservability {
  recordRun(observation: AgentRunObservation): void;
  recordLlmCall(observation: AgentLlmCallObservation): void;
  recordToolCall(observation: AgentToolCallObservation): void;
  recordResourceTransfer(observation: AgentResourceTransferObservation): void;
}

export interface CreateAgentObservabilityOptions {
  meterFactory?: () => Meter;
}

interface AgentMetricInstruments {
  runCounter: Counter;
  runDuration: Histogram;
  llmCounter: Counter;
  llmDuration: Histogram;
  toolCounter: Counter;
  toolDuration: Histogram;
  resourceTransferCounter: Counter;
  resourceTransferDuration: Histogram;
  resourceTransferBytes: Histogram;
}

class OtelAgentObservability implements AgentObservability {
  private instruments?: AgentMetricInstruments;

  constructor(private readonly options: CreateAgentObservabilityOptions = {}) {}

  recordRun(observation: AgentRunObservation): void {
    const instruments = this.getInstruments();
    const metricAttrs = compactAttributes({
      "agent.status": observation.status,
      "agent.phase": observation.phase,
      "error.code": observation.errorCode
    });
    const spanAttrs = compactAttributes({
      ...metricAttrs,
      "agent.run_id": observation.runId,
      "agent.session_id": observation.sessionId,
      "agent.message_id": observation.messageId,
      "agent.duration_ms": observation.durationMs
    });

    instruments.runCounter.add(1, metricAttrs);
    instruments.runDuration.record(observation.durationMs, metricAttrs);
    addCurrentSpanEvent("agent.run.completed", spanAttrs);
  }

  recordLlmCall(observation: AgentLlmCallObservation): void {
    const instruments = this.getInstruments();
    const metricAttrs = compactAttributes({
      "agent.status": observation.status,
      "llm.provider": observation.provider,
      "llm.model": observation.model,
      "llm.mode": observation.mode,
      "error.code": observation.errorCode
    });
    const spanAttrs = compactAttributes({
      ...metricAttrs,
      "agent.session_id": observation.sessionId,
      "agent.message_id": observation.messageId,
      "agent.iteration": observation.iteration,
      "llm.duration_ms": observation.durationMs
    });

    instruments.llmCounter.add(1, metricAttrs);
    instruments.llmDuration.record(observation.durationMs, metricAttrs);
    addCurrentSpanEvent("agent.llm_call.completed", spanAttrs);
  }

  recordToolCall(observation: AgentToolCallObservation): void {
    const instruments = this.getInstruments();
    const metricAttrs = compactAttributes({
      "agent.status": observation.status,
      "tool.name": observation.toolName,
      "error.code": observation.errorCode
    });
    const spanAttrs = compactAttributes({
      ...metricAttrs,
      "agent.session_id": observation.sessionId,
      "agent.message_id": observation.messageId,
      "tool.call_id": observation.toolCallId,
      "tool.duration_ms": observation.durationMs
    });

    instruments.toolCounter.add(1, metricAttrs);
    instruments.toolDuration.record(observation.durationMs, metricAttrs);
    addCurrentSpanEvent("agent.tool_call.completed", spanAttrs);
  }

  recordResourceTransfer(observation: AgentResourceTransferObservation): void {
    const instruments = this.getInstruments();
    const metricAttrs = compactAttributes({
      "agent.status": observation.status,
      "resource.type": observation.resourceType,
      "resource.mime": observation.mime,
      "error.code": observation.errorCode
    });
    const spanAttrs = compactAttributes({
      ...metricAttrs,
      "resource.bytes": observation.bytes,
      "resource.duration_ms": observation.durationMs
    });

    instruments.resourceTransferCounter.add(1, metricAttrs);
    instruments.resourceTransferDuration.record(observation.durationMs, metricAttrs);
    if (typeof observation.bytes === "number") {
      instruments.resourceTransferBytes.record(observation.bytes, metricAttrs);
    }
    addCurrentSpanEvent("agent.resource_transfer.completed", spanAttrs);
  }

  private getInstruments(): AgentMetricInstruments {
    if (!this.instruments) {
      const meter = this.options.meterFactory?.() ?? getMeter("agent-runtime");
      this.instruments = {
        runCounter: meter.createCounter("agent_run_total", {
          description: "Agent run completions grouped by status"
        }),
        runDuration: meter.createHistogram("agent_run_duration_ms", {
          description: "Agent run execution duration in milliseconds"
        }),
        llmCounter: meter.createCounter("agent_llm_call_total", {
          description: "LLM calls made by the agent runtime"
        }),
        llmDuration: meter.createHistogram("agent_llm_call_duration_ms", {
          description: "LLM call duration in milliseconds"
        }),
        toolCounter: meter.createCounter("agent_tool_call_total", {
          description: "Tool calls made by the agent runtime"
        }),
        toolDuration: meter.createHistogram("agent_tool_call_duration_ms", {
          description: "Tool call duration in milliseconds"
        }),
        resourceTransferCounter: meter.createCounter("agent_resource_transfer_total", {
          description: "Tool resource transfers to object storage"
        }),
        resourceTransferDuration: meter.createHistogram("agent_resource_transfer_duration_ms", {
          description: "Tool resource transfer duration in milliseconds"
        }),
        resourceTransferBytes: meter.createHistogram("agent_resource_transfer_bytes", {
          description: "Tool resource transfer size in bytes"
        })
      };
    }

    return this.instruments;
  }
}

export function createAgentObservability(options: CreateAgentObservabilityOptions = {}): AgentObservability {
  return new OtelAgentObservability(options);
}

const defaultAgentObservability = createAgentObservability();

export function getAgentObservability(): AgentObservability {
  return defaultAgentObservability;
}

export function toObservationErrorCode(error: unknown, fallback = "UNKNOWN_ERROR"): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) {
      return code;
    }
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return "ABORTED";
  }

  return fallback;
}

function addCurrentSpanEvent(name: string, attributes: Attributes): void {
  const span = trace.getSpan(context.active());
  if (!span) {
    return;
  }

  span.addEvent(name, attributes);
  span.setAttributes(attributes);
}

function compactAttributes(values: Record<string, string | number | boolean | undefined>): Attributes {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
  );
}
