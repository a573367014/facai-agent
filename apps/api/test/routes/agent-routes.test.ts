import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { InMemoryAgentCancellationStore } from "../../src/agent/agent-cancellation-store.js";
import type { AgentEventBus } from "../../src/agent/agent-event-bus.js";
import { AgentContextBuilder } from "../../src/agent/context-builder.js";
import { AgentMessageCoordinator } from "../../src/agent/agent-message-coordinator.js";
import { InMemoryAgentRunLock } from "../../src/agent/agent-run-lock.js";
import type { AgentRunJobPayload, AgentRunQueue } from "../../src/agent/agent-run-queue.js";
import { AgentSummaryService } from "../../src/agent/agent-summary-service.js";
import { InMemoryRunningMessageStateStore } from "../../src/agent/running-message-state-store.js";
import { PostgresAgentStore } from "../../src/agent/postgres-agent-store.js";
import { buildApp } from "../../src/app.js";
import { AuthTokenService } from "../../src/auth/auth-token-service.js";
import type { GithubOAuthClient } from "../../src/auth/github-oauth-client.js";
import { InMemoryUserStore } from "../../src/auth/user-store.js";
import { LangChainAgentService } from "../../src/langchain/langchain-agent-service.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createMockModel, type MockModelResponse } from "../helpers/mock-model.js";

const noopEventBus: AgentEventBus = {
  async publishRunEvent() {},
  async subscribeRun() {
    return () => {};
  }
};

const apps: FastifyInstance[] = [];
let tempDirs: string[] = [];

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agent_test";
let resetStore: PostgresAgentStore;

class CapturingAgentRunQueue implements AgentRunQueue {
  readonly jobs: AgentRunJobPayload[] = [];

  async enqueueRun(payload: AgentRunJobPayload): Promise<void> {
    this.jobs.push(payload);
  }

  takeNextJob(): AgentRunJobPayload {
    const job = this.jobs.shift();

    if (!job) {
      throw new Error("expected queued agent run job");
    }

    return job;
  }
}

class UnusedGithubOAuthClient implements GithubOAuthClient {
  async getUserProfile(): Promise<never> {
    throw new Error("GitHub OAuth client should not be used by route authorization tests");
  }
}

type TestFastifyApp = FastifyInstance & {
  agentCoordinator?: AgentMessageCoordinator;
  testRunQueue: CapturingAgentRunQueue;
};

async function buildTestApp(options: Parameters<typeof buildApp>[0]) {
  const testRunQueue = new CapturingAgentRunQueue();
  const app = await buildApp({
    ...options,
    runningStateStore: options.runningStateStore ?? new InMemoryRunningMessageStateStore(),
    eventBus: options.eventBus ?? noopEventBus,
    runQueue: testRunQueue,
    cancellationStore: options.cancellationStore ?? new InMemoryAgentCancellationStore(),
    runLock: options.runLock ?? new InMemoryAgentRunLock(),
    databasePath: TEST_DATABASE_URL,
    skipAuth: true
  }) as TestFastifyApp;
  app.testRunQueue = testRunQueue;
  apps.push(app);
  return app;
}

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

async function buildAuthenticatedAgentTestApp() {
  const testRunQueue = new CapturingAgentRunQueue();
  const coordinator = new AgentMessageCoordinator(
    createTestAgentService(),
    resetStore,
    new AgentContextBuilder(),
    undefined,
    new InMemoryRunningMessageStateStore(),
    undefined,
    {
      eventBus: noopEventBus,
      runQueue: testRunQueue,
      cancellationStore: new InMemoryAgentCancellationStore(),
      runLock: new InMemoryAgentRunLock()
    }
  );
  const tokenService = createAuthTokenService();
  const app = (await buildApp({
    coordinator,
    skipAgentRuntime: true,
    auth: {
      userStore: new InMemoryUserStore(),
      githubClient: new UnusedGithubOAuthClient(),
      tokenService
    }
  })) as TestFastifyApp;
  app.testRunQueue = testRunQueue;
  apps.push(app);

  return {
    app,
    headersFor: (userId: string, githubLogin: string) => createAuthHeaders(tokenService, userId, githubLogin)
  };
}

class FailingRunningMessageStateStore extends InMemoryRunningMessageStateStore {
  async init(): ReturnType<InMemoryRunningMessageStateStore["init"]> {
    throw new Error('Reached the max retries per request limit (which is 2). Refer to "maxRetriesPerRequest" option for details.');
  }
}

async function executeNextQueuedRun(app: TestFastifyApp) {
  if (!app.agentCoordinator) {
    throw new Error("expected test app to expose AgentMessageCoordinator");
  }

  await app.agentCoordinator.executeQueuedRun(app.testRunQueue.takeNextJob());
}

function createMultipartPayload(input: { fieldName: string; fileName: string; contentType: string; content: string | Buffer }) {
  const boundary = `----agent-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

beforeAll(async () => {
  resetStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
});

beforeEach(async () => {
  await resetStore.reset();
});

afterAll(async () => {
  await resetStore.close();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) {
    await app.close();
  }

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function createAgentService(responses: MockModelResponse[], registry: ToolRegistry): LangChainAgentService {
  return new LangChainAgentService({
    model: createMockModel(responses),
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({ registry, timeoutMs: 100 }),
    defaultMaxIterations: 4
  });
}

function createTestAgentService(): LangChainAgentService {
  const registry = new ToolRegistry();
  return createAgentService([{ content: "测试回答" }], registry);
}

async function waitForRun(app: FastifyInstance, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/agents/runs/${runId}` });
    const payload = response.json() as { run: { status: string } };

    if (payload.run.status !== "running") {
      return payload;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("run did not finish in time");
}

function parseSseEvents(body: string) {
  return body
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));

      if (!dataLine) {
        throw new Error(`SSE block missing data line: ${block}`);
      }

      return JSON.parse(dataLine.slice("data: ".length)) as {
        id: string;
        messageId?: string;
        runId?: string;
        event: {
          type: string;
          version?: number;
          message?: { id: string; parts: unknown[]; status: string };
          resources?: unknown[];
          answer?: string;
        };
      };
    });
}

describe("agent routes", () => {
  it("按登录用户隔离会话、run 和消息快照", async () => {
    const { app, headersFor } = await buildAuthenticatedAgentTestApp();
    const aliceHeaders = headersFor("user_alice", "alice");
    const bobHeaders = headersFor("user_bob", "bob");

    const createSessionResponse = await app.inject({
      method: "POST",
      url: "/agents/sessions",
      headers: aliceHeaders,
      payload: { title: "Alice 的会话" }
    });
    const { session } = createSessionResponse.json() as { session: { id: string } };

    const aliceListResponse = await app.inject({ method: "GET", url: "/agents/sessions", headers: aliceHeaders });
    const bobListResponse = await app.inject({ method: "GET", url: "/agents/sessions", headers: bobHeaders });

    expect(createSessionResponse.statusCode).toBe(201);
    expect((aliceListResponse.json() as { sessions: Array<{ id: string }> }).sessions.map((item) => item.id)).toEqual([
      session.id
    ]);
    expect((bobListResponse.json() as { sessions: Array<{ id: string }> }).sessions).toEqual([]);

    expect(
      (
        await app.inject({
          method: "GET",
          url: `/agents/sessions/${session.id}`,
          headers: bobHeaders
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/agents/sessions/${session.id}/runs`,
          headers: bobHeaders,
          payload: { input: "尝试写入别人会话" }
        })
      ).statusCode
    ).toBe(404);

    const runResponse = await app.inject({
      method: "POST",
      url: `/agents/sessions/${session.id}/runs`,
      headers: aliceHeaders,
      payload: { input: "你好" }
    });
    const { run } = runResponse.json() as { run: { id: string; assistantMessageId: string } };

    expect(runResponse.statusCode).toBe(202);
    expect((await app.inject({ method: "GET", url: `/agents/runs/${run.id}`, headers: aliceHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/agents/runs/${run.id}`, headers: bobHeaders })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `/agents/messages/${run.assistantMessageId}`, headers: bobHeaders })).statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: `/agents/runs/${run.id}/cancel`, headers: bobHeaders })).statusCode
    ).toBe(404);
  });

  it("执行 run 不再写入本地 JSONL 日志", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-event-log-"));
    tempDirs.push(dir);
    const eventLogPath = join(dir, "agent-events.jsonl");
    const originalLogPath = process.env.AGENT_EVENT_LOG_PATH;
    process.env.AGENT_EVENT_LOG_PATH = eventLogPath;

    try {
      const app = await buildTestApp({ agentService: createTestAgentService() });
      await app.inject({
        method: "POST",
        url: "/agents/runs",
        payload: { input: "你好" }
      });
      await executeNextQueuedRun(app);
    } finally {
      if (originalLogPath === undefined) {
        delete process.env.AGENT_EVENT_LOG_PATH;
      } else {
        process.env.AGENT_EVENT_LOG_PATH = originalLogPath;
      }
    }

    expect(existsSync(eventLogPath)).toBe(false);
  });

  it("GET /health 返回 ok", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("POST /agents/uploads/images 保存图片并返回可访问 URL", async () => {
    const uploadDirectory = mkdtempSync(join(tmpdir(), "agent-upload-images-"));
    tempDirs.push(uploadDirectory);
    const app = await buildTestApp({ agentService: createTestAgentService(), uploadDirectory });
    const multipart = createMultipartPayload({
      fieldName: "image",
      fileName: "hello.png",
      contentType: "image/png",
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    });

    const uploadResponse = await app.inject({
      method: "POST",
      url: "/agents/uploads/images",
      headers: {
        host: "127.0.0.1:4001",
        ...multipart.headers
      },
      payload: multipart.payload
    });
    const payload = uploadResponse.json() as { file: { type: string; mime: string; name: string; url: string; size: number } };

    expect(uploadResponse.statusCode).toBe(201);
    expect(payload.file).toMatchObject({
      type: "media",
      mime: "image/png",
      name: "hello.png",
      size: 8
    });
    expect(payload.file.url).toMatch(/^http:\/\/localhost:9000\/agent-uploads\/images\/.+\.png$/);

    const fileResponse = await fetch(payload.file.url);

    expect(fileResponse.status).toBe(200);
    expect(fileResponse.headers.get("content-type")).toContain("image/png");
  });

  it("POST /agents/uploads/images 相同图片内容复用同一个存储文件", async () => {
    const uploadDirectory = mkdtempSync(join(tmpdir(), "agent-upload-images-"));
    tempDirs.push(uploadDirectory);
    const app = await buildTestApp({ agentService: createTestAgentService(), uploadDirectory });
    const imageContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    async function upload(fileName: string) {
      const multipart = createMultipartPayload({
        fieldName: "image",
        fileName,
        contentType: "image/png",
        content: imageContent
      });

      const response = await app.inject({
        method: "POST",
        url: "/agents/uploads/images",
        headers: {
          host: "127.0.0.1:4001",
          ...multipart.headers
        },
        payload: multipart.payload
      });

      expect(response.statusCode).toBe(201);
      return response.json() as { file: { name: string; url: string } };
    }

    const first = await upload("first.png");
    const second = await upload("second.png");
    const expectedFileName = `${createHash("md5").update(imageContent).digest("hex")}.png`;

    expect(first.file.url).toBe(`http://localhost:9000/agent-uploads/images/${expectedFileName}`);
    expect(second.file.url).toBe(first.file.url);
    expect(first.file.name).toBe("first.png");
    expect(second.file.name).toBe("second.png");
  });

  it("POST /agents/uploads/images 拒绝非图片文件", async () => {
    const uploadDirectory = mkdtempSync(join(tmpdir(), "agent-upload-images-"));
    tempDirs.push(uploadDirectory);
    const app = await buildTestApp({ agentService: createTestAgentService(), uploadDirectory });
    const multipart = createMultipartPayload({
      fieldName: "image",
      fileName: "note.txt",
      contentType: "text/plain",
      content: "hello"
    });

    const response = await app.inject({
      method: "POST",
      url: "/agents/uploads/images",
      headers: multipart.headers,
      payload: multipart.payload
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "当前只支持上传图片"
      }
    });
  });

  it("允许 127.0.0.1 前端访问 API", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "http://127.0.0.1:4000"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:4000");
  });

  it("允许局域网 IP 前端访问 API", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "http://10.1.65.46:4000"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://10.1.65.46:4000");
  });

  it("允许局域网 IP 前端发起 CORS 预检请求", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const response = await app.inject({
      method: "OPTIONS",
      url: "/agents/messages",
      headers: {
        origin: "http://10.1.65.46:4000",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type"
      }
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://10.1.65.46:4000");
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("默认不允许公网域名前端访问 API", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "https://evil.example.com"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("旧 message 执行入口不再对外提供", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const createSessionResponse = await app.inject({
      method: "POST",
      url: "/agents/sessions",
      payload: { title: "旧入口测试" }
    });
    const { session } = createSessionResponse.json() as { session: { id: string } };
    const rootResponse = await app.inject({
      method: "POST",
      url: "/agents/messages",
      payload: { input: "你好" }
    });
    const sessionResponse = await app.inject({
      method: "POST",
      url: `/agents/sessions/${session.id}/messages`,
      payload: { input: "你好" }
    });
    const cancelResponse = await app.inject({
      method: "POST",
      url: "/agents/messages/msg_legacy/cancel"
    });

    expect(rootResponse.statusCode).toBe(404);
    expect(sessionResponse.statusCode).toBe(404);
    expect(cancelResponse.statusCode).toBe(404);
  });

  it("GET /agents/sessions 支持按 cursor 分页", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });

    async function createSession(title: string) {
      const response = await app.inject({
        method: "POST",
        url: "/agents/sessions",
        payload: { title }
      });

      return (response.json() as { session: { id: string } }).session;
    }

    const first = await createSession("第一条");
    const second = await createSession("第二条");
    const third = await createSession("第三条");
    const firstPageResponse = await app.inject({ method: "GET", url: "/agents/sessions?limit=2" });
    const firstPage = firstPageResponse.json() as {
      sessions: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string; limit: number };
    };

    expect(firstPageResponse.statusCode).toBe(200);
    expect(firstPage.sessions.map((session) => session.id)).toEqual([third.id, second.id]);
    expect(firstPage.pageInfo).toEqual({
      hasMore: true,
      nextCursor: second.id,
      limit: 2
    });

    const secondPageResponse = await app.inject({
      method: "GET",
      url: `/agents/sessions?after=${firstPage.pageInfo.nextCursor}&limit=2`
    });
    const secondPage = secondPageResponse.json() as {
      sessions: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string; limit: number };
    };

    expect(secondPage.sessions.map((session) => session.id)).toEqual([first.id]);
    expect(secondPage.pageInfo).toEqual({
      hasMore: false,
      limit: 2
    });
  });

  it("DELETE /agents/sessions/:sessionId 删除 session 并清理后续读取", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const createResponse = await app.inject({
      method: "POST",
      url: "/agents/sessions",
      payload: { title: "要删除的会话" }
    });
    const { session } = createResponse.json() as { session: { id: string } };

    await app.inject({
      method: "DELETE",
      url: `/agents/sessions/${session.id}`
    });

    const getDeletedResponse = await app.inject({
      method: "GET",
      url: `/agents/sessions/${session.id}`
    });
    const listResponse = await app.inject({ method: "GET", url: "/agents/sessions" });

    expect(getDeletedResponse.statusCode).toBe(404);
    expect(listResponse.json()).toMatchObject({
      sessions: []
    });
  });

  it("POST /agents/runs 支持直接提交 message parts", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const response = await app.inject({
      method: "POST",
      url: "/agents/runs",
      payload: {
        parts: [
          { type: "text", value: "帮我生成图片" },
          {
            type: "text",
            value: "warm_pastoral",
            extra: {
              placeholder: {
                type: "select",
                label: "风格",
                options: [{ label: "温馨田园风", value: "warm_pastoral" }]
              }
            }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(202);
    const payload = response.json() as {
      userMessage: {
        parts: unknown[];
      };
    };

    expect(payload).toHaveProperty("run");
    expect(payload.userMessage.parts).toEqual([
      { type: "text", value: "帮我生成图片" },
      {
        type: "text",
        value: "warm_pastoral",
        extra: {
          placeholder: {
            type: "select",
            label: "风格",
            options: [{ label: "温馨田园风", value: "warm_pastoral" }]
          }
        }
      }
    ]);
    expect(payload.userMessage).not.toHaveProperty("content");
  });

  it("POST /agents/runs 创建 run，并投递给 worker 队列", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const response = await app.inject({
      method: "POST",
      url: "/agents/runs",
      payload: { input: "你好" }
    });

    expect(response.statusCode).toBe(202);
    const payload = response.json() as {
      run: { id: string; status: string; phase: string; userMessageId: string; assistantMessageId?: string };
      session: { id: string };
      userMessage: { id: string; role: string; status: string; parts: unknown[] };
      assistantMessage?: unknown;
    };

    expect(payload.run.id).toMatch(/^run_/);
    expect(payload.run).toMatchObject({
      status: "running",
      phase: "answering",
      userMessageId: payload.userMessage.id,
      assistantMessageId: expect.stringMatching(/^msg_/)
    });
    expect(payload.assistantMessage).toBeUndefined();
    expect(payload.userMessage).toMatchObject({
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "你好" }]
    });
    expect(app.testRunQueue.jobs).toEqual([
      {
        runId: payload.run.id,
        sessionId: payload.session.id,
        userMessageId: payload.userMessage.id,
        assistantMessageId: payload.run.assistantMessageId,
        traceContext: expect.any(Object)
      }
    ]);

    await executeNextQueuedRun(app);
    const completed = await waitForRun(app, payload.run.id);
    expect(completed.run).toMatchObject({
      id: payload.run.id,
      sessionId: payload.session.id,
      status: "completed",
      phase: "completed",
      userMessageId: payload.userMessage.id,
      assistantMessageId: expect.stringMatching(/^msg_/)
    });
  });

  it("POST /agents/runs 在 Redis 运行时不可用时返回运行时依赖错误", async () => {
    const app = await buildTestApp({
      agentService: createTestAgentService(),
      runningStateStore: new FailingRunningMessageStateStore()
    });
    const response = await app.inject({
      method: "POST",
      url: "/agents/runs",
      payload: { input: "现在上海时间是多少？" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: "RUNTIME_DEPENDENCY_ERROR",
        message: "运行时依赖 Redis 暂不可用，请确认 Redis 已启动并检查 REDIS_URL。"
      }
    });

    const sessionsResponse = await app.inject({ method: "GET", url: "/agents/sessions" });
    const { sessions } = sessionsResponse.json() as { sessions: Array<{ id: string }> };
    const sessionResponse = await app.inject({ method: "GET", url: `/agents/sessions/${sessions[0]!.id}` });
    const { messages } = sessionResponse.json() as {
      messages: Array<{ role: string; status: string; error?: { code: string } }>;
    };

    expect(messages).toEqual([
      expect.objectContaining({ role: "user", status: "completed" }),
      expect.objectContaining({
        role: "assistant",
        status: "failed",
        error: { code: "RUNTIME_DEPENDENCY_ERROR", message: "运行时依赖 Redis 暂不可用，请确认 Redis 已启动并检查 REDIS_URL。" }
      })
    ]);
  });

  it("buildApp 启动时清理上次进程遗留的 running run", async () => {
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    const session = await store.createSession("遗留运行");
    const userMessage = await store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "再生产" }]
    });
    const assistantMessage = await store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });
    const run = await store.createRun({
      sessionId: session.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      status: "running",
      phase: "answering"
    });
    await store.close();

    const app = await buildApp({
      databasePath: TEST_DATABASE_URL,
      agentService: createTestAgentService(),
      runningStateStore: new InMemoryRunningMessageStateStore(),
      eventBus: noopEventBus,
      runQueue: new CapturingAgentRunQueue(),
      cancellationStore: new InMemoryAgentCancellationStore(),
      runLock: new InMemoryAgentRunLock(),
      skipAuth: true
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/agents/runs/${run.id}`
    });
    const payload = response.json() as {
      run: { status: string; phase: string; error?: { code: string; message: string } };
    };

    expect(payload.run).toMatchObject({
      status: "failed",
      phase: "failed",
      error: {
        code: "RUN_INTERRUPTED",
        message: "服务重启后清理遗留运行"
      }
    });
  });

  it("GET /agents/runs/:runId/stream 返回当前 assistant message snapshot", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const createResponse = await app.inject({
      method: "POST",
      url: "/agents/runs",
      payload: { input: "你好" }
    });
    const { run } = createResponse.json() as { run: { id: string } };

    await executeNextQueuedRun(app);

    const response = await app.inject({
      method: "GET",
      url: `/agents/runs/${run.id}/stream`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const events = parseSseEvents(response.body);

    expect(events).toEqual([
      expect.objectContaining({
        runId: run.id,
        event: expect.objectContaining({
          type: "message.snapshot",
          message: expect.objectContaining({
            status: "completed",
            parts: [{ type: "text", value: "测试回答" }]
          }),
          resources: []
        })
      })
    ]);
    expect(response.body).toContain(`"runId":"${run.id}"`);
  });

  it("POST /agents/sessions/:sessionId/runs 不返回压缩 prelude，压缩进度通过 run 持久化", async () => {
    const registry = new ToolRegistry();
    const summaryProvider: LlmProvider = {
      complete: async () => ({
        content: JSON.stringify({
          userGoal: "理解 Agent 上下文压缩",
          currentTask: "message 完成后压缩",
          decisions: ["在 assistant message 完成后静默压缩旧上下文"],
          preferences: ["中文"],
          constraints: [],
          importantFacts: ["前两轮已经完成"],
          openQuestions: [],
          recentProgress: ["摘要已完成"]
        })
      })
    };
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    const coordinator = new AgentMessageCoordinator(
      createAgentService(
        [
          { content: "第 1 轮回答" },
          { content: "第 2 轮回答" },
          { content: "第 3 轮回答" }
        ],
        registry
      ),
      store,
      new AgentContextBuilder({ maxHistoryMessages: 10 }),
      new AgentSummaryService({
        provider: summaryProvider,
        triggerMessageCount: 3,
        keepRecentMessages: 2,
        triggerCharacterCount: 0
      })
    );
    const app = await buildApp({ coordinator, skipAuth: true });
    apps.push(app);

    try {
      const firstResponse = await app.inject({
        method: "POST",
        url: "/agents/runs",
        payload: { input: "第一轮问题" }
      });
      const firstPayload = firstResponse.json() as {
        session: { id: string };
        run: { id: string };
      };
      await waitForRun(app, firstPayload.run.id);

      const secondResponse = await app.inject({
        method: "POST",
        url: `/agents/sessions/${firstPayload.session.id}/runs`,
        payload: { input: "第二轮问题" }
      });
      const secondPayload = secondResponse.json() as { run: { id: string } };
      await waitForRun(app, secondPayload.run.id);

      const thirdResponse = await app.inject({
        method: "POST",
        url: `/agents/sessions/${firstPayload.session.id}/runs`,
        payload: { input: "第三轮问题" }
      });
      const thirdPayload = thirdResponse.json() as {
        userMessage: { role: string; parts: Array<{ type: string; value: string }> };
        run: { id: string; status: string };
        preludeMessages?: unknown[];
        preludeEvents?: unknown[];
      };

      expect(thirdResponse.statusCode).toBe(202);
      expect(thirdPayload.preludeMessages).toBeUndefined();
      expect(thirdPayload.preludeEvents).toBeUndefined();
      expect(thirdPayload.userMessage).toMatchObject({
        role: "user",
        parts: [{ type: "text", value: "第三轮问题" }]
      });
      expect(thirdPayload.run).toMatchObject({
        status: "running"
      });
      const completedThirdRun = await waitForRun(app, thirdPayload.run.id) as {
        run: { status: string; phase: string; systemMessageId?: string };
      };
      const systemMessage = (await store.getMessagesBySession(firstPayload.session.id)).find(
        (message) => message.id === completedThirdRun.run.systemMessageId
      );

      expect(await store.getSessionSummary(firstPayload.session.id)).toBeDefined();
      expect(completedThirdRun.run).toMatchObject({
        status: "completed",
        phase: "completed"
      });
      expect(systemMessage).toMatchObject({
        role: "system",
        status: "completed",
        parts: [{ type: "text", value: "上下文已自动压缩" }]
      });
    } finally {
      await store.close();
    }
  });

  it("GET /agents/sessions 按更新时间倒序返回会话列表", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const firstResponse = await app.inject({
      method: "POST",
      url: "/agents/sessions",
      payload: { title: "第一段会话" }
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/agents/sessions",
      payload: { title: "第二段会话" }
    });
    const firstSession = firstResponse.json() as { session: { id: string } };
    const secondSession = secondResponse.json() as { session: { id: string } };

    await app.inject({
      method: "POST",
      url: `/agents/sessions/${firstSession.session.id}/runs`,
      payload: { input: "让第一段会话更新" }
    });

    const response = await app.inject({
      method: "GET",
      url: "/agents/sessions"
    });
    const payload = response.json() as { sessions: Array<{ id: string; title?: string }> };

    expect(response.statusCode).toBe(200);
    expect(payload.sessions.map((session) => session.id)).toEqual([firstSession.session.id, secondSession.session.id]);
  });

  it("POST /agents/messages/:messageId/regenerate 会基于旧 assistant 重新创建 run", async () => {
    const registry = new ToolRegistry();
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    const session = await store.createSession("重新生成路由");
    const userMessage = await store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "介绍 Agent" }]
    });
    const assistantMessage = await store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "旧回答" }]
    });
    const coordinator = new AgentMessageCoordinator(
      createAgentService([{ content: "重新生成的回答" }], registry),
      store,
      new AgentContextBuilder({ maxHistoryMessages: 10 })
    );
    const app = await buildApp({ coordinator, skipAuth: true });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/agents/messages/${assistantMessage.id}/regenerate`
    });
    const payload = response.json() as {
      run: { id: string; userMessageId: string; status: string };
      session: { id: string };
      userMessage: { id: string };
    };

    expect(response.statusCode).toBe(202);
    expect(payload.session.id).toBe(session.id);
    expect(payload.userMessage.id).toBe(userMessage.id);
    expect(payload.run).toMatchObject({
      userMessageId: userMessage.id,
      status: "running"
    });

    await waitForRun(app, payload.run.id);
    expect((await store.getMessagesBySession(session.id)).filter((message) => message.role === "assistant")).toHaveLength(2);
    await store.close();
  });

  it("同一 session 的后续 assistant message 会带上历史消息", async () => {
    const registry = new ToolRegistry();
    const model = createMockModel([{ content: "第一轮回答" }, { content: "第二轮回答" }]);
    const app = await buildTestApp({
      agentService: new LangChainAgentService({
        model,
        toolRegistry: registry,
        toolExecutor: new ToolExecutor({ registry, timeoutMs: 100 }),
        defaultMaxIterations: 4
      })
    });

    const firstResponse = await app.inject({
      method: "POST",
      url: "/agents/runs",
      payload: { input: "第一轮问题" }
    });
    const firstPayload = firstResponse.json() as {
      session: { id: string };
      run: { id: string };
    };
    await executeNextQueuedRun(app);
    await waitForRun(app, firstPayload.run.id);

    const secondResponse = await app.inject({
      method: "POST",
      url: `/agents/sessions/${firstPayload.session.id}/runs`,
      payload: { input: "第二轮问题" }
    });
    const secondPayload = secondResponse.json() as {
      run: { id: string };
    };
    await executeNextQueuedRun(app);
    await waitForRun(app, secondPayload.run.id);

    const calls = model.calls.map((messages) =>
      messages.map((message) => {
        const type = message.getType();
        const role = type === "human" ? "user" : type === "ai" ? "assistant" : type;
        const content = typeof message.content === "string" ? message.content : "";
        return `${role}:${content}`;
      })
    );
    expect(calls[1]).toEqual([
      expect.stringMatching(/^system:/),
      "user:第一轮问题",
      "assistant:第一轮回答",
      "user:第二轮问题"
    ]);
  });

  it("GET /agents/sessions/:sessionId 返回带 media parts 的消息列表", async () => {
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
        size: "1024 x 1024",
        imageUrls: ["https://example.com/pig.png"],
        binaryDataBase64: []
      })
    });

    const app = await buildTestApp({
      agentService: createAgentService(
        [
          { toolCalls: [{ id: "call_image", name: "generate_image", args: { prompt: "温馨田园小猪" } }] },
          { content: "图片已经生成好了。" }
        ],
        registry
      ),
      toolResourceStorage: {
        storeRemoteResource: async () => ({
          url: "http://127.0.0.1:4001/uploads/resources/images/local-pig.png",
          mime: "image/png",
          name: "local-pig.png",
          size: 123,
          relativePath: "resources/images/local-pig.png"
        })
      }
    });
    const createResponse = await app.inject({
      method: "POST",
      url: "/agents/runs",
      payload: { input: "帮我生成小猪图" }
    });
    const created = createResponse.json() as {
      session: { id: string };
      run: { id: string; assistantMessageId: string };
    };

    await executeNextQueuedRun(app);
    await waitForRun(app, created.run.id);

    const sessionResponse = await app.inject({
      method: "GET",
      url: `/agents/sessions/${created.session.id}`
    });
    const payload = sessionResponse.json() as {
      messages: Array<{
        id: string;
        role: string;
        status: string;
        parts: Array<{
          type: string;
          value?: string;
          url?: string;
          mime?: string;
          extra?: {
            resource?: {
              id: string;
            };
            tool?: {
              toolCallId?: string;
              outputIndex?: number;
            };
          };
        }>;
      }>;
      resources: Array<{
        id: string;
        messageId: string;
        type: string;
        mime?: string;
        status: string;
        url?: string;
        width?: number;
        height?: number;
        metadata?: {
          prompt?: string;
          provider?: string;
        };
      }>;
    };

    expect(sessionResponse.statusCode).toBe(200);
    const assistant = payload.messages.find((message) => message.id === created.run.assistantMessageId);
    const mediaPart = assistant?.parts.find((part) => part.type === "media");
    const resourceId = mediaPart?.extra?.resource?.id;

    expect(resourceId).toMatch(/^res_/);
    expect(mediaPart).toMatchObject({
      type: "media",
      mime: "image/png",
      url: "http://127.0.0.1:4001/uploads/resources/images/local-pig.png",
      extra: {
        lifecycle: { state: "succeeded" },
        generation: { prompt: "温馨田园小猪", provider: "test_image" }
      }
    });
    expect(payload.resources).toEqual([
      expect.objectContaining({
        id: resourceId,
        messageId: created.run.assistantMessageId,
        type: "image",
        mime: "image/png",
        status: "succeeded",
        url: "http://127.0.0.1:4001/uploads/resources/images/local-pig.png",
        metadata: { prompt: "温馨田园小猪", provider: "test_image" }
      })
    ]);
    expect(payload.messages).toEqual([
      expect.objectContaining({
        role: "user",
        status: "completed",
        parts: [{ type: "text", value: "帮我生成小猪图" }]
      }),
      expect.objectContaining({
        id: created.run.assistantMessageId,
        role: "assistant",
        status: "completed",
        parts: [
          expect.objectContaining({
            type: "media",
            mime: "image/png",
            url: "http://127.0.0.1:4001/uploads/resources/images/local-pig.png",
            extra: expect.objectContaining({
              lifecycle: { state: "succeeded" },
              resource: { id: resourceId },
              tool: {
                name: "generate_image",
                toolCallId: "call_image",
                toolCallRowId: expect.stringMatching(/^tool_call_/),
                outputIndex: 0
              },
              generation: { prompt: "温馨田园小猪", provider: "test_image" }
            })
          }),
          { type: "text", value: "图片已经生成好了。" }
        ]
      })
    ]);
  });

  it("GET /agents/sessions/:sessionId 默认按最近消息分页，并支持 before 游标加载更早消息", async () => {
    const registry = new ToolRegistry();
    const app = await buildTestApp({
      agentService: createAgentService(
        [
          { content: "第 1 轮回答" },
          { content: "第 2 轮回答" },
          { content: "第 3 轮回答" },
          { content: "第 4 轮回答" }
        ],
        registry
      )
    });
    const firstResponse = await app.inject({
      method: "POST",
      url: "/agents/runs",
      payload: { input: "第 1 轮问题" }
    });
    const firstPayload = firstResponse.json() as {
      session: { id: string };
      run: { id: string };
    };

    await executeNextQueuedRun(app);
    await waitForRun(app, firstPayload.run.id);

    for (const round of [2, 3, 4]) {
      const response = await app.inject({
        method: "POST",
        url: `/agents/sessions/${firstPayload.session.id}/runs`,
        payload: { input: `第 ${round} 轮问题` }
      });
      const payload = response.json() as { run: { id: string } };
      await executeNextQueuedRun(app);
      await waitForRun(app, payload.run.id);
    }

    const recentResponse = await app.inject({
      method: "GET",
      url: `/agents/sessions/${firstPayload.session.id}?limit=2`
    });
    const recentPayload = recentResponse.json() as {
      messages: Array<{ id: string; role: string; parts: Array<{ type: string; value: string }> }>;
      pageInfo: { hasMore: boolean; nextCursor?: string; limit: number };
    };

    expect(recentResponse.statusCode).toBe(200);
    expect(recentPayload.messages.map((message) => message.parts[0]?.value)).toEqual(["第 4 轮问题", "第 4 轮回答"]);
    expect(recentPayload.pageInfo.hasMore).toBe(true);
    expect(recentPayload.pageInfo.limit).toBe(2);
    expect(recentPayload.pageInfo.nextCursor).toBe(recentPayload.messages[0].id);

    const previousResponse = await app.inject({
      method: "GET",
      url: `/agents/sessions/${firstPayload.session.id}/messages?before=${recentPayload.pageInfo.nextCursor}&limit=2`
    });
    const previousPayload = previousResponse.json() as {
      messages: Array<{ parts: Array<{ type: string; value: string }> }>;
      pageInfo: { hasMore: boolean; nextCursor?: string; limit: number };
    };

    expect(previousResponse.statusCode).toBe(200);
    expect(previousPayload.messages.map((message) => message.parts[0]?.value)).toEqual(["第 3 轮问题", "第 3 轮回答"]);
    expect(previousPayload.pageInfo).toEqual({
      hasMore: true,
      nextCursor: previousPayload.messages[0] ? expect.any(String) : undefined,
      limit: 2
    });
  });
});
