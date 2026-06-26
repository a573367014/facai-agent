import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../../src/agent/agent-service.js";
import { SqliteAgentStore } from "../../src/agent/sqlite-agent-store.js";
import { buildApp } from "../../src/app.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { MessagePart } from "../../src/agent/message-parts.js";

let tempDirs: string[] = [];

function createTempDatabasePath() {
  const dir = mkdtempSync(join(tmpdir(), "agent-store-"));
  tempDirs.push(dir);
  return join(dir, "agent.sqlite");
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function createTestAgentService(): AgentService {
  const registry = new ToolRegistry();
  const provider: LlmProvider = {
    complete: async () => ({ content: "测试回答" })
  };
  return new AgentService({
    provider,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({ registry, timeoutMs: 100 }),
    defaultMaxIterations: 4
  });
}

describe("SqliteAgentStore", () => {
  it("重新创建 store 后仍能读回 message parts", async () => {
    const databasePath = createTempDatabasePath();
    const firstStore = await SqliteAgentStore.create({ databasePath });
    const session = firstStore.createSession("parts 会话");
    const parts: MessagePart[] = [{ type: "text", value: "你好" }];
    const message = firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts
    });
    firstStore.close();

    const secondStore = await SqliteAgentStore.create({ databasePath });

    expect(secondStore.getMessage(message.id)?.parts).toEqual(parts);
    secondStore.close();
  });

  it("能单独更新 message parts 且不改变状态", async () => {
    const databasePath = createTempDatabasePath();
    const store = await SqliteAgentStore.create({ databasePath });
    const session = store.createSession("parts 更新");
    const message = store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });

    const updated = store.updateMessageParts(message.id, [{ type: "text", value: "流式文本" }]);

    expect(updated?.status).toBe("running");
    expect(updated?.parts).toEqual([{ type: "text", value: "流式文本" }]);
    store.close();
  });

  it("重新创建 store 后仍能读回 session、messages、assets 和 events", async () => {
    const databasePath = createTempDatabasePath();
    const firstStore = await SqliteAgentStore.create({ databasePath, answerChunkCharLimit: 4 });
    const session = firstStore.createSession("图片会话");
    const userMessage = firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      content: "生成图片"
    });
    const assistantMessage = firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running"
    });

    firstStore.appendEvent(assistantMessage.id, { type: "iteration_start", iteration: 0 });
    firstStore.appendEvent(assistantMessage.id, { type: "answer_delta", iteration: 0, delta: "你好" });
    firstStore.appendEvent(assistantMessage.id, { type: "answer_delta", iteration: 0, delta: "世界" });
    firstStore.appendEvent(assistantMessage.id, { type: "final_answer", answer: "你好世界", steps: [] });
    firstStore.updateMessage(assistantMessage.id, {
      status: "completed",
      content: "你好世界",
      steps: [],
      completedAt: "2026-06-25T00:00:01.000Z"
    });
    firstStore.createAsset({
      sessionId: session.id,
      messageId: assistantMessage.id,
      toolCallId: "call_image",
      type: "image",
      url: "https://example.com/pig.png",
      prompt: "温馨田园小猪",
      index: 0,
      metadata: { provider: "test_image" }
    });
    firstStore.close();

    const secondStore = await SqliteAgentStore.create({ databasePath, answerChunkCharLimit: 4 });
    const storedEvents = secondStore.getEvents(assistantMessage.id);

    expect(secondStore.getSession(session.id)).toMatchObject({
      id: session.id,
      title: "图片会话"
    });
    expect(secondStore.getMessagesBySession(session.id)).toEqual([
      expect.objectContaining({
        id: userMessage.id,
        role: "user",
        status: "completed",
        content: "生成图片"
      }),
      expect.objectContaining({
        id: assistantMessage.id,
        role: "assistant",
        status: "completed",
        content: "你好世界",
        steps: []
      })
    ]);
    expect(secondStore.getAssetsBySession(session.id)).toEqual([
      expect.objectContaining({
        messageId: assistantMessage.id,
        toolCallId: "call_image",
        type: "image",
        url: "https://example.com/pig.png",
        prompt: "温馨田园小猪",
        index: 0,
        metadata: { provider: "test_image" }
      })
    ]);
    expect(storedEvents.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(storedEvents.map((event) => event.messageId)).toEqual([
      assistantMessage.id,
      assistantMessage.id,
      assistantMessage.id
    ]);
    expect(storedEvents.map((event) => event.event)).toEqual([
      { type: "iteration_start", iteration: 0 },
      { type: "answer_chunk", iteration: 0, text: "你好世界" },
      { type: "final_answer", answer: "你好世界", steps: [] }
    ]);
    secondStore.close();
  });

  it("能按更新时间倒序列出持久化会话", async () => {
    const databasePath = createTempDatabasePath();
    const firstStore = await SqliteAgentStore.create({ databasePath });
    const firstSession = firstStore.createSession("旧会话");
    const secondSession = firstStore.createSession("新会话");
    firstStore.createMessage({
      sessionId: firstSession.id,
      role: "user",
      status: "completed",
      content: "更新旧会话"
    });
    firstStore.close();

    const secondStore = await SqliteAgentStore.create({ databasePath });

    expect(secondStore.listSessions().map((session) => session.id)).toEqual([firstSession.id, secondSession.id]);
    secondStore.close();
  });

  it("应用会把会话写入配置的 SQLite 文件", async () => {
    const databasePath = createTempDatabasePath();
    const previousDatabasePath = process.env.AGENT_SQLITE_PATH;
    process.env.AGENT_SQLITE_PATH = databasePath;

    try {
      const app = await buildApp({ agentService: createTestAgentService() });
      const response = await app.inject({
        method: "POST",
        url: "/agents/sessions",
        payload: { title: "SQLite 会话" }
      });
      const payload = response.json() as { session: { id: string } };

      await app.close();

      const store = await SqliteAgentStore.create({ databasePath });
      expect(store.getSession(payload.session.id)).toMatchObject({
        id: payload.session.id,
        title: "SQLite 会话"
      });
      store.close();
    } finally {
      if (previousDatabasePath === undefined) {
        delete process.env.AGENT_SQLITE_PATH;
      } else {
        process.env.AGENT_SQLITE_PATH = previousDatabasePath;
      }
    }
  });
});
