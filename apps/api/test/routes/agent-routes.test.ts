import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AgentService } from "../../src/agent/agent-service.js";
import { buildApp } from "../../src/app.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";

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

describe("agent routes", () => {
  it("GET /health 返回 ok", async () => {
    const app = await buildApp({ agentService: createTestAgentService() });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("允许 127.0.0.1 前端访问 API", async () => {
    const app = await buildApp({ agentService: createTestAgentService() });
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

  it("不再暴露旧的同步运行和直连流式接口", async () => {
    const app = await buildApp({ agentService: createTestAgentService() });
    const runResponse = await app.inject({
      method: "POST",
      url: "/agents/run",
      payload: { input: "你好" }
    });
    const streamResponse = await app.inject({
      method: "POST",
      url: "/agents/stream",
      payload: { input: "你好" }
    });

    expect(runResponse.statusCode).toBe(404);
    expect(streamResponse.statusCode).toBe(404);
  });

  it("POST /agents/runs 创建 session 和后台 run", async () => {
    const app = await buildApp({ agentService: createTestAgentService() });
    const response = await app.inject({
      method: "POST",
      url: "/agents/runs",
      payload: { input: "你好" }
    });

    expect(response.statusCode).toBe(202);
    const payload = response.json() as {
      session: { id: string };
      run: { id: string; sessionId: string; status: string; input: string };
    };

    expect(payload.session.id).toMatch(/^session_/);
    expect(payload.run.id).toMatch(/^run_/);
    expect(payload.run.sessionId).toBe(payload.session.id);
    expect(payload.run.input).toBe("你好");

    const completed = await waitForRun(app, payload.run.id);
    expect(completed.run).toMatchObject({
      id: payload.run.id,
      sessionId: payload.session.id,
      status: "completed",
      answer: "测试回答"
    });
  });

  it("GET /agents/sessions 按更新时间倒序返回会话列表", async () => {
    const app = await buildApp({ agentService: createTestAgentService() });
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
    expect(payload.sessions).toEqual([
      expect.objectContaining({ id: firstSession.session.id, title: "第一段会话" }),
      expect.objectContaining({ id: secondSession.session.id, title: "第二段会话" })
    ]);
  });

  it("GET /agents/runs/:runId/events 回放 run 的历史事件", async () => {
    const app = await buildApp({ agentService: createTestAgentService() });
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
    expect(response.body).toContain("id: 1");
    expect(response.body).toContain("\"id\":\"event_");
    expect(response.body).toContain("\"seq\":");
    expect(response.body).toContain(`"runId":"${run.id}"`);
    expect(response.body).toContain("\"type\":\"final_answer\"");
    expect(response.body).toContain("\"answer\":\"测试回答\"");
  });

  it("GET /agents/runs/:runId/events 会把高频 answer_delta 合并成 answer_chunk", async () => {
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
    const app = await buildApp({
      agentService: createAgentService(provider, registry)
    });
    const createResponse = await app.inject({
      method: "POST",
      url: "/agents/runs",
      payload: { input: "生成一段话" }
    });
    const { run } = createResponse.json() as { run: { id: string } };

    await waitForRun(app, run.id);

    const snapshotResponse = await app.inject({
      method: "GET",
      url: `/agents/runs/${run.id}`
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

  it("POST /agents/runs/:runId/cancel 会中断运行中的 run", async () => {
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
    const app = await buildApp({
      agentService: createAgentService(provider, registry)
    });
    const createResponse = await app.inject({
      method: "POST",
      url: "/agents/runs",
      payload: { input: "生成一段长回答" }
    });
    const { run } = createResponse.json() as { run: { id: string } };

    const cancelResponse = await app.inject({
      method: "POST",
      url: `/agents/runs/${run.id}/cancel`
    });
    const snapshotResponse = await app.inject({
      method: "GET",
      url: `/agents/runs/${run.id}`
    });
    const snapshot = snapshotResponse.json() as {
      run: { status: string };
      events: Array<{ event: { type: string; label?: string; code?: string } }>;
    };

    expect(cancelResponse.statusCode).toBe(200);
    expect(snapshot.run.status).toBe("cancelled");
    expect(snapshot.events.map((event) => event.event.type)).toContain("cancelled");
    expect(snapshot.events).toContainEqual(
      expect.objectContaining({
        event: {
          type: "agent_state",
          iteration: 0,
          state: "done",
          label: "已中断"
        }
      })
    );
  });

  it("同一 session 的后续 run 会带上历史问答", async () => {
    const calls: string[][] = [];
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async ({ messages }) => {
        calls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return { content: calls.length === 1 ? "第一轮回答" : "第二轮回答" };
      }
    };
    const app = await buildApp({
      agentService: createAgentService(provider, registry)
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
    await waitForRun(app, firstPayload.run.id);

    const secondResponse = await app.inject({
      method: "POST",
      url: `/agents/sessions/${firstPayload.session.id}/runs`,
      payload: { input: "第二轮问题" }
    });
    const secondPayload = secondResponse.json() as {
      run: { id: string };
    };
    await waitForRun(app, secondPayload.run.id);

    expect(calls[1]).toEqual([
      expect.stringMatching(/^system:/),
      "user:第一轮问题",
      "assistant:第一轮回答",
      "user:第二轮问题"
    ]);
  });
});
