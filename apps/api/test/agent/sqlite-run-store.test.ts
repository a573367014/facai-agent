import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../../src/agent/agent-service.js";
import { SqliteAgentRunStore } from "../../src/agent/sqlite-run-store.js";
import { buildApp } from "../../src/app.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";

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

describe("SqliteAgentRunStore", () => {
  it("重新创建 store 后仍能读回 session、run 和 events", async () => {
    const databasePath = createTempDatabasePath();
    const firstStore = await SqliteAgentRunStore.create({ databasePath, answerChunkCharLimit: 4 });
    const session = firstStore.createSession("测试会话");
    const run = firstStore.createRun({
      sessionId: session.id,
      input: "生成一句话",
      maxIterations: 4
    });

    firstStore.appendEvent(run.id, { type: "iteration_start", iteration: 0 });
    firstStore.appendEvent(run.id, { type: "answer_delta", iteration: 0, delta: "你好" });
    firstStore.appendEvent(run.id, { type: "answer_delta", iteration: 0, delta: "世界" });
    firstStore.appendEvent(run.id, { type: "final_answer", answer: "你好世界", steps: [] });
    firstStore.completeRun(run.id, { answer: "你好世界", steps: [] });
    firstStore.close();

    const secondStore = await SqliteAgentRunStore.create({ databasePath, answerChunkCharLimit: 4 });
    const storedEvents = secondStore.getEvents(run.id);

    expect(secondStore.getSession(session.id)).toMatchObject({
      id: session.id,
      title: "测试会话"
    });
    expect(secondStore.getRun(run.id)).toMatchObject({
      id: run.id,
      sessionId: session.id,
      input: "生成一句话",
      status: "completed",
      answer: "你好世界",
      steps: []
    });
    expect(storedEvents.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(storedEvents.every((event) => event.id.startsWith("event_"))).toBe(true);
    expect(new Set(storedEvents.map((event) => event.id)).size).toBe(storedEvents.length);
    expect(storedEvents.map((event) => event.event)).toEqual([
      { type: "iteration_start", iteration: 0 },
      { type: "answer_chunk", iteration: 0, text: "你好世界" },
      { type: "final_answer", answer: "你好世界", steps: [] }
    ]);
    secondStore.close();
  });

  it("应用配置为 sqlite 时会把会话写入 SQLite 文件", async () => {
    const databasePath = createTempDatabasePath();
    const previousStore = process.env.AGENT_STORE;
    const previousDatabasePath = process.env.AGENT_SQLITE_PATH;
    process.env.AGENT_STORE = "sqlite";
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

      const store = await SqliteAgentRunStore.create({ databasePath });
      expect(store.getSession(payload.session.id)).toMatchObject({
        id: payload.session.id,
        title: "SQLite 会话"
      });
      store.close();
    } finally {
      if (previousStore === undefined) {
        delete process.env.AGENT_STORE;
      } else {
        process.env.AGENT_STORE = previousStore;
      }

      if (previousDatabasePath === undefined) {
        delete process.env.AGENT_SQLITE_PATH;
      } else {
        process.env.AGENT_SQLITE_PATH = previousDatabasePath;
      }
    }
  });
});
