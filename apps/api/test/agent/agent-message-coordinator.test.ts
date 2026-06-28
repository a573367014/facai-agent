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
      coordinator.cancelRun(third.run.id);
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
        before: snapshot.pageInfo.oldestCursor,
        messageLimit: 2
      });

      expect(snapshot.messages.map((message) => message.id)).toEqual([messages[3].id, messages[4].id]);
      expect(snapshot.pageInfo).toEqual({
        hasMore: true,
        oldestCursor: messages[3].id,
        limit: 2
      });
      expect(previousPage.messages.map((message) => message.id)).toEqual([messages[1].id, messages[2].id]);
      expect(previousPage.pageInfo).toEqual({
        hasMore: true,
        oldestCursor: messages[1].id,
        limit: 2
      });
    } finally {
      store.close();
    }
  });

  it("图片工具结果写入 assistant message 的 media parts", async () => {
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
      const session = coordinator.getSession(started.session.id);

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
              url: "https://example.com/pig.png"
            })
          ]
        })
      ]);
    } finally {
      store.close();
    }
  });

  it("流式回答会更新 assistant message 的 text part 并发出 part delta 事件", async () => {
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
      ).toEqual([
        { type: "message.part.delta", messageId: started.assistantMessage.id, partIndex: 0, delta: "你好" },
        { type: "message.part.delta", messageId: started.assistantMessage.id, partIndex: 0, delta: "世界" }
      ]);
    } finally {
      store.close();
    }
  });

  it("图片工具结果会写入 assistant message 的 media parts", async () => {
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

      expect(message.parts).toEqual([
        { type: "text", value: "图片已生成。" },
        expect.objectContaining({
          type: "media",
          mime: "image/png",
          url: "https://example.com/pig.png",
          extra: expect.objectContaining({
            lifecycle: { state: "succeeded" },
            tool: { name: "generate_image", toolCallId: "call_image", outputIndex: 0 },
            generation: { prompt: "小猪", provider: "test_image" }
          })
        })
      ]);
      expect(events.map((event) => event.event.type)).toContain("message.part.created");
      expect(events.map((event) => event.event.type)).toContain("message.part.updated");
    } finally {
      store.close();
    }
  });
});
