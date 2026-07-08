import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LangChainAgentService } from "../../src/langchain/langchain-agent-service.js";
import { S3ToolResourceStorage } from "../../src/agent/tool-resource-storage.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createMockModel } from "../helpers/mock-model.js";
import type {
  AgentLlmCallObservation,
  AgentObservability,
  AgentResourceTransferObservation,
  AgentRunObservation,
  AgentToolCallObservation
} from "../../src/observability/agent-observability.js";
import { createAgentObservability } from "../../src/observability/agent-observability.js";

class RecordingMetricInstrument {
  readonly calls: Array<{ value: number; attributes?: unknown }> = [];

  add(value: number, attributes?: unknown): void {
    this.calls.push({ value, attributes });
  }

  record(value: number, attributes?: unknown): void {
    this.calls.push({ value, attributes });
  }
}

class RecordingMeter {
  readonly created: string[] = [];
  readonly instruments = new Map<string, RecordingMetricInstrument>();

  createCounter(name: string): RecordingMetricInstrument {
    return this.createInstrument(name);
  }

  createHistogram(name: string): RecordingMetricInstrument {
    return this.createInstrument(name);
  }

  private createInstrument(name: string): RecordingMetricInstrument {
    this.created.push(name);
    const instrument = new RecordingMetricInstrument();
    this.instruments.set(name, instrument);
    return instrument;
  }
}

class RecordingObservability implements AgentObservability {
  readonly runs: AgentRunObservation[] = [];
  readonly llmCalls: AgentLlmCallObservation[] = [];
  readonly toolCalls: AgentToolCallObservation[] = [];
  readonly resourceTransfers: AgentResourceTransferObservation[] = [];

  recordRun(observation: AgentRunObservation): void {
    this.runs.push(observation);
  }

  recordLlmCall(observation: AgentLlmCallObservation): void {
    this.llmCalls.push(observation);
  }

  recordToolCall(observation: AgentToolCallObservation): void {
    this.toolCalls.push(observation);
  }

  recordResourceTransfer(observation: AgentResourceTransferObservation): void {
    this.resourceTransfers.push(observation);
  }
}

describe("Agent observability hooks", () => {
  it("creates OTel instruments lazily on first observation", () => {
    const meter = new RecordingMeter();
    const observability = createAgentObservability({
      meterFactory: () => meter as never
    });

    expect(meter.created).toEqual([]);

    observability.recordToolCall({
      toolName: "generate_image",
      status: "succeeded",
      durationMs: 123
    });

    expect(meter.created).toContain("agent_tool_call_total");
    expect(meter.instruments.get("agent_tool_call_total")?.calls).toEqual([
      expect.objectContaining({
        value: 1,
        attributes: expect.objectContaining({
          "agent.status": "succeeded",
          "tool.name": "generate_image"
        })
      })
    ]);
  });

  it("records tool execution status, duration, and correlation ids", async () => {
    const observability = new RecordingObservability();
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "Echo input",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      },
      argumentSchema: z.object({ text: z.string().min(1) }),
      execute: async (args) => ({ text: args.text })
    });
    const executor = new ToolExecutor({ registry, timeoutMs: 100, observability });

    await executor.execute({
      toolName: "echo",
      toolCallId: "call_1",
      messageId: "msg_1",
      sessionId: "session_1",
      arguments: { text: "hi" }
    });

    expect(observability.toolCalls).toEqual([
      expect.objectContaining({
        toolName: "echo",
        toolCallId: "call_1",
        messageId: "msg_1",
        sessionId: "session_1",
        status: "succeeded",
        durationMs: expect.any(Number)
      })
    ]);
  });

  it("records LLM stream calls with iteration and model metadata", async () => {
    const observability = new RecordingObservability();
    const registry = new ToolRegistry();
    const agent = new LangChainAgentService({
      model: createMockModel([{ content: "hello" }]),
      toolRegistry: registry,
      toolExecutor: new ToolExecutor({ registry, timeoutMs: 100, observability }),
      defaultMaxIterations: 2,
      observability
    });

    await agent.run({
      input: "hi",
      sessionId: "session_1",
      messageId: "msg_1"
    });

    expect(observability.llmCalls).toEqual([
      expect.objectContaining({
        sessionId: "session_1",
        messageId: "msg_1",
        iteration: 0,
        provider: "openai-compatible",
        model: "unknown",
        mode: "tool_bound",
        status: "succeeded",
        durationMs: expect.any(Number)
      })
    ]);
  });

  it("records S3 resource transfer success with resource type and bytes", async () => {
    const observability = new RecordingObservability();
    const imageBuffer = Buffer.from("generated image bytes");
    const storage = new S3ToolResourceStorage({
      observability,
      bucket: "agent-uploads",
      s3Client: { send: async () => ({}) },
      objectUrlFactory: (key) => `https://assets.example.com/agent-uploads/${key}`,
      fetchImpl: async () =>
        new Response(imageBuffer, {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(imageBuffer.length) }
        })
    });

    await storage.storeRemoteResource({
      url: "https://example.com/generated.png",
      type: "image",
      mime: "image/png"
    });

    expect(observability.resourceTransfers).toEqual([
      expect.objectContaining({
        resourceType: "image",
        mime: "image/png",
        status: "succeeded",
        bytes: imageBuffer.length,
        durationMs: expect.any(Number)
      })
    ]);
  });
});
