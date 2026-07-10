import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryAgentCancellationStore } from "../../src/agent/agent-cancellation-store.js";
import type { AgentEventBus } from "../../src/agent/agent-event-bus.js";
import { InMemoryAgentRunLock } from "../../src/agent/agent-run-lock.js";
import type { AgentRunJobPayload, AgentRunQueue } from "../../src/agent/agent-run-queue.js";
import { LangChainAgentService } from "../../src/langchain/langchain-agent-service.js";
import { PostgresAgentStore } from "../../src/agent/postgres-agent-store.js";
import { InMemoryRunningMessageStateStore } from "../../src/agent/running-message-state-store.js";
import { buildApp } from "../../src/app.js";
import { AuthTokenService } from "../../src/auth/auth-token-service.js";
import type { GithubOAuthClient } from "../../src/auth/github-oauth-client.js";
import { InMemoryUserStore } from "../../src/auth/user-store.js";
import type { EmbeddingService } from "../../src/knowledge/embedding-service.js";
import type { KnowledgeIndexJobPayload, KnowledgeIndexQueue } from "../../src/knowledge/knowledge-run-queue.js";
import type { KnowledgeIndexingService } from "../../src/knowledge/indexing-service.js";
import type { KnowledgeDocumentRecord } from "../../src/knowledge/types.js";
import { createMockModel } from "../helpers/mock-model.js";
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

class UnusedGithubOAuthClient implements GithubOAuthClient {
  async getUserProfile(): Promise<never> {
    throw new Error("GitHub OAuth client should not be used by knowledge authorization tests");
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

function createTestAgentService(): LangChainAgentService {
  const registry = new ToolRegistry();

  return new LangChainAgentService({
    model: createMockModel([{ content: "测试回答" }]),
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({ registry, timeoutMs: 100 }),
    defaultMaxIterations: 4
  });
}

const noopEventBus: AgentEventBus = {
  async publishRunEvent() {},
  async subscribeRun() {
    return () => {};
  }
};

function createAuthTokenService() {
  return new AuthTokenService({
    accessSecret: "access-secret",
    refreshSecret: "refresh-secret",
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 15 * 24 * 60 * 60
  });
}

function createAuthHeaders(tokenService: AuthTokenService, userId: string, githubLogin: string) {
  const token = tokenService.issueTokenPair({
    userId,
    githubId: `${userId}_github`,
    githubLogin
  }).accessToken;

  return {
    authorization: `Bearer ${token}`
  };
}

async function buildKnowledgeTestApp(options: {
  uploadDirectory: string;
  knowledgeIndexQueue: KnowledgeIndexQueue;
  tokenService?: AuthTokenService;
}) {
  const app = (await buildApp({
    agentService: createTestAgentService(),
    runningStateStore: new InMemoryRunningMessageStateStore(),
    eventBus: noopEventBus,
    runQueue: new NoopAgentRunQueue(),
    cancellationStore: new InMemoryAgentCancellationStore(),
    runLock: new InMemoryAgentRunLock(),
    databasePath: TEST_DATABASE_URL,
    uploadDirectory: options.uploadDirectory,
    knowledgeIndexQueue: options.knowledgeIndexQueue,
    embeddingService: new FakeEmbeddingService(),
    skipAuth: !options.tokenService,
    auth: options.tokenService
      ? {
          userStore: new InMemoryUserStore(),
          githubClient: new UnusedGithubOAuthClient(),
          tokenService: options.tokenService
        }
      : undefined
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

  it("知识库搜索是公共维度，任一登录用户都能搜索 ready 文档", async () => {
    const uploadDirectory = mkdtempSync(join(tmpdir(), "knowledge-upload-"));
    uploadDirs.push(uploadDirectory);
    const queue = new CapturingKnowledgeIndexQueue();
    const tokenService = createAuthTokenService();
    const app = await buildKnowledgeTestApp({ uploadDirectory, knowledgeIndexQueue: queue, tokenService });
    const aliceHeaders = createAuthHeaders(tokenService, "user_alice", "alice");
    const bobHeaders = createAuthHeaders(tokenService, "user_bob", "bob");
    const multipart = createMultipartPayload({
      fieldName: "document",
      fileName: "公共手册.txt",
      contentType: "text/plain",
      content: "请假需要直属主管审批。"
    });
    const uploadResponse = await app.inject({
      method: "POST",
      url: "/knowledge/documents/upload",
      headers: {
        ...aliceHeaders,
        ...multipart.headers
      },
      payload: multipart.payload
    });
    const { document } = uploadResponse.json() as { document: KnowledgeDocumentRecord };

    await app.knowledgeIndexingService?.indexDocument(document.id);

    const searchResponse = await app.inject({
      method: "POST",
      url: "/knowledge/search",
      headers: bobHeaders,
      payload: {
        query: "请假找谁审批？",
        limit: 3
      }
    });
    const searchPayload = searchResponse.json() as { results: Array<{ documentId: string; content: string }> };

    expect(searchResponse.statusCode).toBe(200);
    expect(searchPayload.results[0]).toMatchObject({
      documentId: document.id,
      content: "请假需要直属主管审批。"
    });
  });

  it("拒绝超过 20MB 的知识库附件", async () => {
    const uploadDirectory = mkdtempSync(join(tmpdir(), "knowledge-upload-"));
    uploadDirs.push(uploadDirectory);
    const queue = new CapturingKnowledgeIndexQueue();
    const app = await buildKnowledgeTestApp({ uploadDirectory, knowledgeIndexQueue: queue });
    const multipart = createMultipartPayload({
      fieldName: "document",
      fileName: "large.md",
      contentType: "text/markdown",
      content: Buffer.alloc(20 * 1024 * 1024 + 1)
    });

    const response = await app.inject({
      method: "POST",
      url: "/knowledge/documents/upload",
      headers: multipart.headers,
      payload: multipart.payload
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "附件不能超过 20MB"
      }
    });
  });
});
