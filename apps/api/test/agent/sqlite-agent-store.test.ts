import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAgentCancellationStore } from "../../src/agent/agent-cancellation-store.js";
import { InMemoryAgentEventBus } from "../../src/agent/agent-event-bus.js";
import { InMemoryAgentRunLock } from "../../src/agent/agent-run-lock.js";
import type { AgentRunJobPayload, AgentRunQueue } from "../../src/agent/agent-run-queue.js";
import { AgentService } from "../../src/agent/agent-service.js";
import { InMemoryRunningMessageStateStore } from "../../src/agent/running-message-state-store.js";
import { SqliteAgentStore } from "../../src/agent/sqlite-agent-store.js";
import { buildApp } from "../../src/app.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { MessagePart } from "../../src/agent/message-parts.js";

let tempDirs: string[] = [];

class NoopAgentRunQueue implements AgentRunQueue {
  async enqueueRun(_payload: AgentRunJobPayload): Promise<void> {}
}

function createTempDatabasePath() {
  const dir = mkdtempSync(join(tmpdir(), "agent-store-"));
  tempDirs.push(dir);
  return join(dir, "agent.sqlite");
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

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

describe("SqliteAgentStore", () => {
  it("保存知识库文档并且只搜索 ready 文档的 chunk", async () => {
    const databasePath = createTempDatabasePath();
    const store = await SqliteAgentStore.create({ databasePath });
    const readyDocument = store.createKnowledgeDocument({
      name: "员工手册.pdf",
      mimeType: "application/pdf",
      sourcePath: "/tmp/员工手册.pdf",
      contentHash: "ready-hash"
    });
    const indexingDocument = store.createKnowledgeDocument({
      name: "草稿制度.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sourcePath: "/tmp/草稿制度.docx",
      contentHash: "indexing-hash"
    });

    store.replaceKnowledgeChunks(readyDocument.id, [
      {
        chunkIndex: 0,
        content: "请假需要直属主管审批。",
        sourceLabel: "员工手册.pdf 第 3 页",
        embeddingModel: "test-embedding",
        embedding: [1, 0],
        metadata: { page: 3 }
      },
      {
        chunkIndex: 1,
        content: "报销需要提交发票。",
        sourceLabel: "员工手册.pdf 第 5 页",
        embeddingModel: "test-embedding",
        embedding: [0, 1]
      }
    ]);
    store.replaceKnowledgeChunks(indexingDocument.id, [
      {
        chunkIndex: 0,
        content: "草稿制度暂不应该被搜索。",
        sourceLabel: "草稿制度.docx",
        embeddingModel: "test-embedding",
        embedding: [1, 0]
      }
    ]);
    store.updateKnowledgeDocument(readyDocument.id, {
      status: "ready",
      chunkCount: 2,
      indexedAt: "2026-07-01T00:00:00.000Z"
    });
    store.updateKnowledgeDocument(indexingDocument.id, {
      status: "indexing"
    });

    const results = store.searchKnowledgeChunks({
      queryEmbedding: [1, 0],
      limit: 5
    });

    expect(results.map((result) => result.content)).toEqual(["请假需要直属主管审批。", "报销需要提交发票。"]);
    expect(results[0]).toMatchObject({
      documentId: readyDocument.id,
      documentName: "员工手册.pdf",
      sourceLabel: "员工手册.pdf 第 3 页",
      score: 1,
      metadata: { page: 3 }
    });
    expect(results.some((result) => result.documentId === indexingDocument.id)).toBe(false);

    store.deleteKnowledgeDocument(readyDocument.id);
    expect(store.getKnowledgeDocument(readyDocument.id)).toBeUndefined();
    expect(store.searchKnowledgeChunks({ queryEmbedding: [1, 0], limit: 5 })).toEqual([]);
    store.close();
  });

  it("支持按消息游标读取最近消息、历史消息和新增消息", async () => {
    const databasePath = createTempDatabasePath();
    const store = await SqliteAgentStore.create({ databasePath });
    const session = store.createSession("分页会话");
    const messages = Array.from({ length: 6 }, (_, index) =>
      store.createMessage({
        sessionId: session.id,
        role: index % 2 === 0 ? "user" : "assistant",
        status: "completed",
        parts: [{ type: "text", value: `消息 ${index + 1}` }]
      })
    );

    expect(store.getRecentMessagesBySession(session.id, 3).map((message) => message.id)).toEqual(
      messages.slice(3).map((message) => message.id)
    );
    expect(store.getMessagesBefore(session.id, messages[3].id, 2).map((message) => message.id)).toEqual([
      messages[1].id,
      messages[2].id
    ]);
    expect(store.countMessagesAfter(session.id, messages[1].id)).toBe(4);
    expect(store.getMessagesAfter(session.id, messages[1].id, 2).map((message) => message.id)).toEqual([
      messages[2].id,
      messages[3].id
    ]);
    expect(store.getRecentMessagesAfter(session.id, messages[1].id, 2).map((message) => message.id)).toEqual([
      messages[4].id,
      messages[5].id
    ]);
    store.close();
  });

  it("重新创建 store 后仍能读回结构化会话摘要", async () => {
    const databasePath = createTempDatabasePath();
    const firstStore = await SqliteAgentStore.create({ databasePath });
    const session = firstStore.createSession("摘要会话");
    const userMessage = firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "第一轮问题" }]
    });

    firstStore.upsertSessionSummary({
      sessionId: session.id,
      coveredMessageId: userMessage.id,
      summary: {
        userGoal: "理解 Agent 架构",
        currentTask: "实现结构化摘要",
        decisions: ["采用滚动摘要"],
        preferences: ["使用中文解释"],
        constraints: [],
        importantFacts: ["项目使用 SQLite"],
        openQuestions: [],
        recentProgress: ["已完成摘要表设计"]
      }
    });
    firstStore.close();

    const secondStore = await SqliteAgentStore.create({ databasePath });

    expect(secondStore.getSessionSummary(session.id)).toMatchObject({
      id: expect.any(String),
      sessionId: session.id,
      version: 1,
      coveredMessageId: userMessage.id,
      coveredMessageCreatedAt: userMessage.createdAt,
      schemaVersion: 1,
      summary: {
        userGoal: "理解 Agent 架构",
        currentTask: "实现结构化摘要",
        decisions: ["采用滚动摘要"]
      }
    });
    secondStore.close();
  });

  it("多个已打开 store 会在文件变化后读到彼此写入", async () => {
    const databasePath = createTempDatabasePath();
    const apiStore = await SqliteAgentStore.create({ databasePath });
    const workerStore = await SqliteAgentStore.create({ databasePath });

    try {
      const session = apiStore.createSession("queue session");
      const userMessage = apiStore.createMessage({
        sessionId: session.id,
        role: "user",
        status: "completed",
        parts: [{ type: "text", value: "排队执行" }]
      });
      const run = apiStore.createRun({
        sessionId: session.id,
        userMessageId: userMessage.id,
        status: "running",
        phase: "answering"
      });

      expect(workerStore.getRun(run.id)).toMatchObject({
        id: run.id,
        status: "running"
      });

      const assistantMessage = workerStore.createMessage({
        sessionId: session.id,
        role: "assistant",
        status: "completed",
        parts: [{ type: "text", value: "完成" }]
      });
      workerStore.updateRun(run.id, {
        status: "completed",
        phase: "completed",
        assistantMessageId: assistantMessage.id
      });

      expect(apiStore.getRun(run.id)).toMatchObject({
        id: run.id,
        status: "completed",
        phase: "completed",
        assistantMessageId: assistantMessage.id
      });
    } finally {
      apiStore.close();
      workerStore.close();
    }
  });

  it("按版本追加 session summary，并能查询某条消息之前可用的摘要", async () => {
    const databasePath = createTempDatabasePath();
    const firstStore = await SqliteAgentStore.create({ databasePath });
    const session = firstStore.createSession("摘要版本会话");
    const firstUser = firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "第一轮" }]
    });
    const firstAssistant = firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "第一轮回答" }]
    });
    const secondUser = firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "第二轮" }]
    });
    const secondAssistant = firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "第二轮回答" }]
    });

    const firstSummary = firstStore.upsertSessionSummary({
      sessionId: session.id,
      coveredMessageId: firstAssistant.id,
      summary: {
        userGoal: "只包含第一轮",
        currentTask: "",
        decisions: ["v1"],
        preferences: [],
        constraints: [],
        importantFacts: [],
        openQuestions: [],
        recentProgress: []
      }
    });
    const secondSummary = firstStore.upsertSessionSummary({
      sessionId: session.id,
      coveredMessageId: secondAssistant.id,
      summary: {
        userGoal: "包含第二轮",
        currentTask: "",
        decisions: ["v2"],
        preferences: [],
        constraints: [],
        importantFacts: [],
        openQuestions: [],
        recentProgress: []
      }
    });
    firstStore.close();

    const secondStore = await SqliteAgentStore.create({ databasePath });

    expect(secondStore.listSessionSummaries(session.id).map((summary) => summary.version)).toEqual([1, 2]);
    expect(secondStore.getSessionSummary(session.id)).toMatchObject({
      id: secondSummary.id,
      version: 2,
      summary: { decisions: ["v2"] }
    });
    expect(secondStore.getSessionSummaryBeforeMessage(session.id, firstUser.id)).toBeUndefined();
    expect(secondStore.getSessionSummaryBeforeMessage(session.id, secondUser.id)).toMatchObject({
      id: firstSummary.id,
      version: 1,
      summary: { decisions: ["v1"] }
    });
    secondStore.close();
  });

  it("重新创建 store 后仍能读回 message parts", async () => {
    const databasePath = createTempDatabasePath();
    const firstStore = await SqliteAgentStore.create({ databasePath });
    const session = firstStore.createSession("parts 会话");
    const parts: MessagePart[] = [{ type: "text", value: "你好" }];
    const message = firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts
    });
    firstStore.close();

    const secondStore = await SqliteAgentStore.create({ databasePath });

    expect(secondStore.getMessage(message.id)?.parts).toEqual(parts);
    secondStore.close();
  });

  it("能单独更新 message parts 且不改变状态", async () => {
    const databasePath = createTempDatabasePath();
    const store = await SqliteAgentStore.create({ databasePath });
    const session = store.createSession("parts 更新");
    const message = store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });

    const updated = store.updateMessageParts(message.id, [{ type: "text", value: "流式文本" }]);

    expect(updated?.status).toBe("running");
    expect(updated?.parts).toEqual([{ type: "text", value: "流式文本" }]);
    store.close();
  });

  it("拒绝把终态 message 重新改回 running 或其他终态", async () => {
    const databasePath = createTempDatabasePath();
    const store = await SqliteAgentStore.create({ databasePath });
    const session = store.createSession("消息状态机");
    const message = store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });

    store.updateMessage(message.id, {
      status: "cancelled",
      completedAt: "2026-06-28T10:00:00.000Z"
    });

    expect(() =>
      store.updateMessage(message.id, {
        status: "completed",
        parts: [{ type: "text", value: "迟到的完成结果" }],
        completedAt: "2026-06-28T10:00:01.000Z"
      })
    ).toThrow(/非法 message 状态流转/);
    expect(() => store.updateMessage(message.id, { status: "running" })).toThrow(/非法 message 状态流转/);
    expect(store.getMessage(message.id)).toMatchObject({
      status: "cancelled",
      parts: [{ type: "text", value: "" }]
    });
    store.close();
  });

  it("拒绝把终态 run 被后续异步回调覆盖", async () => {
    const databasePath = createTempDatabasePath();
    const store = await SqliteAgentStore.create({ databasePath });
    const session = store.createSession("run 状态机");
    const userMessage = store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "问题" }]
    });
    const run = store.createRun({
      sessionId: session.id,
      userMessageId: userMessage.id,
      status: "running",
      phase: "answering"
    });

    store.updateRun(run.id, {
      status: "cancelled",
      phase: "cancelled",
      completedAt: "2026-06-28T10:00:00.000Z"
    });

    expect(() =>
      store.updateRun(run.id, {
        status: "completed",
        phase: "completed",
        completedAt: "2026-06-28T10:00:01.000Z"
      })
    ).toThrow(/非法 run 状态流转/);
    expect(store.getRun(run.id)).toMatchObject({
      status: "cancelled",
      phase: "cancelled"
    });
    store.close();
  });

  it("拒绝 run 终态 status 和 phase 不一致", async () => {
    const databasePath = createTempDatabasePath();
    const store = await SqliteAgentStore.create({ databasePath });
    const session = store.createSession("run phase 状态机");
    const userMessage = store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "问题" }]
    });
    const run = store.createRun({
      sessionId: session.id,
      userMessageId: userMessage.id,
      status: "running",
      phase: "answering"
    });

    expect(() => store.updateRun(run.id, { status: "completed", phase: "answering" })).toThrow(
      /run 终态 phase 不一致/
    );
    expect(store.getRun(run.id)).toMatchObject({
      status: "running",
      phase: "answering"
    });
    store.close();
  });

  it("持久化工具调用流水，支持按会话聚合查询", async () => {
    const databasePath = createTempDatabasePath();
    const firstStore = await SqliteAgentStore.create({ databasePath });
    const session = firstStore.createSession("工具审计");
    const assistantMessage = firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });
    const toolCall = firstStore.createToolCall({
      sessionId: session.id,
      messageId: assistantMessage.id,
      iteration: 0,
      toolCallId: "call_image",
      toolName: "generate_image",
      arguments: { prompt: "小猪" }
    });

    firstStore.updateToolCall(toolCall.id, {
      status: "succeeded",
      durationMs: 123,
      resultSummary: { outputCount: 1 }
    });
    firstStore.close();

    const secondStore = await SqliteAgentStore.create({ databasePath });

    expect(secondStore.getToolCallsBySession(session.id)).toEqual([
      expect.objectContaining({
        id: toolCall.id,
        sessionId: session.id,
        messageId: assistantMessage.id,
        iteration: 0,
        toolCallId: "call_image",
        toolName: "generate_image",
        status: "succeeded",
        arguments: { prompt: "小猪" },
        resultSummary: { outputCount: 1 },
        durationMs: 123,
        completedAt: expect.any(String)
      })
    ]);
    secondStore.close();
  });

  it("持久化资源实体，支持按消息批量查询", async () => {
    const databasePath = createTempDatabasePath();
    const firstStore = await SqliteAgentStore.create({ databasePath });
    const session = firstStore.createSession("资源会话");
    const assistantMessage = firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });
    const toolCall = firstStore.createToolCall({
      sessionId: session.id,
      messageId: assistantMessage.id,
      iteration: 0,
      toolCallId: "call_image",
      toolName: "generate_image",
      arguments: { prompt: "小猪" }
    });
    const resource = firstStore.createResource({
      sessionId: session.id,
      messageId: assistantMessage.id,
      toolCallId: "call_image",
      toolCallRowId: toolCall.id,
      type: "image",
      mime: "image/png",
      status: "pending",
      metadata: { prompt: "小猪", provider: "test_image" }
    });

    firstStore.updateResource(resource.id, {
      status: "succeeded",
      url: "https://example.com/pig.png",
      width: 1024,
      height: 1024
    });
    firstStore.close();

    const secondStore = await SqliteAgentStore.create({ databasePath });

    expect(secondStore.getResourcesByMessages([assistantMessage.id])).toEqual([
      expect.objectContaining({
        id: resource.id,
        sessionId: session.id,
        messageId: assistantMessage.id,
        toolCallId: "call_image",
        toolCallRowId: toolCall.id,
        type: "image",
        mime: "image/png",
        status: "succeeded",
        url: "https://example.com/pig.png",
        width: 1024,
        height: 1024,
        metadata: { prompt: "小猪", provider: "test_image" }
      })
    ]);
    secondStore.close();
  });

  it("持久化过程步骤，支持按消息恢复产品化任务进度", async () => {
    const databasePath = createTempDatabasePath();
    const firstStore = await SqliteAgentStore.create({ databasePath });
    const session = firstStore.createSession("过程步骤会话");
    const assistantMessage = firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });
    const step = firstStore.createProcessStep({
      sessionId: session.id,
      messageId: assistantMessage.id,
      kind: "tool",
      title: "正在查找资料",
      summary: "搜索关键词：厦门上膳 人均 招牌菜",
      status: "running",
      orderIndex: 1,
      metadata: { toolName: "web_search", toolCallId: "call_search" }
    });

    firstStore.updateProcessStep(step.id, {
      title: "资料已查找",
      summary: "已搜索 5 个网页",
      status: "succeeded",
      metadata: { toolName: "web_search", toolCallId: "call_search", resultCount: 5 }
    });
    firstStore.close();

    const secondStore = await SqliteAgentStore.create({ databasePath });

    expect(secondStore.getProcessStepsByMessages([assistantMessage.id])).toEqual([
      expect.objectContaining({
        id: step.id,
        sessionId: session.id,
        messageId: assistantMessage.id,
        kind: "tool",
        title: "资料已查找",
        summary: "已搜索 5 个网页",
        status: "succeeded",
        orderIndex: 1,
        metadata: { toolName: "web_search", toolCallId: "call_search", resultCount: 5 },
        completedAt: expect.any(String)
      })
    ]);
    secondStore.close();
  });

  it("重新创建 store 后仍能读回 session 和 messages", async () => {
    const databasePath = createTempDatabasePath();
    const firstStore = await SqliteAgentStore.create({ databasePath });
    const session = firstStore.createSession("图片会话");
    const userMessage = firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "生成图片" }]
    });
    const assistantMessage = firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });

    firstStore.updateMessage(assistantMessage.id, {
      status: "completed",
      parts: [{ type: "text", value: "你好世界" }],
      completedAt: "2026-06-25T00:00:01.000Z"
    });
    firstStore.close();

    const secondStore = await SqliteAgentStore.create({ databasePath });
    expect(secondStore.getSession(session.id)).toMatchObject({
      id: session.id,
      title: "图片会话"
    });
    expect(secondStore.getMessagesBySession(session.id)).toEqual([
      expect.objectContaining({
        id: userMessage.id,
        role: "user",
        status: "completed",
        parts: [{ type: "text", value: "生成图片" }]
      }),
      expect.objectContaining({
        id: assistantMessage.id,
        role: "assistant",
        status: "completed",
        parts: [{ type: "text", value: "你好世界" }]
      })
    ]);
    secondStore.close();
  });

  it("run events 只通知当前 live 订阅者，不写入 SQLite 回放", async () => {
    const databasePath = createTempDatabasePath();
    const firstStore = await SqliteAgentStore.create({ databasePath });
    const session = firstStore.createSession("统一事件会话");
    const userMessage = firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "重新生成" }]
    });
    const assistantMessage = firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });
    const run = firstStore.createRun({
      sessionId: session.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      status: "running",
      phase: "answering"
    });

    const liveEvents: string[] = [];
    const unsubscribe = firstStore.subscribeRun(run.id, (event) => {
      liveEvents.push(event.event.type);
    });

    firstStore.appendRunEvent(run.id, { type: "iteration_start", iteration: 0 }, assistantMessage.id);
    firstStore.appendRunEvent(run.id, { type: "run_completed", messageId: assistantMessage.id }, assistantMessage.id);
    unsubscribe();
    firstStore.close();

    const secondStore = await SqliteAgentStore.create({ databasePath });

    expect(liveEvents).toEqual(["iteration_start", "run_completed"]);
    secondStore.close();
  });

  it("能按更新时间倒序列出持久化会话", async () => {
    vi.useFakeTimers();
    const databasePath = createTempDatabasePath();
    const firstStore = await SqliteAgentStore.create({ databasePath });
    vi.setSystemTime(new Date("2026-06-22T00:00:00.000Z"));
    const firstSession = firstStore.createSession("旧会话");
    vi.setSystemTime(new Date("2026-06-22T00:00:01.000Z"));
    const secondSession = firstStore.createSession("新会话");
    vi.setSystemTime(new Date("2026-06-22T00:00:02.000Z"));
    firstStore.createMessage({
      sessionId: firstSession.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "更新旧会话" }]
    });
    firstStore.close();

    const secondStore = await SqliteAgentStore.create({ databasePath });

    expect(secondStore.listSessions().map((session) => session.id)).toEqual([firstSession.id, secondSession.id]);
    secondStore.close();
  });

  it("按 cursor 分页列出会话", async () => {
    vi.useFakeTimers();
    const store = await SqliteAgentStore.create({ databasePath: createTempDatabasePath() });
    vi.setSystemTime(new Date("2026-06-22T00:00:00.000Z"));
    const firstSession = store.createSession("第一页后");
    vi.setSystemTime(new Date("2026-06-22T00:00:01.000Z"));
    const secondSession = store.createSession("第一页末尾");
    vi.setSystemTime(new Date("2026-06-22T00:00:02.000Z"));
    const thirdSession = store.createSession("第一页第一条");

    const firstPage = store.listSessions({ limit: 2 });
    const secondPage = store.listSessions({ after: secondSession.id, limit: 2 });

    expect(firstPage.map((session) => session.id)).toEqual([thirdSession.id, secondSession.id]);
    expect(secondPage.map((session) => session.id)).toEqual([firstSession.id]);
    store.close();
  });

  it("删除 session 时级联清理会话相关记录", async () => {
    const databasePath = createTempDatabasePath();
    const firstStore = await SqliteAgentStore.create({ databasePath });
    const session = firstStore.createSession("待删除会话");
    const otherSession = firstStore.createSession("保留会话");
    const userMessage = firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "生成图片" }]
    });
    const assistantMessage = firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "已生成" }]
    });
    const run = firstStore.createRun({
      sessionId: session.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      status: "completed",
      phase: "completed"
    });
    firstStore.createToolCall({
      sessionId: session.id,
      runId: run.id,
      messageId: assistantMessage.id,
      iteration: 1,
      toolCallId: "call_1",
      toolName: "generate_image",
      arguments: { prompt: "小猪" }
    });
    firstStore.createResource({
      sessionId: session.id,
      messageId: assistantMessage.id,
      toolCallId: "call_1",
      type: "image",
      mime: "image/png",
      url: "http://127.0.0.1/image.png",
      name: "image.png",
      status: "succeeded"
    });
    firstStore.appendRunEvent(run.id, { type: "run_completed", messageId: assistantMessage.id }, assistantMessage.id);
    firstStore.upsertSessionSummary({
      sessionId: session.id,
      coveredMessageId: assistantMessage.id,
      summary: {
        userGoal: "生成图片",
        currentTask: "已完成",
        decisions: [],
        preferences: [],
        constraints: [],
        importantFacts: [],
        openQuestions: [],
        recentProgress: []
      }
    });
    firstStore.createMessage({
      sessionId: otherSession.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "保留" }]
    });
    firstStore.close();

    const secondStore = await SqliteAgentStore.create({ databasePath });

    expect(secondStore.deleteSession(session.id)).toBe(true);
    expect(secondStore.getSession(session.id)).toBeUndefined();
    expect(secondStore.getMessagesBySession(session.id)).toEqual([]);
    expect(secondStore.getRun(run.id)).toBeUndefined();
    expect(secondStore.getToolCallsBySession(session.id)).toEqual([]);
    expect(secondStore.getResourcesByMessages([assistantMessage.id])).toEqual([]);
    expect(secondStore.listSessionSummaries(session.id)).toEqual([]);
    expect(secondStore.getSession(otherSession.id)).toMatchObject({ id: otherSession.id });
    expect(secondStore.deleteSession(session.id)).toBe(false);
    secondStore.close();
  });

  it("应用会把会话写入配置的 SQLite 文件", async () => {
    const databasePath = createTempDatabasePath();
    const previousDatabasePath = process.env.AGENT_SQLITE_PATH;
    process.env.AGENT_SQLITE_PATH = databasePath;

    try {
      const app = await buildApp({
        agentService: createTestAgentService(),
        runningStateStore: new InMemoryRunningMessageStateStore(),
        eventBus: new InMemoryAgentEventBus(),
        runQueue: new NoopAgentRunQueue(),
        cancellationStore: new InMemoryAgentCancellationStore(),
        runLock: new InMemoryAgentRunLock()
      });
      const response = await app.inject({
        method: "POST",
        url: "/agents/sessions",
        payload: { title: "SQLite 会话" }
      });
      const payload = response.json() as { session: { id: string } };

      await app.close();

      const store = await SqliteAgentStore.create({ databasePath });
      expect(store.getSession(payload.session.id)).toMatchObject({
        id: payload.session.id,
        title: "SQLite 会话"
      });
      store.close();
    } finally {
      if (previousDatabasePath === undefined) {
        delete process.env.AGENT_SQLITE_PATH;
      } else {
        process.env.AGENT_SQLITE_PATH = previousDatabasePath;
      }
    }
  });
});
