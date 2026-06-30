import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentContextBuilder } from "../../src/agent/context-builder.js";
import { AgentMessageCoordinator } from "../../src/agent/agent-message-coordinator.js";
import { AgentSummaryService } from "../../src/agent/agent-summary-service.js";
import { SqliteAgentStore } from "../../src/agent/sqlite-agent-store.js";
import { AgentService } from "../../src/agent/agent-service.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";

let tempDirs: string[] = [];

function createTempDatabasePath() {
  const dir = mkdtempSync(join(tmpdir(), "agent-coordinator-"));
  tempDirs.push(dir);
  return join(dir, "agent.sqlite");
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function waitForMessage(coordinator: AgentMessageCoordinator, messageId: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { message } = coordinator.getMessage(messageId);

    if (message.status !== "running") {
      return message;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("message did not finish in time");
}

async function waitForRun(coordinator: AgentMessageCoordinator, runId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { run } = coordinator.getRun(runId);

    if (run.status !== "running") {
      return run;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("run did not finish in time");
}

async function waitForSessionSummary(store: SqliteAgentStore, sessionId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const summary = store.getSessionSummary(sessionId);

    if (summary) {
      return summary;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("summary did not finish in time");
}

async function waitForEventType(store: SqliteAgentStore, messageId: string, eventType: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const event = store.getEvents(messageId).find((storedEvent) => storedEvent.event.type === eventType);

    if (event) {
      return event.event;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`event ${eventType} did not appear in time`);
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

function createAgentService(provider: LlmProvider, registry: ToolRegistry) {
  return new AgentService({
    provider,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({ registry, timeoutMs: 100 }),
    defaultMaxIterations: 4
  });
}

describe("AgentMessageCoordinator", () => {
  it("启动恢复会把上次进程遗留的 running run 收敛为 failed", async () => {
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async () => ({ content: "不会执行" })
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const session = store.createSession("遗留运行");
    const userMessage = store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "再生产" }]
    });
    const assistantMessage = store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });
    const run = store.createRun({
      sessionId: session.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      status: "running",
      phase: "answering"
    });
    const toolCall = store.createToolCall({
      sessionId: session.id,
      runId: run.id,
      messageId: assistantMessage.id,
      iteration: 0,
      toolCallId: "call_video",
      toolName: "generate_video",
      arguments: { prompt: "生成视频" },
      status: "running"
    });
    const resource = store.createResource({
      sessionId: session.id,
      messageId: assistantMessage.id,
      toolCallRowId: toolCall.id,
      toolCallId: "call_video",
      type: "video",
      mime: "video/mp4",
      status: "pending",
      metadata: { prompt: "生成视频" }
    });
    const step = store.createProcessStep({
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
    const coordinator = new AgentMessageCoordinator(createAgentService(provider, registry), store);

    const result = await coordinator.cleanupStaleRunningExecutions("服务重启后清理遗留运行");

    expect(result).toEqual({
      runs: 1,
      messages: 1,
      toolCalls: 1,
      resources: 1,
      processSteps: 1
    });
    expect(store.getRun(run.id)).toMatchObject({
      status: "failed",
      phase: "failed",
      error: {
        code: "RUN_INTERRUPTED",
        message: "服务重启后清理遗留运行"
      },
      completedAt: expect.any(String)
    });
    expect(store.getMessage(assistantMessage.id)).toMatchObject({
      status: "failed",
      parts: [{ type: "text", value: "本轮运行因服务重启中断，请重新生成。" }],
      error: {
        code: "RUN_INTERRUPTED",
        message: "服务重启后清理遗留运行"
      },
      completedAt: expect.any(String)
    });
    expect(store.getToolCallsBySession(session.id)).toEqual([
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
    expect(store.getResourcesByMessages([assistantMessage.id])).toEqual([
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
    expect(store.getProcessStepsByMessages([assistantMessage.id])).toEqual([
      expect.objectContaining({
        id: step.id,
        status: "failed",
        completedAt: expect.any(String)
      })
    ]);
    expect(store.getRunEvents(run.id).map((event) => event.event.type)).toEqual(
      expect.arrayContaining(["process.step.updated", "error", "session.message.updated"])
    );
    store.close();
  });

  it("shutdown 会取消当前进程内的 running run", async () => {
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async ({ signal }) => {
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });

        return { content: "不会完成" };
      }
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const coordinator = new AgentMessageCoordinator(createAgentService(provider, registry), store);
    const started = await coordinator.startRun({ input: "生成长任务" });

    await coordinator.shutdown("服务关闭");

    const snapshot = coordinator.getRun(started.run.id);
    expect(snapshot.run).toMatchObject({
      status: "cancelled",
      phase: "cancelled",
      completedAt: expect.any(String)
    });
    expect(snapshot.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: {
            type: "session.message.created",
            message: expect.objectContaining({
              id: started.userMessage.id
            })
          }
        }),
        expect.objectContaining({
          event: {
            type: "cancelled",
            reason: "服务关闭"
          }
        })
      ])
    );
    store.close();
  });

  it("run 会在本轮回答前执行上下文压缩，并用 system message 展示压缩状态", async () => {
    const answerCalls: string[][] = [];
    const summaryCalls: string[][] = [];
    const registry = new ToolRegistry();
    const answerProvider: LlmProvider = {
      complete: async ({ messages }) => {
        answerCalls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return { content: `第 ${answerCalls.length} 轮回答` };
      }
    };
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

    try {
      const first = await coordinator.startRun({ input: "第一轮问题" });
      await waitForRun(coordinator, first.run.id);
      const second = await coordinator.startRun({ sessionId: first.session.id, input: "第二轮问题" });
      await waitForRun(coordinator, second.run.id);
      const third = await coordinator.startRun({ sessionId: first.session.id, input: "第三轮问题" });
      await waitForRun(coordinator, third.run.id);

      const thirdSnapshot = coordinator.getRun(third.run.id);
      const thirdEvents = thirdSnapshot.events.map((event) => event.event);
      const thirdEventTypes = thirdEvents.map((event) => event.type);
      const systemMessage = store.getMessagesBySession(first.session.id).find((message) => message.role === "system");
      const assistantCreatedIndex = thirdEventTypes.findIndex(
        (type, index) => type === "session.message.created" && thirdEvents[index]?.type === "session.message.created" && thirdEvents[index].message.role === "assistant"
      );
      const summaryCompletedIndex = thirdEventTypes.indexOf("summary_completed");

      expect(systemMessage).toMatchObject({
        role: "system",
        status: "completed",
        parts: [{ type: "text", value: "上下文已自动压缩" }]
      });
      expect(thirdEventTypes).toEqual(expect.arrayContaining(["summary_start", "summary_completed", "final_answer", "run_completed"]));
      expect(summaryCompletedIndex).toBeGreaterThanOrEqual(0);
      expect(assistantCreatedIndex).toBeGreaterThan(summaryCompletedIndex);
      expect(summaryCalls).toHaveLength(1);
      expect(summaryCalls[0]?.join("\n")).toContain("第一轮问题");
      expect(summaryCalls[0]?.join("\n")).not.toContain("第三轮问题");
      expect(answerCalls[2]).toEqual([
        expect.stringMatching(/^system:/),
        expect.stringContaining("以下是此前对话的结构化摘要"),
        "user:第二轮问题",
        "assistant:第 2 轮回答",
        "user:第三轮问题"
      ]);
      expect(answerCalls[2]?.join("\n")).not.toContain("上下文自动压缩");
    } finally {
      store.close();
    }
  });

  it("重新生成会使用目标回答当时可用的 summary 版本，不混入后续对话", async () => {
    const answerCalls: string[][] = [];
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async ({ messages }) => {
        answerCalls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return { content: "重新生成的回答" };
      }
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const session = store.createSession("重新生成会话");
    const backgroundUser = store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "背景：只讨论 Agent 架构" }]
    });
    const backgroundAssistant = store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "已记录 Agent 架构背景" }]
    });
    store.upsertSessionSummary({
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
    const targetUser = store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "介绍一下 Agent Runtime" }]
    });
    const targetAssistant = store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "旧回答" }]
    });
    const futureUser = store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "后续再加入图片生成" }]
    });
    const futureAssistant = store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "未来回答" }]
    });
    store.upsertSessionSummary({
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
      createAgentService(provider, registry),
      store,
      new AgentContextBuilder({ maxHistoryMessages: 10 })
    );

    try {
      const regenerated = await coordinator.regenerateMessage(targetAssistant.id);

      await waitForRun(coordinator, regenerated.run.id);

      const prompt = answerCalls[0]?.join("\n") ?? "";
      const messages = coordinator.getSession(session.id).messages;
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
      store.close();
    }
  });

  it("run 压缩成功入库后，即使回答阶段被取消，下次 run 也不会重复压缩同一段消息", async () => {
    const summaryCalls: string[][] = [];
    const registry = new ToolRegistry();
    let answerCount = 0;
    const answerProvider: LlmProvider = {
      complete: async ({ messages, signal }) => {
        answerCount += 1;

        if (answerCount === 3) {
          await new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        }

        return { content: `第 ${answerCount} 轮回答` };
      }
    };
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

    try {
      const first = await coordinator.startRun({ input: "第一轮问题" });
      await waitForRun(coordinator, first.run.id);
      const second = await coordinator.startRun({ sessionId: first.session.id, input: "第二轮问题" });
      await waitForRun(coordinator, second.run.id);
      const third = await coordinator.startRun({ sessionId: first.session.id, input: "第三轮问题" });
      await waitForSessionSummary(store, first.session.id);

      const summaryAfterCompression = store.getSessionSummary(first.session.id);
      await coordinator.cancelRun(third.run.id);
      await waitForRun(coordinator, third.run.id);

      expect(summaryAfterCompression?.coveredMessageId).toBe(coordinator.getRun(first.run.id).run.assistantMessageId);
      expect(store.getSessionSummary(first.session.id)?.coveredMessageId).toBe(summaryAfterCompression?.coveredMessageId);

      const fourth = await coordinator.startRun({ sessionId: first.session.id, input: "第四轮问题" });
      await waitForRun(coordinator, fourth.run.id);

      expect(summaryCalls).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("短消息虽然超过条数阈值，但有效内容太少时不会触发 run 前置压缩", async () => {
    const summaryCalls: string[][] = [];
    const registry = new ToolRegistry();
    const answerProvider: LlmProvider = {
      complete: async () => ({ content: "好" })
    };
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
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const coordinator = new AgentMessageCoordinator(
      createAgentService(answerProvider, registry),
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

      const systemMessages = store.getMessagesBySession(sessionId ?? "").filter((message) => message.role === "system");
      expect(summaryCalls).toHaveLength(0);
      expect(systemMessages).toHaveLength(0);
      expect(store.getSessionSummary(sessionId ?? "")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("大量取消消息不会占掉待压缩窗口，未压缩上下文总量超过阈值时会触发压缩", async () => {
    const summaryCalls: string[][] = [];
    const registry = new ToolRegistry();
    const answerProvider: LlmProvider = {
      complete: async () => ({ content: "继续回答" })
    };
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
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const session = store.createSession("压缩窗口");
    const coveredMessage = store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "已覆盖内容" }]
    });

    store.upsertSessionSummary({
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
      store.createMessage({
        sessionId: session.id,
        role: "user",
        status: "completed",
        parts: [{ type: "text", value: "1" }]
      });
      store.createMessage({
        sessionId: session.id,
        role: "assistant",
        status: "cancelled",
        parts: [{ type: "text", value: "" }]
      });
    }

    const oldLongContent = `旧内容${"很长".repeat(750)}`;
    const recentLongContent = `最近长回复${"保留".repeat(750)}`;

    store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: oldLongContent }]
    });
    store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "最近问题" }]
    });
    store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: recentLongContent }]
    });

    const coordinator = new AgentMessageCoordinator(
      createAgentService(answerProvider, registry),
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
      expect(store.getMessagesBySession(session.id).some((message) => message.role === "system")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("消息完成后滚动生成结构化摘要，后续上下文使用摘要加最近原文", async () => {
    const answerCalls: string[][] = [];
    const summaryCalls: string[][] = [];
    const registry = new ToolRegistry();
    const answerProvider: LlmProvider = {
      complete: async ({ messages }) => {
        answerCalls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return { content: `第 ${answerCalls.length} 轮回答` };
      }
    };
    const summaryProvider: LlmProvider = {
      complete: async ({ messages }) => {
        summaryCalls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return {
          content: JSON.stringify({
            userGoal: "理解 Agent 上下文压缩",
            currentTask: "实现阶段 2",
            decisions: ["使用结构化摘要加最近原文"],
            preferences: ["中文解释"],
            constraints: [],
            importantFacts: ["第一轮问题已经回答"],
            openQuestions: [],
            recentProgress: ["已压缩第一轮对话"]
          })
        };
      }
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

    try {
      const first = await coordinator.startMessage({ input: "第一轮问题" });
      await waitForMessage(coordinator, first.assistantMessage.id);
      const second = await coordinator.startMessage({ sessionId: first.session.id, input: "第二轮问题" });
      await waitForMessage(coordinator, second.assistantMessage.id);
      const summary = await waitForSessionSummary(store, first.session.id);
      const third = await coordinator.startMessage({ sessionId: first.session.id, input: "第三轮问题" });
      await waitForMessage(coordinator, third.assistantMessage.id);

      expect(summary.coveredMessageId).toBe(first.assistantMessage.id);
      expect(summary.summary.decisions).toEqual(["使用结构化摘要加最近原文"]);
      expect(summaryCalls.length).toBeGreaterThanOrEqual(1);
      expect(summaryCalls[0]?.join("\n")).toContain("第一轮问题");
      expect(answerCalls[2]).toEqual([
        expect.stringMatching(/^system:/),
        expect.stringContaining("以下是此前对话的结构化摘要"),
        "user:第二轮问题",
        "assistant:第 2 轮回答",
        "user:第三轮问题"
      ]);
    } finally {
      store.close();
    }
  });

  it("摘要刷新保持静默，不插入可见 system 状态消息，也不写入 assistant 事件", async () => {
    const answerCalls: string[][] = [];
    const summaryCalls: string[][] = [];
    const registry = new ToolRegistry();
    const answerProvider: LlmProvider = {
      complete: async ({ messages }) => {
        answerCalls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return { content: `第 ${answerCalls.length} 轮回答` };
      }
    };
    const summaryProvider: LlmProvider = {
      complete: async ({ messages }) => {
        summaryCalls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return {
          content: JSON.stringify({
            userGoal: "理解上下文压缩",
            currentTask: "让压缩过程静默执行",
            decisions: ["摘要只写入 session summary"],
            preferences: ["中文"],
            constraints: ["摘要过程不插入可见 system 状态消息"],
            importantFacts: ["第二轮后触发摘要"],
            openQuestions: [],
            recentProgress: ["已刷新 session summary"]
          })
        };
      }
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

    try {
      const first = await coordinator.startMessage({ input: "第一轮问题" });
      await waitForMessage(coordinator, first.assistantMessage.id);
      const second = await coordinator.startMessage({ sessionId: first.session.id, input: "第二轮问题" });
      await waitForMessage(coordinator, second.assistantMessage.id);
      await waitForSessionSummary(store, first.session.id);
      const third = await coordinator.startMessage({ sessionId: first.session.id, input: "第三轮问题" });
      await waitForMessage(coordinator, third.assistantMessage.id);

      const sessionMessages = store.getMessagesBySession(first.session.id);
      const secondEventTypes = store.getEvents(second.assistantMessage.id).map((event) => event.event.type);
      const thirdEventTypes = store.getEvents(third.assistantMessage.id).map((event) => event.event.type);

      expect(sessionMessages.some((message) => message.role === "system")).toBe(false);
      expect(secondEventTypes).toEqual(expect.arrayContaining(["message.part.updated", "final_answer", "run_completed"]));
      expect(secondEventTypes).not.toContain("session.message.created");
      expect(secondEventTypes).not.toContain("summary_start");
      expect(secondEventTypes).not.toContain("session.message.updated");
      expect(secondEventTypes).not.toContain("summary_completed");
      expect(thirdEventTypes).toEqual(expect.arrayContaining(["message.part.updated", "final_answer", "run_completed"]));
      expect(summaryCalls[0]?.join("\n")).not.toContain("上下文自动压缩");

      expect(answerCalls[2]?.join("\n")).not.toContain("上下文自动压缩");
    } finally {
      store.close();
    }
  });

  it("摘要仍在运行时 assistant 已完成，摘要完成后才用 run_completed 收口", async () => {
    const summaryContent = JSON.stringify({
      userGoal: "理解上下文压缩",
      currentTask: "验证摘要静默收口",
      decisions: ["助手回复完成后刷新摘要"],
      preferences: ["中文"],
      constraints: [],
      importantFacts: ["摘要可能比回答慢"],
      openQuestions: [],
      recentProgress: ["等待摘要完成后再发送 run_completed"]
    });
    const summaryGate = createDeferred<string>();
    const registry = new ToolRegistry();
    const answerProvider: LlmProvider = {
      complete: async () => ({ content: "固定回答" })
    };
    const summaryProvider: LlmProvider = {
      complete: async () => ({
        content: await summaryGate.promise
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

    let secondMessageId = "";

    try {
      const first = await coordinator.startMessage({ input: "第一轮问题" });
      await waitForMessage(coordinator, first.assistantMessage.id);
      const second = await coordinator.startMessage({ sessionId: first.session.id, input: "第二轮问题" });
      secondMessageId = second.assistantMessage.id;
      await waitForEventType(store, second.assistantMessage.id, "final_answer");

      const messageDuringSummary = store.getMessage(second.assistantMessage.id);
      const eventTypesDuringSummary = store.getEvents(second.assistantMessage.id).map((event) => event.event.type);

      expect(messageDuringSummary?.status).toBe("completed");
      expect(eventTypesDuringSummary).toContain("final_answer");
      expect(eventTypesDuringSummary).not.toContain("run_completed");
      expect(store.getMessagesBySession(first.session.id).some((message) => message.role === "system")).toBe(false);

      summaryGate.resolve(summaryContent);
      await waitForEventType(store, second.assistantMessage.id, "run_completed");
    } finally {
      summaryGate.resolve(summaryContent);
      if (secondMessageId) {
        await waitForMessage(coordinator, secondMessageId);
      }
      store.close();
    }
  });

  it("启动同一 session 的新 assistant message 时使用历史 messages 构造上下文", async () => {
    const calls: string[][] = [];
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async ({ messages }) => {
        calls.push(messages.map((message) => `${message.role}:${"content" in message ? message.content : ""}`));
        return { content: `第 ${calls.length} 轮回答` };
      }
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const coordinator = new AgentMessageCoordinator(
      createAgentService(provider, registry),
      store,
      new AgentContextBuilder({ maxHistoryMessages: 2 })
    );

    try {
      const first = await coordinator.startMessage({ input: "第一轮问题" });
      await waitForMessage(coordinator, first.assistantMessage.id);
      const second = await coordinator.startMessage({ sessionId: first.session.id, input: "第二轮问题" });
      await waitForMessage(coordinator, second.assistantMessage.id);
      const third = await coordinator.startMessage({ sessionId: first.session.id, input: "第三轮问题" });
      await waitForMessage(coordinator, third.assistantMessage.id);

      expect(calls[2]).toEqual([
        expect.stringMatching(/^system:/),
        "user:第二轮问题",
        "assistant:第 2 轮回答",
        "user:第三轮问题"
      ]);
    } finally {
      store.close();
    }
  });

  it("读取 session 时只返回最近一页消息，并暴露继续加载历史的游标", async () => {
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async () => ({ content: "固定回答" })
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const coordinator = new AgentMessageCoordinator(createAgentService(provider, registry), store);
    const session = store.createSession("长会话");
    const messages = Array.from({ length: 5 }, (_, index) =>
      store.createMessage({
        sessionId: session.id,
        role: index % 2 === 0 ? "user" : "assistant",
        status: "completed",
        parts: [{ type: "text", value: `历史消息 ${index + 1}` }]
      })
    );

    try {
      const snapshot = coordinator.getSession(session.id, { messageLimit: 2 });
      const previousPage = coordinator.getSessionMessages(session.id, {
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
      store.close();
    }
  });

  it("图片工具结果写入资源表，并让 assistant media part 引用资源", async () => {
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
                arguments: { prompt: "小猪" }
              }
            ]
          };
        }

        return { content: "图片已生成。" };
      }
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
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
      createAgentService(provider, registry),
      store,
      undefined,
      undefined,
      undefined,
      resourceStorage
    );

    try {
      const started = await coordinator.startMessage({ input: "生成一张小猪图片" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const session = coordinator.getSession(started.session.id);
      const assistant = session.messages.find((message) => message.id === started.assistantMessage.id);
      const mediaPart = assistant?.parts.find((part) => part.type === "media");
      const resourceId = mediaPart?.extra?.resource?.id;

      expect(resourceId).toMatch(/^res_/);
      expect(mediaPart).toMatchObject({
        type: "media",
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
            { type: "text", value: "图片已生成。" },
            expect.objectContaining({
              type: "media",
              extra: expect.objectContaining({
                resource: { id: resourceId },
                tool: expect.objectContaining({
                  name: "generate_image",
                  toolCallId: "call_image",
                  toolCallRowId: expect.stringMatching(/^tool_call_/),
                  outputIndex: 0
                })
              })
            })
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
      store.close();
    }
  });

  it("视频工具结果写入资源表，并让 assistant media part 引用资源", async () => {
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
    let callCount = 0;
    const provider: LlmProvider = {
      complete: async () => {
        callCount += 1;

        if (callCount === 1) {
          return {
            toolCalls: [
              {
                id: "call_video",
                name: "generate_video",
                arguments: { prompt: "小猪在草地奔跑" }
              }
            ]
          };
        }

        return { content: "视频已生成。" };
      }
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
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
      createAgentService(provider, registry),
      store,
      undefined,
      undefined,
      undefined,
      resourceStorage
    );

    try {
      const started = await coordinator.startMessage({ input: "生成一段小猪视频" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const session = coordinator.getSession(started.session.id);
      const assistant = session.messages.find((message) => message.id === started.assistantMessage.id);
      const mediaPart = assistant?.parts.find((part) => part.type === "media");
      const resourceId = mediaPart?.extra?.resource?.id;

      expect(resourceId).toMatch(/^res_/);
      expect(mediaPart).toMatchObject({
        type: "media",
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
            { type: "text", value: "视频已生成。" },
            expect.objectContaining({
              type: "media",
              extra: expect.objectContaining({
                resource: { id: resourceId },
                tool: expect.objectContaining({
                  name: "generate_video",
                  toolCallId: "call_video",
                  toolCallRowId: expect.stringMatching(/^tool_call_/),
                  outputIndex: 0
                })
              })
            })
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
      store.close();
    }
  });

  it("图片编辑工具结果也写入资源表，并让 assistant media part 引用资源", async () => {
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
    let callCount = 0;
    const provider: LlmProvider = {
      complete: async () => {
        callCount += 1;

        if (callCount === 1) {
          return {
            toolCalls: [
              {
                id: "call_edit_image",
                name: "edit_image",
                arguments: {
                  prompt: "把小猪改成水彩风格",
                  imageUrl: "https://cdn.example.com/source-pig.png"
                }
              }
            ]
          };
        }

        return { content: "图片已编辑完成。" };
      }
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const coordinator = new AgentMessageCoordinator(createAgentService(provider, registry), store);

    try {
      const started = await coordinator.startMessage({ input: "把这张小猪图改成水彩风格" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const session = coordinator.getSession(started.session.id);
      const assistant = session.messages.find((message) => message.id === started.assistantMessage.id);
      const mediaPart = assistant?.parts.find((part) => part.type === "media");
      const resourceId = mediaPart?.extra?.resource?.id;

      expect(resourceId).toMatch(/^res_/);
      expect(mediaPart).toMatchObject({
        type: "media",
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
      store.close();
    }
  });

  it("流式回答会更新 assistant message 的 text part，但不把 part delta 写入事件表", async () => {
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async () => {
        throw new Error("streaming path should be used");
      },
      completeStream: async (_request, onDelta) => {
        await onDelta("你好");
        await onDelta("世界");
        return { content: "你好世界" };
      }
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const coordinator = new AgentMessageCoordinator(createAgentService(provider, registry), store);

    try {
      const started = await coordinator.startMessage({ input: "问候一下" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const { message, events } = coordinator.getMessage(started.assistantMessage.id);

      expect(message.parts).toEqual([{ type: "text", value: "你好世界" }]);
      expect(
        events
          .map((event) => event.event)
          .filter((event) => event.type === "message.part.delta")
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("运行中 snapshot 使用 running draft，持久化 message 完成后才写最终 parts", async () => {
    const registry = new ToolRegistry();
    const firstDeltaReceived = createDeferred<void>();
    const allowFinish = createDeferred<void>();
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
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const coordinator = new AgentMessageCoordinator(createAgentService(provider, registry), store);

    try {
      const started = await coordinator.startMessage({ input: "写一段话" });

      await firstDeltaReceived.promise;

      expect(store.getMessage(started.assistantMessage.id)?.parts).toEqual([{ type: "text", value: "" }]);

      const runningSnapshot = await coordinator.getMessageSnapshot(started.assistantMessage.id);
      expect(runningSnapshot).toMatchObject({ version: 1 });
      expect(runningSnapshot.message.parts).toEqual([{ type: "text", value: "正在生成" }]);

      allowFinish.resolve();
      await waitForMessage(coordinator, started.assistantMessage.id);

      expect(store.getMessage(started.assistantMessage.id)?.parts).toEqual([{ type: "text", value: "正在生成完成" }]);
    } finally {
      allowFinish.resolve();
      store.close();
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
                arguments: { prompt: "小猪" }
              }
            ]
          };
        }

        return { content: "图片已生成。" };
      }
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const coordinator = new AgentMessageCoordinator(createAgentService(provider, registry), store);

    try {
      const started = await coordinator.startMessage({ input: "生成一张小猪图片" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const { message, events } = coordinator.getMessage(started.assistantMessage.id);
      const mediaPart = message.parts.find((part) => part.type === "media");
      const resourceId = mediaPart?.extra?.resource?.id;

      expect(resourceId).toMatch(/^res_/);
      expect(mediaPart).toMatchObject({
        type: "media",
        mime: "image/png",
        url: "https://example.com/pig.png",
        extra: {
          lifecycle: { state: "succeeded" },
          generation: { prompt: "小猪", provider: "test_image" }
        }
      });
      expect(message.parts).toEqual([
        { type: "text", value: "图片已生成。" },
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
      ]);
      expect(events.map((event) => event.event.type)).toContain("message.part.created");
      expect(events.map((event) => event.event.type)).toContain("message.part.updated");
      expect(events.map((event) => event.event.type)).toContain("resource.created");
      expect(events.map((event) => event.event.type)).toContain("resource.updated");
    } finally {
      store.close();
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
                arguments: { prompt: "小猪" }
              }
            ]
          };
        }

        return { content: "图片已生成。" };
      }
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const coordinator = new AgentMessageCoordinator(createAgentService(provider, registry), store);

    try {
      const started = await coordinator.startMessage({ input: "生成一张小猪图片" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const detail = coordinator.getMessage(started.assistantMessage.id);

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
      expect(detail.events.map((event) => event.event.type)).toEqual(expect.arrayContaining(["process.step.created", "process.step.updated"]));
    } finally {
      store.close();
    }
  });

  it("纯文本回答的过程步骤不暴露模型内部文案", async () => {
    const registry = new ToolRegistry();
    const provider: LlmProvider = {
      complete: async () => ({ content: "Agent 会先理解用户需求，再决定是否调用工具。" })
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const coordinator = new AgentMessageCoordinator(createAgentService(provider, registry), store);

    try {
      const started = await coordinator.startMessage({ input: "解释一下 Agent 流程" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const detail = coordinator.getMessage(started.assistantMessage.id);

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
      store.close();
    }
  });

  it("批量图片部分失败后重试时保留用户请求的图片顺序", async () => {
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

        if (executeCount === 1) {
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

        return {
          provider: "test_image",
          status: "done",
          prompt: "宝宝",
          imageUrls: ["https://example.com/baby.png"]
        };
      }
    });

    let callCount = 0;
    const provider: LlmProvider = {
      complete: async () => {
        callCount += 1;

        if (callCount === 1) {
          return {
            toolCalls: [
              {
                id: "call_batch",
                name: "generate_image",
                arguments: {
                  items: [
                    { prompt: "宝宝", width: 1328, height: 1328 },
                    { prompt: "狗狗", width: 1328, height: 1328 }
                  ]
                }
              }
            ]
          };
        }

        if (callCount === 2) {
          return {
            toolCalls: [
              {
                id: "call_retry_baby",
                name: "generate_image",
                arguments: { prompt: "宝宝", width: 1328, height: 1328 }
              }
            ]
          };
        }

        return { content: "两张图片已生成。" };
      }
    };
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    const coordinator = new AgentMessageCoordinator(createAgentService(provider, registry), store);

    try {
      const started = await coordinator.startMessage({ input: "分别生成宝宝和狗狗图片" });

      await waitForMessage(coordinator, started.assistantMessage.id);
      const session = coordinator.getSession(started.session.id);
      const assistant = session.messages.find((message) => message.id === started.assistantMessage.id);
      const mediaParts = assistant?.parts.filter((part) => part.type === "media") ?? [];
      const resourcesById = new Map(session.resources.map((resource) => [resource.id, resource]));
      const events = coordinator.getMessage(started.assistantMessage.id).events.map((event) => event.event);
      const mediaCreatedEvents = events.filter((event) => event.type === "message.part.created");
      const retryMediaUpdateEvent = events.find(
        (event) =>
          event.type === "message.part.updated" &&
          event.part.type === "media" &&
          event.part.extra?.tool?.toolCallId === "call_retry_baby"
      );

      expect(mediaParts).toHaveLength(2);
      expect(mediaParts.map((part) => resourcesById.get(part.extra?.resource?.id ?? "")?.metadata?.prompt)).toEqual([
        "宝宝",
        "狗狗"
      ]);
      expect(mediaParts.map((part) => resourcesById.get(part.extra?.resource?.id ?? "")?.url)).toEqual([
        "https://example.com/baby.png",
        "https://example.com/dog.png"
      ]);
      expect(mediaParts.map((part) => (part.type === "media" ? part.url : undefined))).toEqual([
        "https://example.com/baby.png",
        "https://example.com/dog.png"
      ]);
      expect(mediaCreatedEvents).toHaveLength(2);
      expect(retryMediaUpdateEvent).toMatchObject({
        type: "message.part.updated",
        partIndex: 1
      });
    } finally {
      store.close();
    }
  });
});
