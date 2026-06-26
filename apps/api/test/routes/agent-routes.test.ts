import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { AgentService } from "../../src/agent/agent-service.js";
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

afterEach(async () => {
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

describe("agent routes", () => {
  it("GET /health 返回 ok", async () => {
    const app = await buildTestApp({ agentService: createTestAgentService() });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
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
      userMessage: { id: string; role: string; content: string; status: string; assets: unknown[] };
      assistantMessage: { id: string; sessionId: string; role: string; status: string; content: string };
    };

    expect(payload.session.id).toMatch(/^session_/);
    expect(payload.userMessage).toMatchObject({
      role: "user",
      content: "你好",
      status: "completed",
      assets: []
    });
    expect(payload.assistantMessage.id).toMatch(/^msg_/);
    expect(payload.assistantMessage.sessionId).toBe(payload.session.id);
    expect(payload.assistantMessage).toMatchObject({
      role: "assistant",
      status: "running",
      content: ""
    });

    const completed = await waitForMessage(app, payload.assistantMessage.id);
    expect(completed.message).toMatchObject({
      id: payload.assistantMessage.id,
      sessionId: payload.session.id,
      role: "assistant",
      status: "completed",
      content: "测试回答"
    });
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
        content: string;
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
    expect(payload.userMessage.content).toBe("帮我生成图片\n风格：温馨田园风");
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

  it("GET /agents/messages/:messageId/events 回放 assistant message 的历史事件", async () => {
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
    expect(response.body).toContain("id: 1");
    expect(response.body).toContain("\"id\":\"event_");
    expect(response.body).toContain("\"seq\":");
    expect(response.body).toContain(`"messageId":"${assistantMessage.id}"`);
    expect(response.body).toContain("\"type\":\"final_answer\"");
    expect(response.body).toContain("\"answer\":\"测试回答\"");
  });

  it("GET /agents/messages/:messageId/events 会把高频 answer_delta 合并成 answer_chunk", async () => {
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
      events: Array<{ event: { type: string; text?: string; delta?: string } }>;
    };
    const answerDeltaEvents = snapshot.events.filter((event) => event.event.type === "answer_delta");
    const answerChunkEvents = snapshot.events.filter((event) => event.event.type === "answer_chunk");

    expect(answerDeltaEvents).toEqual([]);
    expect(answerChunkEvents.length).toBeGreaterThan(0);
    expect(answerChunkEvents.length).toBeLessThan(deltaParts.length);
    expect(answerChunkEvents.map((event) => event.event.text).join("")).toBe(deltaParts.join(""));
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

  it("GET /agents/sessions/:sessionId 返回带图片资源的消息列表", async () => {
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
        role: string;
        content: string;
        status: string;
        assets: Array<{
          type: string;
          url: string;
          prompt?: string;
          toolCallId?: string;
          index?: number;
        }>;
      }>;
    };

    expect(sessionResponse.statusCode).toBe(200);
    expect(payload.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "帮我生成小猪图",
        status: "completed",
        assets: []
      }),
      expect.objectContaining({
        id: created.assistantMessage.id,
        role: "assistant",
        content: "图片已经生成好了。",
        status: "completed",
        assets: [
          expect.objectContaining({
            type: "image",
            url: "https://example.com/pig.png",
            prompt: "温馨田园小猪",
            toolCallId: "call_image",
            index: 0
          })
        ]
      })
    ]);
  });
});
