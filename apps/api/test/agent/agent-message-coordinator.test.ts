import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentContextBuilder } from "../../src/agent/context-builder.js";
import { AgentMessageCoordinator } from "../../src/agent/agent-message-coordinator.js";
import { SqliteAgentStore } from "../../src/agent/sqlite-agent-store.js";
import { AgentService } from "../../src/agent/agent-service.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";

let tempDirs: string[] = [];

function createTempDatabasePath() {
  const dir = mkdtempSync(join(tmpdir(), "agent-coordinator-"));
  tempDirs.push(dir);
  return join(dir, "agent.sqlite");
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function waitForMessage(coordinator: AgentMessageCoordinator, messageId: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { message } = coordinator.getMessage(messageId);

    if (message.status !== "running") {
      return message;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("message did not finish in time");
}

function createAgentService(provider: LlmProvider, registry: ToolRegistry) {
  return new AgentService({
    provider,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({ registry, timeoutMs: 100 }),
    defaultMaxIterations: 4
  });
}

describe("AgentMessageCoordinator", () => {
  it("启动同一 session 的新 assistant message 时使用历史 messages 构造上下文", async () => {
    const calls: string[][] = [];
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async ({ messages }) => {
        calls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return { content: `第 ${calls.length} 轮回答` };
      }
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const coordinator = new AgentMessageCoordinator(
      createAgentService(provider, registry),
      store,
      new AgentContextBuilder({ maxHistoryMessages: 2 })
    );

    try {
      const first = coordinator.startMessage({ input: "第一轮问题" });
      await waitForMessage(coordinator, first.assistantMessage.id);
      const second = coordinator.startMessage({ sessionId: first.session.id, input: "第二轮问题" });
      await waitForMessage(coordinator, second.assistantMessage.id);
      const third = coordinator.startMessage({ sessionId: first.session.id, input: "第三轮问题" });
      await waitForMessage(coordinator, third.assistantMessage.id);

      expect(calls[2]).toEqual([
        expect.stringMatching(/^system:/),
        "user:第二轮问题",
        "assistant:第 2 轮回答",
        "user:第三轮问题"
      ]);
    } finally {
      store.close();
    }
  });

  it("图片工具结果会写入 assistant message 的 assets", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "generate_image",
      description: "生成图片",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" }
        },
        required: ["prompt"]
      },
      argumentSchema: z.object({
        prompt: z.string()
      }),
      execute: ({ prompt }) => ({
        provider: "test_image",
        prompt,
        imageUrls: ["https://example.com/pig.png"]
      })
    });
    let callCount = 0;
    const provider: LlmProvider = {
      complete: async () => {
        callCount += 1;

        if (callCount === 1) {
          return {
            toolCalls: [
              {
                id: "call_image",
                name: "generate_image",
                arguments: { prompt: "小猪" }
              }
            ]
          };
        }

        return { content: "图片已生成。" };
      }
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const coordinator = new AgentMessageCoordinator(createAgentService(provider, registry), store);

    try {
      const started = coordinator.startMessage({ input: "生成一张小猪图片" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const session = coordinator.getSession(started.session.id);

      expect(session.messages).toEqual([
        expect.objectContaining({ role: "user", content: "生成一张小猪图片", assets: [] }),
        expect.objectContaining({
          role: "assistant",
          content: "图片已生成。",
          assets: [
            expect.objectContaining({
              type: "image",
              url: "https://example.com/pig.png",
              prompt: "小猪",
              toolCallId: "call_image"
            })
          ]
        })
      ]);
    } finally {
      store.close();
    }
  });
});
