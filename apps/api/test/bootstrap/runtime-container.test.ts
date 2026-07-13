import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createWorkerRuntimeContainer } from "../../src/bootstrap/runtime-container.js";
import { InMemoryAgentCancellationStore } from "../../src/modules/agent/agent-cancellation-store.js";
import type { AgentEventBus } from "../../src/modules/agent/agent-event-bus.js";
import { InMemoryAgentRunLock } from "../../src/modules/agent/agent-run-lock.js";
import { InMemoryRunningMessageStateStore } from "../../src/modules/agent/running-message-state-store.js";
import { PassthroughToolResourceStorage } from "../../src/modules/agent/tool-resource-storage.js";
import { loadEnv } from "../../src/platform/config/env.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agent_test";

const noopEventBus: AgentEventBus = {
  async publishRunEvent() {},
  async subscribeRun() {
    return () => {};
  }
};

describe("worker runtime container", () => {
  it("creates only the execution runtime and closes it idempotently", async () => {
    const container = await createWorkerRuntimeContainer({
      env: loadEnv({ DATABASE_URL: TEST_DATABASE_URL }),
      logger: { warn() {} },
      uploadDirectory: "./data/test-worker-runtime",
      storageInitialized: true,
      agentService: {
        async run() {
          return { answer: "unused" };
        }
      },
      embeddingService: {
        model: "test-embedding",
        async embedTexts(texts) {
          return texts.map(() => [0, 0, 0]);
        }
      },
      runningStateStore: new InMemoryRunningMessageStateStore(),
      eventBus: noopEventBus,
      cancellationStore: new InMemoryAgentCancellationStore(),
      runLock: new InMemoryAgentRunLock(),
      toolResourceStorage: new PassthroughToolResourceStorage()
    });

    expect(container.coordinator).toBeDefined();
    expect(container.knowledgeIndexingService).toBeDefined();
    expect(container.knowledgeIndexQueue).toBeUndefined();
    expect("inject" in container).toBe(false);

    await expect(container.close("测试关闭")).resolves.toBeUndefined();
    await expect(container.close("重复关闭")).resolves.toBeUndefined();
  });

  it("keeps the worker entrypoint independent from the Fastify app builder", async () => {
    const workerSource = await readFile(new URL("../../src/entrypoints/worker.ts", import.meta.url), "utf8");

    expect(workerSource).not.toContain("bootstrap/app");
    expect(workerSource).not.toMatch(/\bbuildApp\b/);
    expect(workerSource).toContain("createWorkerRuntimeContainer");
  });
});
