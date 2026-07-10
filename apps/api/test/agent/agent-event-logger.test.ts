import { SeverityNumber, type LogRecord } from "@opentelemetry/api-logs";
import { describe, expect, it } from "vitest";
import { OtelAgentEventLogger } from "../../src/modules/agent/agent-event-logger.js";
import type { StoredAgentEvent } from "../../src/modules/agent/agent-store.js";

class RecordingOtelLogger {
  readonly records: LogRecord[] = [];

  emit(record: LogRecord): void {
    this.records.push(record);
  }
}

describe("OtelAgentEventLogger", () => {
  it("emits structured agent events to OpenTelemetry logs", () => {
    const logger = new RecordingOtelLogger();
    const event: StoredAgentEvent = {
      id: "event_1",
      runId: "run_1",
      messageId: "msg_1",
      createdAt: "2026-07-08T12:00:00.000Z",
      event: {
        type: "tool_result",
        iteration: 1,
        toolCallId: "call_1",
        toolName: "calculator",
        result: { value: 42 },
        durationMs: 12
      }
    };

    new OtelAgentEventLogger({ logger }).log(event);

    expect(logger.records).toEqual([
      expect.objectContaining({
        eventName: "agent.event",
        timestamp: new Date(event.createdAt),
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        body: {
          kind: "agent_event",
          eventType: "tool_result",
          event: event.event
        },
        attributes: expect.objectContaining({
          "event.kind": "agent_event",
          "event.type": "tool_result",
          "agent.run_id": "run_1",
          "agent.message_id": "msg_1",
          "tool.call_id": "call_1",
          "tool.name": "calculator",
          "tool.duration_ms": 12
        })
      })
    ]);
  });

  it("marks failed agent events as error logs", () => {
    const logger = new RecordingOtelLogger();
    const event: StoredAgentEvent = {
      id: "event_2",
      runId: "run_1",
      messageId: "msg_1",
      createdAt: "2026-07-08T12:00:01.000Z",
      event: {
        type: "tool_error",
        iteration: 1,
        toolCallId: "call_1",
        toolName: "calculator",
        durationMs: 8,
        error: {
          code: "TOOL_FAILED",
          message: "boom"
        }
      }
    };

    new OtelAgentEventLogger({ logger }).log(event);

    expect(logger.records[0]).toEqual(
      expect.objectContaining({
        severityNumber: SeverityNumber.ERROR,
        severityText: "ERROR",
        attributes: expect.objectContaining({
          "event.type": "tool_error",
          "error.code": "TOOL_FAILED",
          "error.message": "boom"
        })
      })
    );
  });
});
