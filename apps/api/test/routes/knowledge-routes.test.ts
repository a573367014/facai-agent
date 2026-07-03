import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryAgentCancellationStore } from "../../src/agent/agent-cancellation-store.js";
import { InMemoryAgentEventBus } from "../../src/agent/agent-event-bus.js";
import { InMemoryAgentRunLock } from "../../src/agent/agent-run-lock.js";
import type { AgentRunJobPayload, AgentRunQueue } from "../../src/agent/agent-run-queue.js";
import { AgentService } from "../../src/agent/agent-service.js";
import { PostgresAgentStore } from "../../src/agent/postgres-agent-store.js";
import { InMemoryRunningMessageStateStore } from "../../src/agent/running-message-state-store.js";
import { buildApp } from "../../src/app.js";
import type { EmbeddingService } from "../../src/knowledge/embedding-service.js";
import type { KnowledgeIndexJobPayload, KnowledgeIndexQueue } from "../../src/knowledge/knowledge-run-queue.js";
import type { KnowledgeIndexingService } from "../../src/knowledge/indexing-service.js";
import type { KnowledgeDocumentRecord } from "../../src/knowledge/types.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agent_test";

const apps: FastifyInstance[] = [];
const uploadDirs: string[] = [];
let agentStore: PostgresAgentStore;

class NoopAgentRunQueue implements AgentRunQueue {
  async enqueueRun(_payload: AgentRunJobPayload): Promise<void> {}
}

class CapturingKnowledgeIndexQueue implements KnowledgeIndexQueue {
  readonly jobs: KnowledgeIndexJobPayload[] = [];

  async enqueueDocumentIndex(payload: KnowledgeIndexJobPayload): Promise<void> {
    this.jobs.push(payload);
  }
}

class FakeEmbeddingService implements EmbeddingService {
  readonly model = "test-embedding";

  async embedTexts(texts: string[]): Promise<number[][]> {
    return texts.map((text) => (text.includes("请假") ? [1, 0] : [0, 1]));
  }
}

type TestFastifyApp = FastifyInstance & {
  knowledgeIndexingService?: KnowledgeIndexingService;
};

function createMultipartPayload(input: { fieldName: string; fileName: string; contentType: string; content: string | Buffer }) {
  const boundary = `----knowledge-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content);
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${input.fieldName}"; filename="${input.fileName}"\r\n` +
        `Content-Type: ${input.contentType}\r\n\r\n`
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  return {
    payload,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`
    }
  };
}

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

async function buildKnowledgeTestApp(options: { uploadDirectory: string; knowledgeIndexQueue: KnowledgeIndexQueue }) {
  const app = (await buildApp({
    agentService: createTestAgentService(),
    runningStateStore: new InMemoryRunningMessageStateStore(),
    eventBus: new InMemoryAgentEventBus(),
    runQueue: new NoopAgentRunQueue(),
    cancellationStore: new InMemoryAgentCancellationStore(),
    runLock: new InMemoryAgentRunLock(),
    databasePath: TEST_DATABASE_URL,
    uploadDirectory: options.uploadDirectory,
    knowledgeIndexQueue: options.knowledgeIndexQueue,
    embeddingService: new FakeEmbeddingService()
  })) as TestFastifyApp;
  apps.push(app);
  return app;
}

beforeAll(async () => {
  agentStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
});

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }

  await agentStore.reset();

  for (const dir of uploadDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  uploadDirs.length = 0;
});

afterAll(async () => {
  await agentStore.close();
});

describe("knowledge routes", () => {
  it("上传文档后创建 pending 记录并入队索引", async () => {
    const uploadDirectory = mkdtempSync(join(tmpdir(), "knowledge-upload-"));
    uploadDirs.push(uploadDirectory);
    const queue = new CapturingKnowledgeIndexQueue();
    const app = await buildKnowledgeTestApp({ uploadDirectory, knowledgeIndexQueue: queue });
    const multipart = createMultipartPayload({
      fieldName: "document",
      fileName: "员工手册.txt",
      contentType: "text/plain",
      content: "请假需要直属主管审批。"
    });

    const uploadResponse = await app.inject({
      method: "POST",
      url: "/knowledge/documents/upload",
      headers: multipart.headers,
      payload: multipart.payload
    });
    const payload = uploadResponse.json() as { document: KnowledgeDocumentRecord };

    expect(uploadResponse.statusCode).toBe(201);
    expect(payload.document).toMatchObject({
      name: "员工手册.txt",
      mimeType: "text/plain",
      status: "pending",
      chunkCount: 0
    });
    expect(existsSync(payload.document.sourcePath)).toBe(true);
    expect(queue.jobs).toEqual([{ documentId: payload.document.id }]);

    const listResponse = await app.inject({ method: "GET", url: "/knowledge/documents" });
    expect(listResponse.json()).toMatchObject({
      documents: [
        {
          id: payload.document.id,
          status: "pending"
        }
      ]
    });
  });

  it("后台索引完成后搜索接口返回 ready 文档来源", async () => {
    const uploadDirectory = mkdtempSync(join(tmpdir(), "knowledge-upload-"));
    uploadDirs.push(uploadDirectory);
    const queue = new CapturingKnowledgeIndexQueue();
    const app = await buildKnowledgeTestApp({ uploadDirectory, knowledgeIndexQueue: queue });
    const multipart = createMultipartPayload({
      fieldName: "document",
      fileName: "员工手册.txt",
      contentType: "text/plain",
      content: "请假需要直属主管审批。\n报销需要提交发票。"
    });
    const uploadResponse = await app.inject({
      method: "POST",
      url: "/knowledge/documents/upload",
      headers: multipart.headers,
      payload: multipart.payload
    });
    const { document } = uploadResponse.json() as { document: KnowledgeDocumentRecord };

    await app.knowledgeIndexingService?.indexDocument(document.id);

    const listResponse = await app.inject({ method: "GET", url: "/knowledge/documents" });
    expect(listResponse.json()).toMatchObject({
      documents: [
        {
          id: document.id,
          status: "ready",
          chunkCount: 1
        }
      ]
    });

    const searchResponse = await app.inject({
      method: "POST",
      url: "/knowledge/search",
      payload: {
        query: "请假找谁审批？",
        limit: 3
      }
    });
    const searchPayload = searchResponse.json() as { results: Array<{ content: string; source: string; score: number }> };

    expect(searchResponse.statusCode).toBe(200);
    expect(searchPayload.results[0]).toMatchObject({
      content: "请假需要直属主管审批。 报销需要提交发票。",
      source: "员工手册.txt #1",
      score: 1
    });
  });
});
