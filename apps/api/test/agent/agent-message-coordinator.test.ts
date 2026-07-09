import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import { AgentContextBuilder } from "../../src/agent/context-builder.js";
import { AgentMessageCoordinator } from "../../src/agent/agent-message-coordinator.js";
import { AgentSummaryService } from "../../src/agent/agent-summary-service.js";
import { PostgresAgentStore } from "../../src/agent/postgres-agent-store.js";
import { LangChainAgentService } from "../../src/langchain/langchain-agent-service.js";
import type { AgentRunQueue, AgentRunJobPayload } from "../../src/agent/agent-run-queue.js";
import type { AgentEventBus } from "../../src/agent/agent-event-bus.js";
import type { AgentEventListener, StoredAgentEvent } from "../../src/agent/agent-store.js";
import type { AgentCancellationStore } from "../../src/agent/agent-cancellation-store.js";
import type { AgentRunLock, AgentRunLockLease } from "../../src/agent/agent-run-lock.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createMockModel, type MockModel, type MockModelResponse } from "../helpers/mock-model.js";

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agent_test";

async function waitForMessage(coordinator: AgentMessageCoordinator, messageId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { message } = await coordinator.getMessage(messageId);

    if (message.status !== "running") {
      return message;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("message did not finish in time");
}

async function waitForRun(coordinator: AgentMessageCoordinator, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { run } = await coordinator.getRun(runId);

    if (run.status !== "running") {
      const execution = (coordinator as unknown as { runningRunExecutions?: Map<string, Promise<void>> })
        .runningRunExecutions?.get(runId);
      await execution;
      return run;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("run did not finish in time");
}

async function waitForRunAssistantMessageId(coordinator: AgentMessageCoordinator, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { run } = await coordinator.getRun(runId);

    if (run.assistantMessageId) {
      return run.assistantMessageId;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("run did not create assistant message in time");
}

async function startRunAndWait(
  coordinator: AgentMessageCoordinator,
  input: Parameters<AgentMessageCoordinator["startRun"]>[0]
) {
  const started = await coordinator.startRun(input);
  const run = await waitForRun(coordinator, started.run.id);
  const assistantMessageId = run.assistantMessageId;

  if (!assistantMessageId) {
    throw new Error("completed run is missing assistant message");
  }

  return {
    ...started,
    run,
    assistantMessage: (await coordinator.getMessage(assistantMessageId)).message
  };
}

async function waitForSessionSummary(store: PostgresAgentStore, sessionId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const summary = await store.getSessionSummary(sessionId);

    if (summary) {
      return summary;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("summary did not finish in time");
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

function createAgentService(responses: MockModelResponse[], registry: ToolRegistry) {
  return new LangChainAgentService({
    model: createMockModel(responses),
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({ registry, timeoutMs: 100 }),
    defaultMaxIterations: 4
  });
}

function createAgentServiceWithModel(model: ChatOpenAI, registry: ToolRegistry) {
  return new LangChainAgentService({
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({ registry, timeoutMs: 100 }),
    defaultMaxIterations: 4
  });
}

function formatBaseMessages(messages: ReadonlyArray<BaseMessage>): string[] {
  return messages.map((message) => {
    let role: string;
    if (message instanceof HumanMessage) {
      role = "user";
    } else if (message instanceof AIMessage) {
      role = "assistant";
    } else if (message instanceof SystemMessage) {
      role = "system";
    } else if (message instanceof ToolMessage) {
      role = "tool";
    } else {
      role = "unknown";
    }
    const content = typeof message.content === "string" ? message.content : "";
    return `${role}:${content}`;
  });
}

interface MockStreamChunk {
  content: string;
  tool_call_chunks?: Array<{ index: number; id?: string; name?: string; args?: string }>;
}

function mockResponseToChunks(response: MockModelResponse): MockStreamChunk[] {
  const chunks: MockStreamChunk[] = [];
  if (response.content) {
    chunks.push({ content: response.content });
  }
  for (const [index, toolCall] of (response.toolCalls ?? []).entries()) {
    chunks.push({
      content: "",
      tool_call_chunks: [{ index, id: toolCall.id, name: toolCall.name, args: JSON.stringify(toolCall.args) }]
    });
  }
  return chunks;
}

function createHangingMockModel(): MockModel {
  const calls: BaseMessage[][] = [];
  const stream = async (messages?: unknown, opts?: { signal?: AbortSignal }) => {
    if (Array.isArray(messages)) {
      calls.push(messages as BaseMessage[]);
    }
    return (async function* () {
      await new Promise<void>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
      yield { content: "不会完成" };
    })();
  };
  const streamTarget = { stream, invoke: stream };
  const model = { bindTools: () => streamTarget, stream, invoke: stream, calls };
  return model as unknown as MockModel;
}

class FakeAgentEventBus implements AgentEventBus {
  private readonly runListeners = new Map<string, Set<AgentEventListener>>();

  async publishRunEvent(runId: string, event: StoredAgentEvent): Promise<void> {
    for (const listener of this.runListeners.get(runId) ?? []) {
      listener(event);
    }
  }

  async subscribeRun(runId: string, listener: AgentEventListener): Promise<() => void> {
    return this.addListener(this.runListeners, runId, listener);
  }

  private addListener(listenersById: Map<string, Set<AgentEventListener>>, id: string, listener: AgentEventListener) {
    const listeners = listenersById.get(id) ?? new Set<AgentEventListener>();
    listeners.add(listener);
    listenersById.set(id, listeners);

    return () => {
      listeners.delete(listener);
    };
  }
}

class FailingAgentEventBus implements AgentEventBus {
  async publishRunEvent(): Promise<void> {
    throw new Error("redis publish failed");
  }

  async subscribeRun(): Promise<() => void> {
    return () => {};
  }
}

class FakeAgentCancellationStore implements AgentCancellationStore {
  readonly cancelledRunIds = new Set<string>();

  async cancelRun(runId: string): Promise<void> {
    this.cancelledRunIds.add(runId);
  }

  async isRunCancelled(runId: string): Promise<boolean> {
    return this.cancelledRunIds.has(runId);
  }

  async clearRun(runId: string): Promise<void> {
    this.cancelledRunIds.delete(runId);
  }
}

describe("AgentMessageCoordinator", () => {
  it("event bus 发布失败不影响 run 创建，也不会产生未处理拒绝", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    const registry = new ToolRegistry();
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const runQueue: AgentRunQueue = {
      enqueueRun: async () => {}
    };
    const coordinator = new AgentMessageCoordinator(
      createAgentService([{ content: "不会在 API 执行" }], registry),
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      { eventBus: new FailingAgentEventBus(), runQueue }
    );

    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const started = await coordinator.startRun({ input: "排队执行" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(started.run.status).toBe("running");
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      await store.close();
    }
  });

  it("queue worker 写入的 run 终态事件会通过 event bus 推给 API 订阅者", async () => {
    const registry = new ToolRegistry();
    const enqueuedRuns: AgentRunJobPayload[] = [];
    const runQueue: AgentRunQueue = {
      enqueueRun: async (payload) => {
        enqueuedRuns.push(payload);
      }
    };
    const eventBus = new FakeAgentEventBus();
    const apiStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    const workerStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await apiStore.reset();
    const apiCoordinator = new AgentMessageCoordinator(
      createAgentService([{ content: "API 不执行" }], registry),
      apiStore,
      undefined,
      undefined,
      undefined,
      undefined,
      { eventBus, runQueue }
    );
    const workerCoordinator = new AgentMessageCoordinator(
      createAgentService([{ content: "队列任务完成" }], registry),
      workerStore,
      undefined,
      undefined,
      undefined,
      undefined,
      { eventBus }
    );
    const receivedEvents: StoredAgentEvent[] = [];

    try {
      const started = await apiCoordinator.startRun({ input: "排队执行" });
      const unsubscribe = await apiCoordinator.subscribeRun(started.run.id, (event) => {
        receivedEvents.push(event);
      });

      try {
        await workerCoordinator.executeQueuedRun(enqueuedRuns[0]!);
      } finally {
        await unsubscribe();
      }

      expect(receivedEvents.map((event) => event.event.type)).toContain("run_completed");
    } finally {
      await apiStore.close();
      await workerStore.close();
    }
  });

  it("queue 模式 startRun 只创建记录并投递任务，不在 API 进程内执行 Agent", async () => {
    const registry = new ToolRegistry();
    const model = createMockModel([{ content: "不应该在 API 进程内生成" }]);
    const enqueuedRuns: AgentRunJobPayload[] = [];
    const runQueue: AgentRunQueue = {
      enqueueRun: async (payload) => {
        enqueuedRuns.push(payload);
      }
    };
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(
      createAgentServiceWithModel(model, registry),
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      { runQueue }
    );

    try {
      const started = await coordinator.startRun({ input: "生成一张图片" });

      expect(model.calls).toHaveLength(0);
      expect(started.run).toMatchObject({
        status: "running",
        phase: "answering",
        assistantMessageId: expect.any(String)
      });
      expect(enqueuedRuns).toEqual([
        {
          runId: started.run.id,
          sessionId: started.session.id,
          userMessageId: started.userMessage.id,
          assistantMessageId: started.run.assistantMessageId!
        }
      ]);
      expect(await store.getMessage(started.run.assistantMessageId!)).toMatchObject({
        role: "assistant",
        status: "running",
        parts: []
      });
    } finally {
      await store.close();
    }
  });

  it("executeQueuedRun 会执行已入队 run 并复用 API 侧创建的 assistant message", async () => {
    const registry = new ToolRegistry();
    const enqueuedRuns: AgentRunJobPayload[] = [];
    const runQueue: AgentRunQueue = {
      enqueueRun: async (payload) => {
        enqueuedRuns.push(payload);
      }
    };
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(
      createAgentService([{ content: "队列任务已完成" }], registry),
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      { runQueue }
    );

    try {
      const started = await coordinator.startRun({ input: "排队执行" });

      await coordinator.executeQueuedRun(enqueuedRuns[0]!);

      const completedRun = (await coordinator.getRun(started.run.id)).run;
      const completedMessage = await store.getMessage(started.run.assistantMessageId!);

      expect(completedRun).toMatchObject({
        status: "completed",
        phase: "completed",
        assistantMessageId: started.run.assistantMessageId
      });
      expect(completedMessage).toMatchObject({
        id: started.run.assistantMessageId,
        status: "completed",
        parts: [{ type: "text", value: "队列任务已完成" }]
      });
    } finally {
      await store.close();
    }
  });

  it("cancelRun 会写入跨进程取消标记", async () => {
    const registry = new ToolRegistry();
    const cancellationStore = new FakeAgentCancellationStore();
    const runQueue: AgentRunQueue = {
      enqueueRun: async () => {}
    };
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(
      createAgentService([{ content: "不会在 queue 模式执行" }], registry),
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      { cancellationStore, runQueue }
    );

    try {
      const started = await coordinator.startRun({ input: "生成长任务" });

      await coordinator.cancelRun(started.run.id);

      expect(await cancellationStore.isRunCancelled(started.run.id)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("executeQueuedRun 拿不到 run lock 时不会执行 provider", async () => {
    const registry = new ToolRegistry();
    const model = createMockModel([{ content: "不应该执行" }]);
    const enqueuedRuns: AgentRunJobPayload[] = [];
    const runQueue: AgentRunQueue = {
      enqueueRun: async (payload) => {
        enqueuedRuns.push(payload);
      }
    };
    const runLock: AgentRunLock = {
      acquire: async () => undefined
    };
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(
      createAgentServiceWithModel(model, registry),
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      { runQueue, runLock }
    );

    try {
      await coordinator.startRun({ input: "排队执行" });
      await coordinator.executeQueuedRun(enqueuedRuns[0]!);

      expect(model.calls).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("executeQueuedRun 执行完成后释放 run lock", async () => {
    const registry = new ToolRegistry();
    const enqueuedRuns: AgentRunJobPayload[] = [];
    const runQueue: AgentRunQueue = {
      enqueueRun: async (payload) => {
        enqueuedRuns.push(payload);
      }
    };
    let released = false;
    const lease: AgentRunLockLease = {
      release: async () => {
        released = true;
      }
    };
    const runLock: AgentRunLock = {
      acquire: async () => lease
    };
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(
      createAgentService([{ content: "锁内执行完成" }], registry),
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      { runQueue, runLock }
    );

    try {
      await coordinator.startRun({ input: "排队执行" });
      await coordinator.executeQueuedRun(enqueuedRuns[0]!);

      expect(released).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("executeQueuedRun 被其他进程取消后，不会继续执行后续工具调用", async () => {
    const registry = new ToolRegistry();
    let toolExecutions = 0;
    registry.register({
      name: "expensive_tool",
      description: "昂贵工具",
      parameters: {
        type: "object",
        properties: {}
      },
      argumentSchema: z.object({}),
      execute: () => {
        toolExecutions += 1;
        return { ok: true };
      }
    });
    const cancellationStore = new FakeAgentCancellationStore();
    const enqueuedRuns: AgentRunJobPayload[] = [];
    const runQueue: AgentRunQueue = {
      enqueueRun: async (payload) => {
        enqueuedRuns.push(payload);
      }
    };
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    let apiCoordinator!: AgentMessageCoordinator;
    const workerCalls: BaseMessage[][] = [];
    let workerCallIndex = 0;
    const workerStream = async (messages?: unknown) => {
      if (Array.isArray(messages)) workerCalls.push(messages as BaseMessage[]);
      workerCallIndex += 1;
      const response: MockModelResponse = workerCallIndex === 1
        ? { toolCalls: [{ id: "call_expensive_tool", name: "expensive_tool", args: {} }] }
        : { content: "不应该继续生成" };
      if (workerCallIndex === 1) {
        await apiCoordinator.cancelRun(enqueuedRuns[0]!.runId);
      }
      const chunks = mockResponseToChunks(response);
      return (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })();
    };
    const workerModel = {
      bindTools: () => ({ stream: workerStream, invoke: workerStream }),
      stream: workerStream,
      invoke: workerStream,
      calls: workerCalls
    } as unknown as MockModel;
    apiCoordinator = new AgentMessageCoordinator(
      createAgentService([{ content: "API 进程不执行" }], registry),
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      { cancellationStore, runQueue }
    );
    const workerCoordinator = new AgentMessageCoordinator(
      createAgentServiceWithModel(workerModel, registry),
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      { cancellationStore }
    );

    try {
      const started = await apiCoordinator.startRun({ input: "执行昂贵任务" });

      await workerCoordinator.executeQueuedRun(enqueuedRuns[0]!);

      expect(workerCalls).toHaveLength(1);
      expect(toolExecutions).toBe(0);
      expect((await workerCoordinator.getRun(started.run.id)).run).toMatchObject({
        status: "cancelled",
        phase: "cancelled"
      });
    } finally {
      await store.close();
    }
  });

  it("启动恢复会把上次进程遗留的 running run 收敛为 failed", async () => {
    const registry = new ToolRegistry();
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
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
    const toolCall = await store.createToolCall({
      sessionId: session.id,
      runId: run.id,
      messageId: assistantMessage.id,
      iteration: 0,
      toolCallId: "call_video",
      toolName: "generate_video",
      arguments: { prompt: "生成视频" },
      status: "running"
    });
    const resource = await store.createResource({
      sessionId: session.id,
      messageId: assistantMessage.id,
      toolCallRowId: toolCall.id,
      toolCallId: "call_video",
      type: "video",
      mime: "video/mp4",
      status: "pending",
      metadata: { prompt: "生成视频" }
    });
    const step = await store.createProcessStep({
      sessionId: session.id,
      runId: run.id,
      messageId: assistantMessage.id,
      toolCallRowId: toolCall.id,
      toolCallId: "call_video",
      kind: "tool",
      title: "正在生成视频",
      status: "running",
      orderIndex: 0
    });
    const coordinator = new AgentMessageCoordinator(createAgentService([{ content: "不会执行" }], registry), store);

    const result = await coordinator.cleanupStaleRunningExecutions("服务重启后清理遗留运行");

    expect(result).toEqual({
      runs: 1,
      messages: 1,
      toolCalls: 1,
      resources: 1,
      processSteps: 1
    });
    expect(await store.getRun(run.id)).toMatchObject({
      status: "failed",
      phase: "failed",
      error: {
        code: "RUN_INTERRUPTED",
        message: "服务重启后清理遗留运行"
      },
      completedAt: expect.any(String)
    });
    expect(await store.getMessage(assistantMessage.id)).toMatchObject({
      status: "failed",
      parts: [{ type: "text", value: "本轮运行因服务重启中断，请重新生成。" }],
      error: {
        code: "RUN_INTERRUPTED",
        message: "服务重启后清理遗留运行"
      },
      completedAt: expect.any(String)
    });
    expect(await store.getToolCallsBySession(session.id)).toEqual([
      expect.objectContaining({
        id: toolCall.id,
        status: "failed",
        error: {
          code: "RUN_INTERRUPTED",
          message: "服务重启后清理遗留运行"
        },
        completedAt: expect.any(String)
      })
    ]);
    expect(await store.getResourcesByMessages([assistantMessage.id])).toEqual([
      expect.objectContaining({
        id: resource.id,
        status: "failed",
        metadata: {
          prompt: "生成视频",
          error: {
            code: "RUN_INTERRUPTED",
            message: "服务重启后清理遗留运行"
          }
        }
      })
    ]);
    expect(await store.getProcessStepsByMessages([assistantMessage.id])).toEqual([
      expect.objectContaining({
        id: step.id,
        status: "failed",
        completedAt: expect.any(String)
      })
    ]);
    await store.close();
  });

  it("shutdown 会取消当前进程内的 running run", async () => {
    const registry = new ToolRegistry();
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(createAgentServiceWithModel(createHangingMockModel(), registry), store);
    const started = await coordinator.startRun({ input: "生成长任务" });

    await coordinator.shutdown("服务关闭");

    const snapshot = await coordinator.getRun(started.run.id);
    expect(snapshot.run).toMatchObject({
      status: "cancelled",
      phase: "cancelled",
      completedAt: expect.any(String)
    });
    await store.close();
  });

  it("run 会在本轮回答前执行上下文压缩，并用 system message 展示压缩状态", async () => {
    const summaryCalls: string[][] = [];
    const registry = new ToolRegistry();
    const model = createMockModel([
      { content: "第 1 轮回答" },
      { content: "第 2 轮回答" },
      { content: "第 3 轮回答" }
    ]);
    const summaryProvider: LlmProvider = {
      complete: async ({ messages }) => {
        summaryCalls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return {
          content: JSON.stringify({
            userGoal: "理解 Agent 上下文压缩",
            currentTask: "实现 run 级压缩前置",
            decisions: ["压缩属于当前 run 的前置步骤"],
            preferences: ["中文解释"],
            constraints: ["压缩提示可见但不进入 LLM 上下文"],
            importantFacts: ["第一轮问题已经回答"],
            openQuestions: [],
            recentProgress: ["已在第三轮回答前完成压缩"]
          })
        };
      }
    };
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(
      createAgentServiceWithModel(model, registry),
      store,
      new AgentContextBuilder({ maxHistoryMessages: 10 }),
      new AgentSummaryService({
        provider: summaryProvider,
        triggerMessageCount: 3,
        keepRecentMessages: 2,
        triggerCharacterCount: 0
      })
    );

    try {
      const first = await coordinator.startRun({ input: "第一轮问题" });
      await waitForRun(coordinator, first.run.id);
      const second = await coordinator.startRun({ sessionId: first.session.id, input: "第二轮问题" });
      await waitForRun(coordinator, second.run.id);
      const third = await coordinator.startRun({ sessionId: first.session.id, input: "第三轮问题" });
      await waitForRun(coordinator, third.run.id);

      const systemMessage = (await store.getMessagesBySession(first.session.id)).find((message) => message.role === "system");

      expect(systemMessage).toMatchObject({
        role: "system",
        status: "completed",
        parts: [{ type: "text", value: "上下文已自动压缩" }]
      });
      expect(summaryCalls).toHaveLength(1);
      expect(summaryCalls[0]?.join("\n")).toContain("第一轮问题");
      expect(summaryCalls[0]?.join("\n")).not.toContain("第三轮问题");
      expect(formatBaseMessages(model.calls[2]!)).toEqual([
        expect.stringMatching(/^system:/),
        expect.stringContaining("以下是此前对话的结构化摘要"),
        "user:第二轮问题",
        "assistant:第 2 轮回答",
        "user:第三轮问题"
      ]);
      expect(formatBaseMessages(model.calls[2]!).join("\n")).not.toContain("上下文自动压缩");
    } finally {
      await store.close();
    }
  });

  it("重新生成会使用目标回答当时可用的 summary 版本，不混入后续对话", async () => {
    const registry = new ToolRegistry();
    const model = createMockModel([{ content: "重新生成的回答" }]);
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const session = await store.createSession("重新生成会话");
    const backgroundUser = await store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "背景：只讨论 Agent 架构" }]
    });
    const backgroundAssistant = await store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "已记录 Agent 架构背景" }]
    });
    await store.upsertSessionSummary({
      sessionId: session.id,
      coveredMessageId: backgroundAssistant.id,
      summary: {
        userGoal: "理解 Agent 架构",
        currentTask: "",
        decisions: ["只包含背景"],
        preferences: [],
        constraints: [],
        importantFacts: [],
        openQuestions: [],
        recentProgress: []
      }
    });
    const targetUser = await store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "介绍一下 Agent Runtime" }]
    });
    const targetAssistant = await store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "旧回答" }]
    });
    const futureUser = await store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "后续再加入图片生成" }]
    });
    const futureAssistant = await store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "未来回答" }]
    });
    await store.upsertSessionSummary({
      sessionId: session.id,
      coveredMessageId: futureAssistant.id,
      summary: {
        userGoal: "理解 Agent 架构和图片生成",
        currentTask: "",
        decisions: ["包含后续图片生成"],
        preferences: [],
        constraints: [],
        importantFacts: [],
        openQuestions: [],
        recentProgress: []
      }
    });
    const coordinator = new AgentMessageCoordinator(
      createAgentServiceWithModel(model, registry),
      store,
      new AgentContextBuilder({ maxHistoryMessages: 10 })
    );

    try {
      const regenerated = await coordinator.regenerateMessage(targetAssistant.id);

      await waitForRun(coordinator, regenerated.run.id);

      const prompt = formatBaseMessages(model.calls[0] ?? []).join("\n");
      const messages = (await coordinator.getSession(session.id)).messages;
      const regeneratedAssistant = messages.find(
        (message) => message.role === "assistant" && message.parts[0]?.type === "text" && message.parts[0].value === "重新生成的回答"
      );

      expect(regenerated.userMessage.id).toBe(targetUser.id);
      expect(regeneratedAssistant).toBeDefined();
      expect(prompt).toContain("只包含背景");
      expect(prompt).toContain("介绍一下 Agent Runtime");
      expect(prompt).not.toContain("包含后续图片生成");
      expect(prompt).not.toContain("后续再加入图片生成");
      expect(prompt).not.toContain("未来回答");
    } finally {
      await store.close();
    }
  });

  it("重新生成资源回答时复用目标回答的工具参数，避免连续重试丢失批量数量", async () => {
    const executedArguments: unknown[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "generate_image",
      description: "生成图片",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          items: { type: "array" }
        }
      },
      argumentSchema: z.object({
        prompt: z.string().optional(),
        items: z
          .array(
            z.object({
              prompt: z.string()
            })
          )
          .optional()
      }),
      execute: (args) => {
        executedArguments.push(args);
        const prompts = Array.isArray(args.items)
          ? args.items.map((item) => item.prompt)
          : [args.prompt ?? "单张"];

        return {
          provider: "test_image",
          status: "done",
          imageUrls: prompts.map((prompt) => `https://example.com/${encodeURIComponent(prompt)}.png`),
          items: prompts.map((prompt, index) => ({
            index,
            status: "success",
            prompt,
            imageUrls: [`https://example.com/${encodeURIComponent(prompt)}.png`]
          }))
        };
      }
    });
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const session = await store.createSession("连续重试资源回答");
    const targetUser = await store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "生成两张图：小猫和小狗" }]
    });
    const targetAssistant = await store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "两张图片已生成。" }]
    });
    await store.createToolCall({
      sessionId: session.id,
      messageId: targetAssistant.id,
      iteration: 0,
      toolCallId: "call_original_batch",
      toolName: "generate_image",
      status: "succeeded",
      arguments: {
        items: [{ prompt: "小猫" }, { prompt: "小狗" }]
      }
    });
    const coordinator = new AgentMessageCoordinator(createAgentService([{ content: "图片已重新生成。" }], registry), store);

    try {
      const regenerated = await coordinator.regenerateMessage(targetAssistant.id);

      await waitForRun(coordinator, regenerated.run.id);
      const completedRun = (await coordinator.getRun(regenerated.run.id)).run;
      const regeneratedAssistant = completedRun.assistantMessageId ? await store.getMessage(completedRun.assistantMessageId) : undefined;
      const resourceParts = regeneratedAssistant?.parts.filter((part) => part.type === "resource") ?? [];

      expect(regenerated.userMessage.id).toBe(targetUser.id);
      expect(executedArguments).toEqual([
        {
          items: [{ prompt: "小猫" }, { prompt: "小狗" }]
        }
      ]);
      expect(resourceParts).toHaveLength(2);
    } finally {
      await store.close();
    }
  });

  it("重新生成由重试产生的回答时使用 run 记录的原始用户消息，而不是最近用户消息", async () => {
    const registry = new ToolRegistry();
    const model = createMockModel([{ content: "回答 1" }, { content: "回答 2" }]);
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const session = await store.createSession("连续重试原始用户绑定");
    const originalUser = await store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "生成两张图：小猫和小狗" }]
    });
    const originalAssistant = await store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "两张图片已生成。" }]
    });
    await store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "后续很远的另一个问题" }]
    });
    await store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "后续回答" }]
    });
    const coordinator = new AgentMessageCoordinator(createAgentServiceWithModel(model, registry), store);

    try {
      const firstRegeneration = await coordinator.regenerateMessage(originalAssistant.id);

      await waitForRun(coordinator, firstRegeneration.run.id);
      const firstRegeneratedAssistantId = (await coordinator.getRun(firstRegeneration.run.id)).run.assistantMessageId;

      if (!firstRegeneratedAssistantId) {
        throw new Error("first regenerated assistant was not created");
      }

      const secondRegeneration = await coordinator.regenerateMessage(firstRegeneratedAssistantId);

      await waitForRun(coordinator, secondRegeneration.run.id);

      const answerInputs = model.calls.map((messages) => {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const message = messages[i]!;
          if (message instanceof HumanMessage) {
            return typeof message.content === "string" ? message.content : "";
          }
        }
        return "";
      });

      expect(firstRegeneration.userMessage.id).toBe(originalUser.id);
      expect(secondRegeneration.userMessage.id).toBe(originalUser.id);
      expect(answerInputs).toEqual([
        "生成两张图：小猫和小狗",
        "生成两张图：小猫和小狗"
      ]);
    } finally {
      await store.close();
    }
  });

  it("run 压缩成功入库后，即使回答阶段被取消，下次 run 也不会重复压缩同一段消息", async () => {
    const summaryCalls: string[][] = [];
    const registry = new ToolRegistry();
    let shouldHangOnAnswer = false;
    let answerCallStarted = false;
    const answerCalls: BaseMessage[][] = [];
    const answerStream = async (messages?: unknown, opts?: { signal?: AbortSignal }) => {
      if (Array.isArray(messages)) {
        answerCalls.push(messages as BaseMessage[]);
      }
      answerCallStarted = true;
      if (shouldHangOnAnswer) {
        await new Promise<void>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
      return (async function* () {
        yield { content: "回答" };
      })();
    };
    const answerModel = {
      bindTools: () => ({ stream: answerStream, invoke: answerStream }),
      stream: answerStream,
      invoke: answerStream,
      calls: answerCalls
    } as unknown as MockModel;
    const summaryProvider: LlmProvider = {
      complete: async ({ messages }) => {
        summaryCalls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return {
          content: JSON.stringify({
            userGoal: "理解 Agent 上下文压缩",
            currentTask: "验证压缩持久化边界",
            decisions: ["摘要成功后立即入库"],
            preferences: ["中文解释"],
            constraints: [],
            importantFacts: ["第一轮问题已经回答"],
            openQuestions: [],
            recentProgress: ["摘要已持久化"]
          })
        };
      }
    };
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(
      createAgentServiceWithModel(answerModel, registry),
      store,
      new AgentContextBuilder({ maxHistoryMessages: 10 }),
      new AgentSummaryService({
        provider: summaryProvider,
        triggerMessageCount: 3,
        keepRecentMessages: 2,
        triggerCharacterCount: 0
      })
    );

    try {
      const first = await coordinator.startRun({ input: "第一轮问题" });
      await waitForRun(coordinator, first.run.id);
      const second = await coordinator.startRun({ sessionId: first.session.id, input: "第二轮问题" });
      await waitForRun(coordinator, second.run.id);
      const third = await coordinator.startRun({ sessionId: first.session.id, input: "第三轮问题" });
      await waitForSessionSummary(store, first.session.id);

      const summaryAfterCompression = await store.getSessionSummary(first.session.id);
      shouldHangOnAnswer = true;
      answerCallStarted = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (answerCallStarted) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!answerCallStarted) {
        throw new Error("third run answer call did not start in time");
      }
      await coordinator.cancelRun(third.run.id);
      await waitForRun(coordinator, third.run.id);
      shouldHangOnAnswer = false;

      expect(summaryAfterCompression?.coveredMessageId).toBe((await coordinator.getRun(first.run.id)).run.assistantMessageId);
      expect((await store.getSessionSummary(first.session.id))?.coveredMessageId).toBe(summaryAfterCompression?.coveredMessageId);

      const fourth = await coordinator.startRun({ sessionId: first.session.id, input: "第四轮问题" });
      await waitForRun(coordinator, fourth.run.id);

      expect(summaryCalls).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("短消息虽然超过条数阈值，但有效内容太少时不会触发 run 前置压缩", async () => {
    const summaryCalls: string[][] = [];
    const registry = new ToolRegistry();
    const summaryProvider: LlmProvider = {
      complete: async ({ messages }) => {
        summaryCalls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return {
          content: JSON.stringify({
            userGoal: "理解上下文压缩",
            currentTask: "避免短消息刷屏触发压缩",
            decisions: [],
            preferences: [],
            constraints: [],
            importantFacts: [],
            openQuestions: [],
            recentProgress: []
          })
        };
      }
    };
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(
      createAgentService([{ content: "好" }], registry),
      store,
      new AgentContextBuilder({ maxHistoryMessages: 10 }),
      new AgentSummaryService({
        provider: summaryProvider,
        triggerMessageCount: 3,
        keepRecentMessages: 1,
        triggerCharacterCount: 80
      })
    );

    try {
      let sessionId: string | undefined;

      for (const input of ["1", "2", "3", "4", "5"]) {
        const started = await coordinator.startRun({ sessionId, input });
        sessionId = started.session.id;
        await waitForRun(coordinator, started.run.id);
      }

      const systemMessages = (await store.getMessagesBySession(sessionId ?? "")).filter((message) => message.role === "system");
      expect(summaryCalls).toHaveLength(0);
      expect(systemMessages).toHaveLength(0);
      expect(await store.getSessionSummary(sessionId ?? "")).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("大量取消消息不会占掉待压缩窗口，未压缩上下文总量超过阈值时会触发压缩", async () => {
    const summaryCalls: string[][] = [];
    const registry = new ToolRegistry();
    const summaryProvider: LlmProvider = {
      complete: async ({ messages }) => {
        summaryCalls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return {
          content: JSON.stringify({
            userGoal: "验证上下文压缩触发",
            currentTask: "过滤取消消息后压缩旧内容",
            decisions: [],
            preferences: [],
            constraints: [],
            importantFacts: ["旧内容已进入摘要"],
            openQuestions: [],
            recentProgress: []
          })
        };
      }
    };
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const session = await store.createSession("压缩窗口");
    const coveredMessage = await store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "已覆盖内容" }]
    });

    await store.upsertSessionSummary({
      sessionId: session.id,
      coveredMessageId: coveredMessage.id,
      summary: {
        userGoal: "已有摘要",
        currentTask: "继续对话",
        decisions: [],
        preferences: [],
        constraints: [],
        importantFacts: [],
        openQuestions: [],
        recentProgress: []
      }
    });

    for (let index = 0; index < 9; index += 1) {
      await store.createMessage({
        sessionId: session.id,
        role: "user",
        status: "completed",
        parts: [{ type: "text", value: "1" }]
      });
      await store.createMessage({
        sessionId: session.id,
        role: "assistant",
        status: "cancelled",
        parts: [{ type: "text", value: "" }]
      });
    }

    const oldLongContent = `旧内容${"很长".repeat(750)}`;
    const recentLongContent = `最近长回复${"保留".repeat(750)}`;

    await store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: oldLongContent }]
    });
    await store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "最近问题" }]
    });
    await store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: recentLongContent }]
    });

    const coordinator = new AgentMessageCoordinator(
      createAgentService([{ content: "继续回答" }], registry),
      store,
      new AgentContextBuilder({ maxHistoryMessages: 10 }),
      new AgentSummaryService({
        provider: summaryProvider,
        triggerMessageCount: 3,
        keepRecentMessages: 2,
        triggerCharacterCount: 2000
      })
    );

    try {
      const started = await coordinator.startRun({ sessionId: session.id, input: "下一轮" });
      await waitForRun(coordinator, started.run.id);

      const summaryPrompt = summaryCalls[0]?.join("\n") ?? "";

      expect(summaryCalls).toHaveLength(1);
      expect(summaryPrompt).toContain(oldLongContent.slice(0, 40));
      expect(summaryPrompt).not.toContain(recentLongContent.slice(0, 40));
      expect((await store.getMessagesBySession(session.id)).some((message) => message.role === "system")).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("启动同一 session 的新 assistant message 时使用历史 messages 构造上下文", async () => {
    const registry = new ToolRegistry();
    const model = createMockModel([
      { content: "第 1 轮回答" },
      { content: "第 2 轮回答" },
      { content: "第 3 轮回答" }
    ]);
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(
      createAgentServiceWithModel(model, registry),
      store,
      new AgentContextBuilder({ maxHistoryMessages: 2 })
    );

    try {
      const first = await startRunAndWait(coordinator, { input: "第一轮问题" });
      await waitForMessage(coordinator, first.assistantMessage.id);
      const second = await startRunAndWait(coordinator, { sessionId: first.session.id, input: "第二轮问题" });
      await waitForMessage(coordinator, second.assistantMessage.id);
      const third = await startRunAndWait(coordinator, { sessionId: first.session.id, input: "第三轮问题" });
      await waitForMessage(coordinator, third.assistantMessage.id);

      expect(formatBaseMessages(model.calls[2]!)).toEqual([
        expect.stringMatching(/^system:/),
        "user:第二轮问题",
        "assistant:第 2 轮回答",
        "user:第三轮问题"
      ]);
    } finally {
      await store.close();
    }
  });

  it("读取 session 时只返回最近一页消息，并暴露继续加载历史的游标", async () => {
    const registry = new ToolRegistry();
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(createAgentService([{ content: "固定回答" }], registry), store);
    const session = await store.createSession("长会话");
    const messages: { id: string }[] = [];
    for (let index = 0; index < 5; index += 1) {
      messages.push(
        await store.createMessage({
          sessionId: session.id,
          role: index % 2 === 0 ? "user" : "assistant",
          status: "completed",
          parts: [{ type: "text", value: `历史消息 ${index + 1}` }]
        })
      );
    }

    try {
      const snapshot = await coordinator.getSession(session.id, { messageLimit: 2 });
      const previousPage = await coordinator.getSessionMessages(session.id, {
        before: snapshot.pageInfo.nextCursor,
        messageLimit: 2
      });

      expect(snapshot.messages.map((message) => message.id)).toEqual([messages[3].id, messages[4].id]);
      expect(snapshot.pageInfo).toEqual({
        hasMore: true,
        nextCursor: messages[3].id,
        limit: 2
      });
      expect(previousPage.messages.map((message) => message.id)).toEqual([messages[1].id, messages[2].id]);
      expect(previousPage.pageInfo).toEqual({
        hasMore: true,
        nextCursor: messages[1].id,
        limit: 2
      });
    } finally {
      await store.close();
    }
  });

  it("图片工具结果写入资源表，并让 assistant resource part 引用资源", async () => {
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
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const resourceStorage = {
      storeRemoteResource: async () => ({
        url: "http://127.0.0.1:4001/uploads/resources/images/local-pig.png",
        mime: "image/png",
        name: "local-pig.png",
        size: 123,
        relativePath: "resources/images/local-pig.png"
      })
    };
    const coordinator = new AgentMessageCoordinator(
      createAgentService(
        [
          { toolCalls: [{ id: "call_image", name: "generate_image", args: { prompt: "小猪" } }] },
          { content: "图片已生成。" }
        ],
        registry
      ),
      store,
      undefined,
      undefined,
      undefined,
      resourceStorage
    );

    try {
      const started = await startRunAndWait(coordinator, { input: "生成一张小猪图片" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const session = await coordinator.getSession(started.session.id);
      const assistant = session.messages.find((message) => message.id === started.assistantMessage.id);
      const resourcePart = assistant?.parts.find((part) => part.type === "resource");
      const resourceId = resourcePart?.extra?.resource?.id;

      expect(resourceId).toMatch(/^res_/);
      expect(resourcePart).toMatchObject({
        type: "resource",
        mime: "image/png",
        url: "http://127.0.0.1:4001/uploads/resources/images/local-pig.png",
        extra: {
          lifecycle: { state: "succeeded" },
          generation: { prompt: "小猪", provider: "test_image" }
        }
      });
      expect(session.messages).toEqual([
        expect.objectContaining({
          role: "user",
          parts: [{ type: "text", value: "生成一张小猪图片" }]
        }),
        expect.objectContaining({
          role: "assistant",
          parts: [
            expect.objectContaining({
              type: "resource",
              extra: expect.objectContaining({
                resource: { id: resourceId },
                tool: expect.objectContaining({
                  name: "generate_image",
                  toolCallId: "call_image",
                  toolCallRowId: expect.stringMatching(/^tool_call_/),
                  outputIndex: 0
                })
              })
            }),
            { type: "text", value: "图片已生成。" }
          ]
        })
      ]);
      expect(session.resources).toEqual([
        expect.objectContaining({
          id: resourceId,
          messageId: started.assistantMessage.id,
          toolCallId: "call_image",
          type: "image",
          mime: "image/png",
          status: "succeeded",
          url: "http://127.0.0.1:4001/uploads/resources/images/local-pig.png",
          metadata: { prompt: "小猪", provider: "test_image" }
        })
      ]);
    } finally {
      await store.close();
    }
  });

  it("视频工具结果写入资源表，并让 assistant resource part 引用资源", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "generate_video",
      description: "生成视频",
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
        provider: "test_video",
        prompt,
        videoUrls: ["https://example.com/pig.mp4"],
        frames: 121,
        aspectRatio: "16:9"
      })
    });
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const resourceStorage = {
      storeRemoteResource: async () => ({
        url: "http://127.0.0.1:4001/uploads/resources/videos/local-pig.mp4",
        mime: "video/mp4",
        name: "local-pig.mp4",
        size: 456,
        relativePath: "resources/videos/local-pig.mp4"
      })
    };
    const coordinator = new AgentMessageCoordinator(
      createAgentService(
        [
          { toolCalls: [{ id: "call_video", name: "generate_video", args: { prompt: "小猪在草地奔跑" } }] },
          { content: "视频已生成。" }
        ],
        registry
      ),
      store,
      undefined,
      undefined,
      undefined,
      resourceStorage
    );

    try {
      const started = await startRunAndWait(coordinator, { input: "生成一段小猪视频" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const session = await coordinator.getSession(started.session.id);
      const assistant = session.messages.find((message) => message.id === started.assistantMessage.id);
      const resourcePart = assistant?.parts.find((part) => part.type === "resource");
      const resourceId = resourcePart?.extra?.resource?.id;

      expect(resourceId).toMatch(/^res_/);
      expect(resourcePart).toMatchObject({
        type: "resource",
        mime: "video/mp4",
        url: "http://127.0.0.1:4001/uploads/resources/videos/local-pig.mp4",
        extra: {
          lifecycle: { state: "succeeded" },
          generation: { prompt: "小猪在草地奔跑", provider: "test_video" }
        }
      });
      expect(session.messages).toEqual([
        expect.objectContaining({
          role: "user",
          parts: [{ type: "text", value: "生成一段小猪视频" }]
        }),
        expect.objectContaining({
          role: "assistant",
          parts: [
            expect.objectContaining({
              type: "resource",
              extra: expect.objectContaining({
                resource: { id: resourceId },
                tool: expect.objectContaining({
                  name: "generate_video",
                  toolCallId: "call_video",
                  toolCallRowId: expect.stringMatching(/^tool_call_/),
                  outputIndex: 0
                })
              })
            }),
            { type: "text", value: "视频已生成。" }
          ]
        })
      ]);
      expect(session.resources).toEqual([
        expect.objectContaining({
          id: resourceId,
          messageId: started.assistantMessage.id,
          toolCallId: "call_video",
          type: "video",
          mime: "video/mp4",
          status: "succeeded",
          url: "http://127.0.0.1:4001/uploads/resources/videos/local-pig.mp4",
          metadata: {
            prompt: "小猪在草地奔跑",
            provider: "test_video",
            frames: 121,
            aspectRatio: "16:9"
          }
        })
      ]);
    } finally {
      await store.close();
    }
  });

  it("文档工具结果写入资源表，并让 assistant resource part 引用资源", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "generate_document",
      description: "生成文档",
      parameters: {
        type: "object",
        properties: {
          format: { type: "string" },
          fileName: { type: "string" },
          content: { type: "string" }
        },
        required: ["format", "content"]
      },
      argumentSchema: z.object({
        format: z.enum(["txt", "markdown", "docx"]),
        fileName: z.string().optional(),
        content: z.string()
      }),
      execute: ({ content }) => ({
        data: {
          provider: "agent_document",
          status: "done",
          documents: [
            {
              name: "年度复盘.md",
              mime: "text/markdown",
              contentBase64: Buffer.from(String(content), "utf8").toString("base64"),
              size: Buffer.byteLength(String(content), "utf8")
            }
          ]
        },
        llmContent: "已生成文档：年度复盘.md"
      })
    });
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const storedGeneratedResources: unknown[] = [];
    const resourceStorage = {
      storeRemoteResource: async () => {
        throw new Error("文档资源不应该走远端 URL 转储");
      },
      storeGeneratedResource: async (input: unknown) => {
        storedGeneratedResources.push(input);
        return {
          url: "http://127.0.0.1:4001/uploads/resources/documents/local-review.md",
          mime: "text/markdown",
          name: "年度复盘.md",
          size: 28,
          relativePath: "resources/documents/local-review.md"
        };
      }
    };
    const coordinator = new AgentMessageCoordinator(
      createAgentService(
        [
          {
            toolCalls: [
              {
                id: "call_document",
                name: "generate_document",
                args: { format: "markdown", fileName: "年度复盘", content: "# 年度复盘\n\n增长 20%" }
              }
            ]
          },
          { content: "文档已生成。" }
        ],
        registry
      ),
      store,
      undefined,
      undefined,
      undefined,
      resourceStorage
    );

    try {
      const started = await startRunAndWait(coordinator, { input: "生成一份年度复盘 Markdown 文档" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const session = await coordinator.getSession(started.session.id);
      const assistant = session.messages.find((message) => message.id === started.assistantMessage.id);
      const resourcePart = assistant?.parts.find((part) => part.type === "resource");
      const resourceId = resourcePart?.extra?.resource?.id;

      expect(storedGeneratedResources).toEqual([
        expect.objectContaining({
          type: "document",
          mime: "text/markdown",
          fileName: "年度复盘.md",
          bytes: Buffer.from("# 年度复盘\n\n增长 20%", "utf8")
        })
      ]);
      expect(resourceId).toMatch(/^res_/);
      expect(resourcePart).toMatchObject({
        type: "resource",
        mime: "text/markdown",
        url: "http://127.0.0.1:4001/uploads/resources/documents/local-review.md",
        name: "年度复盘.md",
        extra: {
          lifecycle: { state: "succeeded" },
          generation: { provider: "agent_document" }
        }
      });
      expect(session.resources).toEqual([
        expect.objectContaining({
          id: resourceId,
          messageId: started.assistantMessage.id,
          toolCallId: "call_document",
          type: "document",
          mime: "text/markdown",
          name: "年度复盘.md",
          status: "succeeded",
          url: "http://127.0.0.1:4001/uploads/resources/documents/local-review.md",
          metadata: expect.objectContaining({
            provider: "agent_document",
            outputIndex: 0,
            size: 28
          })
        })
      ]);
    } finally {
      await store.close();
    }
  });

  it("图片编辑工具结果也写入资源表，并让 assistant resource part 引用资源", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "edit_image",
      description: "编辑图片",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          imageUrl: { type: "string" }
        },
        required: ["prompt", "imageUrl"]
      },
      argumentSchema: z.object({
        prompt: z.string(),
        imageUrl: z.string().url()
      }),
      execute: ({ prompt, imageUrl }) => ({
        provider: "test_seededit",
        prompt,
        imageUrl,
        imageUrls: ["https://example.com/edited-pig.png"]
      })
    });
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(
      createAgentService(
        [
          {
            toolCalls: [
              {
                id: "call_edit_image",
                name: "edit_image",
                args: {
                  prompt: "把小猪改成水彩风格",
                  imageUrl: "https://cdn.example.com/source-pig.png"
                }
              }
            ]
          },
          { content: "图片已编辑完成。" }
        ],
        registry
      ),
      store
    );

    try {
      const started = await startRunAndWait(coordinator, { input: "把这张小猪图改成水彩风格" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const session = await coordinator.getSession(started.session.id);
      const assistant = session.messages.find((message) => message.id === started.assistantMessage.id);
      const resourcePart = assistant?.parts.find((part) => part.type === "resource");
      const resourceId = resourcePart?.extra?.resource?.id;

      expect(resourceId).toMatch(/^res_/);
      expect(resourcePart).toMatchObject({
        type: "resource",
        mime: "image/png",
        url: "https://example.com/edited-pig.png",
        extra: {
          lifecycle: { state: "succeeded" },
          resource: { id: resourceId },
          tool: {
            name: "edit_image",
            toolCallId: "call_edit_image",
            toolCallRowId: expect.stringMatching(/^tool_call_/),
            outputIndex: 0
          },
          generation: { prompt: "把小猪改成水彩风格", provider: "test_seededit" }
        }
      });
      expect(session.resources).toEqual([
        expect.objectContaining({
          id: resourceId,
          messageId: started.assistantMessage.id,
          toolCallId: "call_edit_image",
          type: "image",
          mime: "image/png",
          status: "succeeded",
          url: "https://example.com/edited-pig.png",
          metadata: {
            prompt: "把小猪改成水彩风格",
            provider: "test_seededit",
            sourceImageUrl: "https://cdn.example.com/source-pig.png"
          }
        })
      ]);
    } finally {
      await store.close();
    }
  });

  it("流式回答会更新 assistant message 的 text part", async () => {
    const registry = new ToolRegistry();
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(createAgentService([{ content: "你好世界" }], registry), store);

    try {
      const started = await startRunAndWait(coordinator, { input: "问候一下" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const { message } = await coordinator.getMessage(started.assistantMessage.id);

      expect(message.parts).toEqual([{ type: "text", value: "你好世界" }]);
    } finally {
      await store.close();
    }
  });

  it("运行中 snapshot 使用 running draft，持久化 message 完成后才写最终 parts", async () => {
    const registry = new ToolRegistry();
    const firstDeltaReceived = createDeferred<void>();
    const allowFinish = createDeferred<void>();
    const controlledStream = async () => {
      return (async function* () {
        yield { content: "正在生成" };
        firstDeltaReceived.resolve();
        await allowFinish.promise;
        yield { content: "完成" };
      })();
    };
    const controlledModel = {
      bindTools: () => ({ stream: controlledStream, invoke: controlledStream }),
      stream: controlledStream,
      invoke: controlledStream,
      calls: [] as BaseMessage[][]
    } as unknown as MockModel;
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(createAgentServiceWithModel(controlledModel, registry), store);

    try {
      const started = await coordinator.startRun({ input: "写一段话" });

      await firstDeltaReceived.promise;
      const assistantMessageId = await waitForRunAssistantMessageId(coordinator, started.run.id);

      expect((await store.getMessage(assistantMessageId))?.parts).toEqual([]);

      const runningSnapshot = await coordinator.getMessageSnapshot(assistantMessageId);
      expect(runningSnapshot).toMatchObject({ version: 1 });
      expect(runningSnapshot.message.parts).toEqual([{ type: "text", value: "正在生成" }]);

      allowFinish.resolve();
      await waitForRun(coordinator, started.run.id);

      expect((await store.getMessage(assistantMessageId))?.parts).toEqual([{ type: "text", value: "正在生成完成" }]);
    } finally {
      allowFinish.resolve();
      await store.close();
    }
  });

  it("图片工具结果会发出资源事件并保留消息 part 引用", async () => {
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
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(
      createAgentService(
        [
          { toolCalls: [{ id: "call_image", name: "generate_image", args: { prompt: "小猪" } }] },
          { content: "图片已生成。" }
        ],
        registry
      ),
      store
    );

    try {
      const started = await startRunAndWait(coordinator, { input: "生成一张小猪图片" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const { message } = await coordinator.getMessage(started.assistantMessage.id);
      const resourcePart = message.parts.find((part) => part.type === "resource");
      const resourceId = resourcePart?.extra?.resource?.id;

      expect(resourceId).toMatch(/^res_/);
      expect(resourcePart).toMatchObject({
        type: "resource",
        mime: "image/png",
        url: "https://example.com/pig.png",
        extra: {
          lifecycle: { state: "succeeded" },
          generation: { prompt: "小猪", provider: "test_image" }
        }
      });
      expect(message.parts).toEqual([
        expect.objectContaining({
          type: "resource",
          extra: expect.objectContaining({
            resource: { id: resourceId },
            tool: {
              name: "generate_image",
              toolCallId: "call_image",
              toolCallRowId: expect.stringMatching(/^tool_call_/),
              outputIndex: 0
            }
          })
        }),
        { type: "text", value: "图片已生成。" }
      ]);
    } finally {
      await store.close();
    }
  });

  it("运行过程会投影成可持久化的产品化任务进度步骤", async () => {
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
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(
      createAgentService(
        [
          { toolCalls: [{ id: "call_image", name: "generate_image", args: { prompt: "小猪" } }] },
          { content: "图片已生成。" }
        ],
        registry
      ),
      store
    );

    try {
      const started = await startRunAndWait(coordinator, { input: "生成一张小猪图片" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const detail = await coordinator.getMessage(started.assistantMessage.id);

      expect(detail.processSteps).toEqual([
        expect.objectContaining({
          kind: "thinking",
          title: "已理解需求",
          status: "succeeded",
          orderIndex: 0
        }),
        expect.objectContaining({
          kind: "tool",
          title: "图片已生成",
          status: "succeeded",
          orderIndex: 1,
          toolCallId: "call_image",
          metadata: expect.objectContaining({
            toolName: "generate_image",
            prompt: "小猪"
          })
        }),
        expect.objectContaining({
          kind: "summary",
          title: "已整理回答",
          status: "succeeded",
          orderIndex: 2
        })
      ]);
    } finally {
      await store.close();
    }
  });

  it("纯文本回答的过程步骤不暴露模型内部文案", async () => {
    const registry = new ToolRegistry();
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(
      createAgentService([{ content: "Agent 会先理解用户需求，再决定是否调用工具。" }], registry),
      store
    );

    try {
      const started = await startRunAndWait(coordinator, { input: "解释一下 Agent 流程" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const detail = await coordinator.getMessage(started.assistantMessage.id);

      expect(detail.processSteps).toEqual([
        expect.objectContaining({
          kind: "thinking",
          title: "已生成回答",
          summary: "回答已生成",
          status: "succeeded",
          orderIndex: 0
        })
      ]);
      expect(detail.processSteps.map((step) => step.title).join("\n")).not.toContain("模型");
    } finally {
      await store.close();
    }
  });

  it("批量图片部分失败后保留失败占位并无工具总结原因", async () => {
    const registry = new ToolRegistry();
    let executeCount = 0;

    registry.register({
      name: "generate_image",
      description: "生成图片",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          items: { type: "array" }
        }
      },
      argumentSchema: z.object({
        prompt: z.string().optional(),
        items: z
          .array(
            z.object({
              prompt: z.string(),
              width: z.number().optional(),
              height: z.number().optional()
            })
          )
          .optional()
      }),
      execute: () => {
        executeCount += 1;

        return {
          provider: "test_image",
          status: "partial_failed",
          total: 2,
          succeeded: 1,
          failed: 1,
          imageUrls: ["https://example.com/dog.png"],
          items: [
            {
              index: 0,
              status: "failed",
              prompt: "宝宝",
              error: "并发限制"
            },
            {
              index: 1,
              status: "success",
              prompt: "狗狗",
              imageUrls: ["https://example.com/dog.png"]
            }
          ]
        };
      }
    });

    const toolCountsByCall: number[] = [];
    const summaryPrompts: string[][] = [];
    const allCalls: BaseMessage[][] = [];
    let boundToolCount = 0;
    let callCount = 0;
    const pickResponse = (): MockModelResponse => {
      const responses: MockModelResponse[] = [
        {
          toolCalls: [
            {
              id: "call_batch",
              name: "generate_image",
              args: {
                items: [
                  { prompt: "宝宝", width: 1328, height: 1328 },
                  { prompt: "狗狗", width: 1328, height: 1328 }
                ]
              }
            }
          ]
        },
        { content: "狗狗图片已生成，宝宝图片因并发限制失败。可以稍后再试。" }
      ];
      const response = responses[Math.min(callCount, responses.length - 1)];
      callCount += 1;
      return response;
    };
    const streamFromResponse = async (response: MockModelResponse) => {
      const chunks = mockResponseToChunks(response);
      return (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })();
    };
    const boundStream = async (messages?: unknown) => {
      if (Array.isArray(messages)) allCalls.push(messages as BaseMessage[]);
      toolCountsByCall.push(boundToolCount);
      return streamFromResponse(pickResponse());
    };
    const summaryStream = async (messages?: unknown) => {
      if (Array.isArray(messages)) {
        const arr = messages as BaseMessage[];
        allCalls.push(arr);
        summaryPrompts.push(formatBaseMessages(arr));
      }
      toolCountsByCall.push(0);
      return streamFromResponse(pickResponse());
    };
    const boundTarget = { stream: boundStream, invoke: boundStream };
    const batchModel = {
      bindTools: (tools: unknown[]) => {
        boundToolCount = tools.length;
        return boundTarget;
      },
      stream: summaryStream,
      invoke: summaryStream,
      calls: allCalls
    } as unknown as MockModel;
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const coordinator = new AgentMessageCoordinator(createAgentServiceWithModel(batchModel, registry), store);

    try {
      const started = await startRunAndWait(coordinator, { input: "分别生成宝宝和狗狗图片" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const session = await coordinator.getSession(started.session.id);
      const assistant = session.messages.find((message) => message.id === started.assistantMessage.id);
      const resourceParts = assistant?.parts.filter((part) => part.type === "resource") ?? [];
      const resourcesById = new Map(session.resources.map((resource) => [resource.id, resource]));

      expect(executeCount).toBe(1);
      expect(callCount).toBe(2);
      expect(toolCountsByCall).toEqual([1, 0]);
      expect(summaryPrompts[0]).toEqual(
        expect.arrayContaining([
          expect.stringContaining("最多 2 句"),
          expect.stringContaining("不要表格"),
          expect.stringContaining("不要分点"),
          expect.stringContaining("不要再次调用工具")
        ])
      );
      expect(summaryPrompts[0].join("\n")).not.toContain("总结哪些内容已成功、哪些内容失败");
      expect(assistant?.parts.find((part) => part.type === "text")).toEqual({
        type: "text",
        value: "狗狗图片已生成，宝宝图片因并发限制失败。可以稍后再试。"
      });
      expect(resourceParts).toHaveLength(2);
      expect(resourceParts.map((part) => resourcesById.get(part.extra?.resource?.id ?? "")?.metadata?.prompt)).toEqual([
        "宝宝",
        "狗狗"
      ]);
      expect(resourceParts.map((part) => resourcesById.get(part.extra?.resource?.id ?? "")?.url)).toEqual([
        undefined,
        "https://example.com/dog.png"
      ]);
      expect(resourceParts.map((part) => part.extra?.lifecycle?.state)).toEqual(["failed", "succeeded"]);
      expect(resourceParts.map((part) => (part.type === "resource" ? part.url : undefined))).toEqual([
        undefined,
        "https://example.com/dog.png"
      ]);
    } finally {
      await store.close();
    }
  });
});
