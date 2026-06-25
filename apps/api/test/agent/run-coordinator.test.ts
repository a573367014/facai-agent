import { describe, expect, it } from "vitest";
import { AgentContextBuilder } from "../../src/agent/context-builder.js";
import { AgentRunCoordinator } from "../../src/agent/run-coordinator.js";
import { InMemoryAgentRunStore } from "../../src/agent/run-store.js";
import { AgentService } from "../../src/agent/agent-service.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";

async function waitForRun(coordinator: AgentRunCoordinator, runId: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { run } = coordinator.getRun(runId);

    if (run.status !== "running") {
      return run;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("run did not finish in time");
}

describe("AgentRunCoordinator", () => {
  it("启动同一 session 的新 run 时使用 ContextBuilder 构造历史上下文", async () => {
    const calls: string[][] = [];
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async ({ messages }) => {
        calls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return { content: `第 ${calls.length} 轮回答` };
      }
    };
    const agentService = new AgentService({
      provider,
      toolRegistry: registry,
      toolExecutor: new ToolExecutor({ registry, timeoutMs: 100 }),
      defaultMaxIterations: 4
    });
    const coordinator = new AgentRunCoordinator(
      agentService,
      new InMemoryAgentRunStore(),
      new AgentContextBuilder({ maxCompletedRuns: 1 })
    );

    const first = coordinator.startRun({ input: "第一轮问题" });
    await waitForRun(coordinator, first.run.id);
    const second = coordinator.startRun({ sessionId: first.session.id, input: "第二轮问题" });
    await waitForRun(coordinator, second.run.id);
    const third = coordinator.startRun({ sessionId: first.session.id, input: "第三轮问题" });
    await waitForRun(coordinator, third.run.id);

    expect(calls[2]).toEqual([
      expect.stringMatching(/^system:/),
      "user:第二轮问题",
      "assistant:第 2 轮回答",
      "user:第三轮问题"
    ]);
  });
});
