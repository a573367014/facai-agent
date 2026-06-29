import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { AgentContextBuilder } from "../../src/agent/context-builder.js";
import { AgentMessageCoordinator } from "../../src/agent/agent-message-coordinator.js";
import { AgentService } from "../../src/agent/agent-service.js";
import { AgentSummaryService } from "../../src/agent/agent-summary-service.js";
import { SqliteAgentStore } from "../../src/agent/sqlite-agent-store.js";
import { buildApp } from "../../src/app.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const apps: FastifyInstance[] = [];
let tempDirs: string[] = [];

function createTempDatabasePath() {
  const dir = mkdtempSync(join(tmpdir(), "agent-routes-"));
  tempDirs.push(dir);
  return join(dir, "agent.sqlite");
}

async function buildTestApp(options: Parameters<typeof buildApp>[0]) {
  const app = await buildApp({
    ...options,
    databasePath: createTempDatabasePath()
  });
  apps.push(app);
  return app;
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

function createAgentService(provider: LlmProvider, registry: ToolRegistry): AgentService {
  return new AgentService({
    provider,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({ registry, timeoutMs: 100 }),
    defaultMaxIterations: 4
  });
}

function createTestAgentService(): AgentService {
  const registry = new ToolRegistry();
  const provider: LlmProvider = {
    complete: async () => ({ content: "测试回答" })
  };
  return createAgentService(provider, registry);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

async function waitForMessage(app: FastifyInstance, messageId: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/agents/messages/${messageId}` });
    const payload = response.json() as { message: { status: string } };

    if (payload.message.status !== "running") {
      return payload;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("message did not finish in time");
}

async function waitForRun(app: FastifyInstance, runId: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/agents/runs/${runId}` });
    const payload = response.json() as { run: { status: string } };

    if (payload.run.status !== "running") {
      return payload;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
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
        seq: number;
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
  it("启动后不会立即清理事件，会在配置的凌晨窗口清理过期事件", async () => {
    vi.useFakeTimers();
    const databasePath = createTempDatabasePath();
    const store = await SqliteAgentStore.create({ databasePath, eventRetentionDays: 3 });

    vi.setSystemTime(new Date(2026, 5, 20, 0, 0, 0, 0));
    const session = store.createSession("事件清理");
    const assistantMessage = store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "已有回答" }],
      completedAt: "2026-06-22T00:00:01.000Z"
    });
    store.appendEvent(assistantMessage.id, { type: "final_answer", answer: "已有回答" });
    store.close();

    vi.setSystemTime(new Date(2026, 5, 24, 2, 30, 0, 0));
    const app = await buildApp({
      agentService: createTestAgentService(),
      databasePath,
      eventCleanupHour: 3,
      eventCleanupBatchSize: 10,
      eventCleanupMaxBatches: 2
    });
    apps.push(app);

    const beforeResponse = await app.inject({
      method: "GET",
      url: `/agents/messages/${assistantMessage.id}`
    });

    expect(beforeResponse.json()).toMatchObject({
      events: [expect.objectContaining({ event: { type: "final_answer", answer: "已有回答" } })]
    });

    await vi.advanceTimersByTimeAsync(29 * 60 * 1000);

    const stillBeforeCleanupResponse = await app.inject({
      method: "GET",
      url: `/agents/messages/${assistantMessage.id}`
    });

    expect(stillBeforeCleanupResponse.json()).toMatchObject({
      events: [expect.objectContaining({ event: { type: "final_answer", answer: "已有回答" } })]
    });

    await vi.advanceTimersByTimeAsync(60 * 1000);

    const afterResponse = await app.inject({
      method: "GET",
      url: `/agents/messages/${assistantMessage.id}`
    });

    expect(afterResponse.json()).toMatchObject({ events: [] });
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
    expect(payload.file.url).toMatch(/^http:\/\/127\.0\.0\.1:4001\/uploads\/images\/.+\.png$/);

    const uploadedPath = new URL(payload.file.url).pathname;
    const fileResponse = await app.inject({ method: "GET", url: uploadedPath });

    expect(fileResponse.statusCode).toBe(200);
    expect(fileResponse.headers["content-type"]).toContain("image/png");
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

    expect(first.file.url).toBe(`http://127.0.0.1:4001/uploads/images/${expectedFileName}`);
    expect(second.file.url).toBe(first.file.url);
    expect(first.file.name).toBe("first.png");
    expect(second.file.name).toBe("second.png");
    expect(readdirSync(join(uploadDirectory, "images"))).toEqual([expectedFileName]);
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

  it("POST /agents/messages 创建 session、user message 和后台 assistant message", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const response = await app.inject({
      method: "POST",
      url: "/agents/messages",
      payload: { input: "你好" }
    });

    expect(response.statusCode).toBe(202);
    const payload = response.json() as {
      session: { id: string };
      userMessage: { id: string; role: string; status: string; parts: unknown[] };
      assistantMessage: { id: string; sessionId: string; role: string; status: string; parts: unknown[] };
    };

    expect(payload.session.id).toMatch(/^session_/);
    expect(payload.userMessage).toMatchObject({
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "你好" }]
    });
    expect(payload.userMessage).not.toHaveProperty("content");
    expect(payload.userMessage).not.toHaveProperty("assets");
    expect(payload.assistantMessage.id).toMatch(/^msg_/);
    expect(payload.assistantMessage.sessionId).toBe(payload.session.id);
    expect(payload.assistantMessage).toMatchObject({
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });
    expect(payload.assistantMessage).not.toHaveProperty("content");
    expect(payload.assistantMessage).not.toHaveProperty("assets");

    const completed = await waitForMessage(app, payload.assistantMessage.id);
    expect(completed.message).toMatchObject({
      id: payload.assistantMessage.id,
      sessionId: payload.session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "测试回答" }]
    });
    expect(completed.message).not.toHaveProperty("content");
    expect(completed.message).not.toHaveProperty("assets");
    expect(completed.message).not.toHaveProperty("steps");
  });

  it("POST /agents/messages 支持直接提交 message parts", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const response = await app.inject({
      method: "POST",
      url: "/agents/messages",
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

  it("POST /agents/runs 创建 run，并在后台生成 assistant message", async () => {
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
      phase: "compressing",
      userMessageId: payload.userMessage.id
    });
    expect(payload.assistantMessage).toBeUndefined();
    expect(payload.userMessage).toMatchObject({
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "你好" }]
    });

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

  it("GET /agents/runs/:runId/events 返回当前 assistant message snapshot", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const createResponse = await app.inject({
      method: "POST",
      url: "/agents/runs",
      payload: { input: "你好" }
    });
    const { run } = createResponse.json() as { run: { id: string } };

    await waitForRun(app, run.id);

    const response = await app.inject({
      method: "GET",
      url: `/agents/runs/${run.id}/events?after=0`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const events = parseSseEvents(response.body);

    expect(events).toEqual([
      expect.objectContaining({
        seq: 0,
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

  it("GET /agents/messages/:messageId/debug/events 根据 assistant messageId 反查 run events", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const createResponse = await app.inject({
      method: "POST",
      url: "/agents/runs",
      payload: { input: "你好" }
    });
    const { run } = createResponse.json() as { run: { id: string } };
    const completed = await waitForRun(app, run.id);
    const assistantMessageId = completed.run.assistantMessageId as string;

    const response = await app.inject({
      method: "GET",
      url: `/agents/messages/${assistantMessageId}/debug/events`
    });
    const payload = response.json() as {
      message: { id: string };
      runs: Array<{ id: string; assistantMessageId?: string }>;
      messageEvents: Array<{ event: { type: string } }>;
      runEvents: Array<{ runId?: string; messageId?: string; event: { type: string } }>;
      events: Array<{ runId?: string; messageId?: string; event: { type: string } }>;
    };

    expect(response.statusCode).toBe(200);
    expect(payload.message.id).toBe(assistantMessageId);
    expect(payload.runs).toEqual([
      expect.objectContaining({
        id: run.id,
        assistantMessageId
      })
    ]);
    expect(payload.messageEvents).toEqual([]);
    expect(payload.runEvents.map((event) => event.event.type)).toContain("run_completed");
    expect(payload.runEvents.every((event) => event.runId === run.id)).toBe(true);
    expect(payload.events.map((event) => event.event.type)).toEqual(payload.runEvents.map((event) => event.event.type));
  });

  it("POST /agents/sessions/:sessionId/messages 不返回压缩 prelude，摘要在 message 完成后静默刷新", async () => {
    let answerCount = 0;
    const registry = new ToolRegistry();
    const answerProvider: LlmProvider = {
      complete: async () => {
        answerCount += 1;
        return { content: `第 ${answerCount} 轮回答` };
      }
    };
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
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const coordinator = new AgentMessageCoordinator(
      createAgentService(answerProvider, registry),
      store,
      new AgentContextBuilder({ maxHistoryMessages: 10 }),
      new AgentSummaryService({
        provider: summaryProvider,
        triggerMessageCount: 3,
        keepRecentMessages: 2,
        triggerCharacterCount: 0
      })
    );
    const app = await buildApp({ coordinator });
    apps.push(app);

    try {
      const firstResponse = await app.inject({
        method: "POST",
        url: "/agents/messages",
        payload: { input: "第一轮问题" }
      });
      const firstPayload = firstResponse.json() as {
        session: { id: string };
        assistantMessage: { id: string };
      };
      await waitForMessage(app, firstPayload.assistantMessage.id);

      const secondResponse = await app.inject({
        method: "POST",
        url: `/agents/sessions/${firstPayload.session.id}/messages`,
        payload: { input: "第二轮问题" }
      });
      const secondPayload = secondResponse.json() as { assistantMessage: { id: string } };
      await waitForMessage(app, secondPayload.assistantMessage.id);

      const thirdResponse = await app.inject({
        method: "POST",
        url: `/agents/sessions/${firstPayload.session.id}/messages`,
        payload: { input: "第三轮问题" }
      });
      const thirdPayload = thirdResponse.json() as {
        userMessage: { role: string; parts: Array<{ type: string; value: string }> };
        assistantMessage: { id: string; role: string; status: string };
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
      expect(thirdPayload.assistantMessage).toMatchObject({
        role: "assistant",
        status: "running"
      });
      expect(store.getSessionSummary(firstPayload.session.id)).toBeDefined();
      expect(store.getMessagesBySession(firstPayload.session.id).some((message) => message.role === "system")).toBe(false);
    } finally {
      store.close();
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
      url: `/agents/sessions/${firstSession.session.id}/messages`,
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

  it("GET /agents/messages/:messageId/events 建连时先返回 message snapshot", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const createResponse = await app.inject({
      method: "POST",
      url: "/agents/messages",
      payload: { input: "你好" }
    });
    const { assistantMessage } = createResponse.json() as { assistantMessage: { id: string } };

    await waitForMessage(app, assistantMessage.id);

    const response = await app.inject({
      method: "GET",
      url: `/agents/messages/${assistantMessage.id}/events?after=0`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const events = parseSseEvents(response.body);

    expect(events[0]).toMatchObject({
      seq: 0,
      messageId: assistantMessage.id,
      event: {
        type: "message.snapshot",
        message: {
          id: assistantMessage.id,
          status: "completed",
          parts: [{ type: "text", value: "测试回答" }]
        },
        resources: []
      }
    });
    expect(events.map((event) => event.event.type)).toEqual(["message.snapshot"]);
  });

  it("GET /agents/messages/:messageId/events 在运行中使用 running draft 返回 snapshot", async () => {
    const firstDeltaReceived = createDeferred<void>();
    const allowFinish = createDeferred<void>();
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async () => {
        throw new Error("streaming path should be used");
      },
      completeStream: async (_request, onDelta) => {
        await onDelta("正在生成");
        firstDeltaReceived.resolve();
        await allowFinish.promise;
        await onDelta("完成");
        return { content: "正在生成完成" };
      }
    };
    const app = await buildTestApp({
      agentService: createAgentService(provider, registry)
    });
    const createResponse = await app.inject({
      method: "POST",
      url: "/agents/messages",
      payload: { input: "写一段话" }
    });
    const { assistantMessage } = createResponse.json() as { assistantMessage: { id: string } };

    try {
      await firstDeltaReceived.promise;

      const eventsResponsePromise = app.inject({
        method: "GET",
        url: `/agents/messages/${assistantMessage.id}/events?after=0`
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      allowFinish.resolve();

      const response = await eventsResponsePromise;
      const events = parseSseEvents(response.body);

      expect(events[0]).toMatchObject({
        seq: 0,
        messageId: assistantMessage.id,
        event: {
          type: "message.snapshot",
          version: 1,
          message: {
            id: assistantMessage.id,
            status: "running",
            parts: [{ type: "text", value: "正在生成" }]
          }
        }
      });
    } finally {
      allowFinish.resolve();
      await waitForMessage(app, assistantMessage.id);
    }
  });

  it("POST /agents/messages/:messageId/regenerate 会基于旧 assistant 重新创建 run", async () => {
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async () => ({ content: "重新生成的回答" })
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const session = store.createSession("重新生成路由");
    const userMessage = store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "介绍 Agent" }]
    });
    const assistantMessage = store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "旧回答" }]
    });
    const coordinator = new AgentMessageCoordinator(
      createAgentService(provider, registry),
      store,
      new AgentContextBuilder({ maxHistoryMessages: 10 })
    );
    const app = await buildApp({ coordinator });
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
    expect(store.getMessagesBySession(session.id).filter((message) => message.role === "assistant")).toHaveLength(2);
    store.close();
  });

  it("GET /agents/messages/:messageId 只持久化关键事件，不持久化 message part delta", async () => {
    const deltaParts = ["这", "是", "一", "段", "需", "要", "合", "并", "的", "流", "式", "回", "答"];
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async () => {
        throw new Error("streaming path should be used");
      },
      completeStream: async (_request, onDelta) => {
        for (const part of deltaParts) {
          await onDelta(part);
        }

        return { content: deltaParts.join("") };
      }
    };
    const app = await buildTestApp({
      agentService: createAgentService(provider, registry)
    });
    const createResponse = await app.inject({
      method: "POST",
      url: "/agents/messages",
      payload: { input: "生成一段话" }
    });
    const { assistantMessage } = createResponse.json() as { assistantMessage: { id: string } };

    await waitForMessage(app, assistantMessage.id);

    const snapshotResponse = await app.inject({
      method: "GET",
      url: `/agents/messages/${assistantMessage.id}`
    });
    const snapshot = snapshotResponse.json() as {
      events: Array<{ event: { type: string; delta?: string } }>;
    };
    const answerDeltaEvents = snapshot.events.filter((event) => event.event.type === "answer_delta");
    const partDeltaEvents = snapshot.events.filter((event) => event.event.type === "message.part.delta");

    expect(answerDeltaEvents).toEqual([]);
    expect(partDeltaEvents).toEqual([]);
    expect(snapshot.events.map((event) => event.event.type)).toContain("final_answer");
  });

  it("POST /agents/messages/:messageId/cancel 会中断运行中的 assistant message", async () => {
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async () => {
        throw new Error("streaming path should be used");
      },
      completeStream: async (request) => {
        const signal = (request as { signal?: AbortSignal }).signal;

        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });

        return { content: "不应该返回" };
      }
    };
    const app = await buildTestApp({
      agentService: createAgentService(provider, registry)
    });
    const createResponse = await app.inject({
      method: "POST",
      url: "/agents/messages",
      payload: { input: "生成一段长回答" }
    });
    const { assistantMessage } = createResponse.json() as { assistantMessage: { id: string } };

    const cancelResponse = await app.inject({
      method: "POST",
      url: `/agents/messages/${assistantMessage.id}/cancel`
    });
    const snapshotResponse = await app.inject({
      method: "GET",
      url: `/agents/messages/${assistantMessage.id}`
    });
    const snapshot = snapshotResponse.json() as {
      message: { status: string };
      events: Array<{ event: { type: string; label?: string; code?: string } }>;
    };

    expect(cancelResponse.statusCode).toBe(200);
    expect(snapshot.message.status).toBe("cancelled");
    expect(snapshot.events.map((event) => event.event.type)).toContain("cancelled");
  });

  it("同一 session 的后续 assistant message 会带上历史消息", async () => {
    const calls: string[][] = [];
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async ({ messages }) => {
        calls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return { content: calls.length === 1 ? "第一轮回答" : "第二轮回答" };
      }
    };
    const app = await buildTestApp({
      agentService: createAgentService(provider, registry)
    });

    const firstResponse = await app.inject({
      method: "POST",
      url: "/agents/messages",
      payload: { input: "第一轮问题" }
    });
    const firstPayload = firstResponse.json() as {
      session: { id: string };
      assistantMessage: { id: string };
    };
    await waitForMessage(app, firstPayload.assistantMessage.id);

    const secondResponse = await app.inject({
      method: "POST",
      url: `/agents/sessions/${firstPayload.session.id}/messages`,
      payload: { input: "第二轮问题" }
    });
    const secondPayload = secondResponse.json() as {
      assistantMessage: { id: string };
    };
    await waitForMessage(app, secondPayload.assistantMessage.id);

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
                arguments: { prompt: "温馨田园小猪" }
              }
            ]
          };
        }

        return { content: "图片已经生成好了。" };
      }
    };
    const app = await buildTestApp({
      agentService: createAgentService(provider, registry)
    });
    const createResponse = await app.inject({
      method: "POST",
      url: "/agents/messages",
      payload: { input: "帮我生成小猪图" }
    });
    const created = createResponse.json() as {
      session: { id: string };
      assistantMessage: { id: string };
    };

    await waitForMessage(app, created.assistantMessage.id);

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
    const assistant = payload.messages.find((message) => message.id === created.assistantMessage.id);
    const mediaPart = assistant?.parts.find((part) => part.type === "media");
    const resourceId = mediaPart?.extra?.resource?.id;

    expect(resourceId).toMatch(/^res_/);
    expect(mediaPart).not.toHaveProperty("url");
    expect(mediaPart).not.toHaveProperty("mime");
    expect(payload.resources).toEqual([
      expect.objectContaining({
        id: resourceId,
        messageId: created.assistantMessage.id,
        type: "image",
        mime: "image/png",
        status: "succeeded",
        url: "https://example.com/pig.png",
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
        id: created.assistantMessage.id,
        role: "assistant",
        status: "completed",
        parts: [
          { type: "text", value: "图片已经生成好了。" },
          expect.objectContaining({
            type: "media",
            extra: expect.objectContaining({
              resource: { id: resourceId },
              tool: {
                name: "generate_image",
                toolCallId: "call_image",
                toolCallRowId: expect.stringMatching(/^tool_call_/),
                outputIndex: 0
              }
            })
          })
        ]
      })
    ]);
  });

  it("GET /agents/sessions/:sessionId 默认按最近消息分页，并支持 before 游标加载更早消息", async () => {
    let answerCount = 0;
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async () => {
        answerCount += 1;
        return { content: `第 ${answerCount} 轮回答` };
      }
    };
    const app = await buildTestApp({
      agentService: createAgentService(provider, registry)
    });
    const firstResponse = await app.inject({
      method: "POST",
      url: "/agents/messages",
      payload: { input: "第 1 轮问题" }
    });
    const firstPayload = firstResponse.json() as {
      session: { id: string };
      assistantMessage: { id: string };
    };

    await waitForMessage(app, firstPayload.assistantMessage.id);

    for (const round of [2, 3, 4]) {
      const response = await app.inject({
        method: "POST",
        url: `/agents/sessions/${firstPayload.session.id}/messages`,
        payload: { input: `第 ${round} 轮问题` }
      });
      const payload = response.json() as { assistantMessage: { id: string } };
      await waitForMessage(app, payload.assistantMessage.id);
    }

    const recentResponse = await app.inject({
      method: "GET",
      url: `/agents/sessions/${firstPayload.session.id}?limit=2`
    });
    const recentPayload = recentResponse.json() as {
      messages: Array<{ id: string; role: string; parts: Array<{ type: string; value: string }> }>;
      pageInfo: { hasMore: boolean; oldestCursor?: string; limit: number };
    };

    expect(recentResponse.statusCode).toBe(200);
    expect(recentPayload.messages.map((message) => message.parts[0]?.value)).toEqual(["第 4 轮问题", "第 4 轮回答"]);
    expect(recentPayload.pageInfo.hasMore).toBe(true);
    expect(recentPayload.pageInfo.limit).toBe(2);
    expect(recentPayload.pageInfo.oldestCursor).toBe(recentPayload.messages[0].id);

    const previousResponse = await app.inject({
      method: "GET",
      url: `/agents/sessions/${firstPayload.session.id}/messages?before=${recentPayload.pageInfo.oldestCursor}&limit=2`
    });
    const previousPayload = previousResponse.json() as {
      messages: Array<{ parts: Array<{ type: string; value: string }> }>;
      pageInfo: { hasMore: boolean; oldestCursor?: string; limit: number };
    };

    expect(previousResponse.statusCode).toBe(200);
    expect(previousPayload.messages.map((message) => message.parts[0]?.value)).toEqual(["第 3 轮问题", "第 3 轮回答"]);
    expect(previousPayload.pageInfo).toEqual({
      hasMore: true,
      oldestCursor: previousPayload.messages[0] ? expect.any(String) : undefined,
      limit: 2
    });
  });
});
