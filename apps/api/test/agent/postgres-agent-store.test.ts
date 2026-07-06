import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAgentCancellationStore } from "../../src/agent/agent-cancellation-store.js";
import { InMemoryAgentEventBus } from "../../src/agent/agent-event-bus.js";
import { InMemoryAgentRunLock } from "../../src/agent/agent-run-lock.js";
import type { AgentRunJobPayload, AgentRunQueue } from "../../src/agent/agent-run-queue.js";
import { LangChainAgentService } from "../../src/langchain/langchain-agent-service.js";
import { PostgresAgentStore } from "../../src/agent/postgres-agent-store.js";
import { InMemoryRunningMessageStateStore } from "../../src/agent/running-message-state-store.js";
import { buildApp } from "../../src/app.js";
import { createMockModel } from "../helpers/mock-model.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { MessagePart } from "../../src/agent/message-parts.js";

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agent_test";

class NoopAgentRunQueue implements AgentRunQueue {
  async enqueueRun(_payload: AgentRunJobPayload): Promise<void> {}
}

afterEach(() => {
  vi.useRealTimers();
});

function createTestAgentService(): LangChainAgentService {
  const registry = new ToolRegistry();
  return new LangChainAgentService({
    model: createMockModel([{ content: "测试回答" }]),
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({ registry, timeoutMs: 100 }),
    defaultMaxIterations: 4
  });
}

describe("PostgresAgentStore", () => {
  it("保存知识库文档并且只搜索 ready 文档的 chunk", async () => {
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL, vectorDimension: 2 });
    await store.reset();
    const readyDocument = await store.createKnowledgeDocument({
      name: "员工手册.pdf",
      mimeType: "application/pdf",
      sourcePath: "/tmp/员工手册.pdf",
      contentHash: "hash-ready-001"
    });
    const indexingDocument = await store.createKnowledgeDocument({
      name: "草稿制度.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sourcePath: "/tmp/草稿制度.docx",
      contentHash: "hash-indexing-002"
    });

    await store.replaceKnowledgeChunks(readyDocument.id, [
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
    await store.replaceKnowledgeChunks(indexingDocument.id, [
      {
        chunkIndex: 0,
        content: "草稿制度暂不应该被搜索。",
        sourceLabel: "草稿制度.docx",
        embeddingModel: "test-embedding",
        embedding: [1, 0]
      }
    ]);
    await store.updateKnowledgeDocument(readyDocument.id, {
      status: "ready",
      chunkCount: 2,
      indexedAt: "2026-07-01T00:00:00.000Z"
    });
    await store.updateKnowledgeDocument(indexingDocument.id, {
      status: "indexing"
    });

    const results = await store.searchKnowledgeChunks({
      queryEmbedding: [1, 0],
      limit: 5
    });

    expect(results.map((result) => result.content)).toEqual(["请假需要直属主管审批。", "报销需要提交发票。"]);
    expect(results[0]).toMatchObject({
      documentId: readyDocument.id,
      documentName: "员工手册.pdf",
      sourceLabel: "员工手册.pdf 第 3 页",
      metadata: { page: 3 }
    });
    expect(results.some((result) => result.documentId === indexingDocument.id)).toBe(false);

    await store.deleteKnowledgeDocument(readyDocument.id);
    expect(await store.getKnowledgeDocument(readyDocument.id)).toBeUndefined();
    expect(await store.searchKnowledgeChunks({ queryEmbedding: [1, 0], limit: 5 })).toEqual([]);
    await store.close();
  });

  it("支持按消息游标读取最近消息、历史消息和新增消息", async () => {
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const session = await store.createSession("分页会话");
    const messages: { id: string }[] = [];
    for (let index = 0; index < 6; index += 1) {
      const message = await store.createMessage({
        sessionId: session.id,
        role: index % 2 === 0 ? "user" : "assistant",
        status: "completed",
        parts: [{ type: "text", value: `消息 ${index + 1}` }]
      });
      messages.push({ id: message.id });
    }

    expect((await store.getRecentMessagesBySession(session.id, 3)).map((message) => message.id)).toEqual(
      messages.slice(3).map((message) => message.id)
    );
    expect((await store.getMessagesBefore(session.id, messages[3].id, 2)).map((message) => message.id)).toEqual([
      messages[1].id,
      messages[2].id
    ]);
    expect(await store.countMessagesAfter(session.id, messages[1].id)).toBe(4);
    expect((await store.getMessagesAfter(session.id, messages[1].id, 2)).map((message) => message.id)).toEqual([
      messages[2].id,
      messages[3].id
    ]);
    expect((await store.getRecentMessagesAfter(session.id, messages[1].id, 2)).map((message) => message.id)).toEqual([
      messages[4].id,
      messages[5].id
    ]);
    await store.close();
  });

  it("重新创建 store 后仍能读回结构化会话摘要", async () => {
    const firstStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await firstStore.reset();
    const session = await firstStore.createSession("摘要会话");
    const userMessage = await firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "第一轮问题" }]
    });

    await firstStore.upsertSessionSummary({
      sessionId: session.id,
      coveredMessageId: userMessage.id,
      summary: {
        userGoal: "理解 Agent 架构",
        currentTask: "实现结构化摘要",
        decisions: ["采用滚动摘要"],
        preferences: ["使用中文解释"],
        constraints: [],
        importantFacts: ["项目使用 PostgreSQL"],
        openQuestions: [],
        recentProgress: ["已完成摘要表设计"]
      }
    });
    await firstStore.close();

    const secondStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });

    expect(await secondStore.getSessionSummary(session.id)).toMatchObject({
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
    await secondStore.close();
  });

  it("多个已打开 store 会在文件变化后读到彼此写入", async () => {
    const apiStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await apiStore.reset();
    const workerStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });

    try {
      const session = await apiStore.createSession("queue session");
      const userMessage = await apiStore.createMessage({
        sessionId: session.id,
        role: "user",
        status: "completed",
        parts: [{ type: "text", value: "排队执行" }]
      });
      const run = await apiStore.createRun({
        sessionId: session.id,
        userMessageId: userMessage.id,
        status: "running",
        phase: "answering"
      });

      expect(await workerStore.getRun(run.id)).toMatchObject({
        id: run.id,
        status: "running"
      });

      const assistantMessage = await workerStore.createMessage({
        sessionId: session.id,
        role: "assistant",
        status: "completed",
        parts: [{ type: "text", value: "完成" }]
      });
      await workerStore.updateRun(run.id, {
        status: "completed",
        phase: "completed",
        assistantMessageId: assistantMessage.id
      });

      expect(await apiStore.getRun(run.id)).toMatchObject({
        id: run.id,
        status: "completed",
        phase: "completed",
        assistantMessageId: assistantMessage.id
      });
    } finally {
      await apiStore.close();
      await workerStore.close();
    }
  });

  it("按版本追加 session summary，并能查询某条消息之前可用的摘要", async () => {
    const firstStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await firstStore.reset();
    const session = await firstStore.createSession("摘要版本会话");
    const firstUser = await firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "第一轮" }]
    });
    const firstAssistant = await firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "第一轮回答" }]
    });
    const secondUser = await firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "第二轮" }]
    });
    const secondAssistant = await firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "第二轮回答" }]
    });

    const firstSummary = await firstStore.upsertSessionSummary({
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
    const secondSummary = await firstStore.upsertSessionSummary({
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
    await firstStore.close();

    const secondStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });

    expect((await secondStore.listSessionSummaries(session.id)).map((summary) => summary.version)).toEqual([1, 2]);
    expect(await secondStore.getSessionSummary(session.id)).toMatchObject({
      id: secondSummary.id,
      version: 2,
      summary: { decisions: ["v2"] }
    });
    expect(await secondStore.getSessionSummaryBeforeMessage(session.id, firstUser.id)).toBeUndefined();
    expect(await secondStore.getSessionSummaryBeforeMessage(session.id, secondUser.id)).toMatchObject({
      id: firstSummary.id,
      version: 1,
      summary: { decisions: ["v1"] }
    });
    await secondStore.close();
  });

  it("重新创建 store 后仍能读回 message parts", async () => {
    const firstStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await firstStore.reset();
    const session = await firstStore.createSession("parts 会话");
    const parts: MessagePart[] = [{ type: "text", value: "你好" }];
    const message = await firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts
    });
    await firstStore.close();

    const secondStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });

    expect((await secondStore.getMessage(message.id))?.parts).toEqual(parts);
    await secondStore.close();
  });

  it("能单独更新 message parts 且不改变状态", async () => {
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const session = await store.createSession("parts 更新");
    const message = await store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });

    const updated = await store.updateMessageParts(message.id, [{ type: "text", value: "流式文本" }]);

    expect(updated?.status).toBe("running");
    expect(updated?.parts).toEqual([{ type: "text", value: "流式文本" }]);
    await store.close();
  });

  it("拒绝把终态 message 重新改回 running 或其他终态", async () => {
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const session = await store.createSession("消息状态机");
    const message = await store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });

    await store.updateMessage(message.id, {
      status: "cancelled",
      completedAt: "2026-06-28T10:00:00.000Z"
    });

    await expect(
      store.updateMessage(message.id, {
        status: "completed",
        parts: [{ type: "text", value: "迟到的完成结果" }],
        completedAt: "2026-06-28T10:00:01.000Z"
      })
    ).rejects.toThrow(/非法 message 状态流转/);
    await expect(store.updateMessage(message.id, { status: "running" })).rejects.toThrow(/非法 message 状态流转/);
    expect(await store.getMessage(message.id)).toMatchObject({
      status: "cancelled",
      parts: [{ type: "text", value: "" }]
    });
    await store.close();
  });

  it("拒绝把终态 run 被后续异步回调覆盖", async () => {
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const session = await store.createSession("run 状态机");
    const userMessage = await store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "问题" }]
    });
    const run = await store.createRun({
      sessionId: session.id,
      userMessageId: userMessage.id,
      status: "running",
      phase: "answering"
    });

    await store.updateRun(run.id, {
      status: "cancelled",
      phase: "cancelled",
      completedAt: "2026-06-28T10:00:00.000Z"
    });

    await expect(
      store.updateRun(run.id, {
        status: "completed",
        phase: "completed",
        completedAt: "2026-06-28T10:00:01.000Z"
      })
    ).rejects.toThrow(/非法 run 状态流转/);
    expect(await store.getRun(run.id)).toMatchObject({
      status: "cancelled",
      phase: "cancelled"
    });
    await store.close();
  });

  it("拒绝 run 终态 status 和 phase 不一致", async () => {
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    const session = await store.createSession("run phase 状态机");
    const userMessage = await store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "问题" }]
    });
    const run = await store.createRun({
      sessionId: session.id,
      userMessageId: userMessage.id,
      status: "running",
      phase: "answering"
    });

    await expect(store.updateRun(run.id, { status: "completed", phase: "answering" })).rejects.toThrow(
      /run 终态 phase 不一致/
    );
    expect(await store.getRun(run.id)).toMatchObject({
      status: "running",
      phase: "answering"
    });
    await store.close();
  });

  it("持久化工具调用流水，支持按会话聚合查询", async () => {
    const firstStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await firstStore.reset();
    const session = await firstStore.createSession("工具审计");
    const assistantMessage = await firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });
    const toolCall = await firstStore.createToolCall({
      sessionId: session.id,
      messageId: assistantMessage.id,
      iteration: 0,
      toolCallId: "call_image",
      toolName: "generate_image",
      arguments: { prompt: "小猪" }
    });

    await firstStore.updateToolCall(toolCall.id, {
      status: "succeeded",
      durationMs: 123,
      resultSummary: { outputCount: 1 }
    });
    await firstStore.close();

    const secondStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });

    expect(await secondStore.getToolCallsBySession(session.id)).toEqual([
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
    await secondStore.close();
  });

  it("持久化资源实体，支持按消息批量查询", async () => {
    const firstStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await firstStore.reset();
    const session = await firstStore.createSession("资源会话");
    const assistantMessage = await firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });
    const toolCall = await firstStore.createToolCall({
      sessionId: session.id,
      messageId: assistantMessage.id,
      iteration: 0,
      toolCallId: "call_image",
      toolName: "generate_image",
      arguments: { prompt: "小猪" }
    });
    const resource = await firstStore.createResource({
      sessionId: session.id,
      messageId: assistantMessage.id,
      toolCallId: "call_image",
      toolCallRowId: toolCall.id,
      type: "image",
      mime: "image/png",
      status: "pending",
      metadata: { prompt: "小猪", provider: "test_image" }
    });

    await firstStore.updateResource(resource.id, {
      status: "succeeded",
      url: "https://example.com/pig.png",
      width: 1024,
      height: 1024
    });
    await firstStore.close();

    const secondStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });

    expect(await secondStore.getResourcesByMessages([assistantMessage.id])).toEqual([
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
    await secondStore.close();
  });

  it("持久化过程步骤，支持按消息恢复产品化任务进度", async () => {
    const firstStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await firstStore.reset();
    const session = await firstStore.createSession("过程步骤会话");
    const assistantMessage = await firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });
    const step = await firstStore.createProcessStep({
      sessionId: session.id,
      messageId: assistantMessage.id,
      kind: "tool",
      title: "正在查找资料",
      summary: "搜索关键词：厦门上膳 人均 招牌菜",
      status: "running",
      orderIndex: 1,
      metadata: { toolName: "web_search", toolCallId: "call_search" }
    });

    await firstStore.updateProcessStep(step.id, {
      title: "资料已查找",
      summary: "已搜索 5 个网页",
      status: "succeeded",
      metadata: { toolName: "web_search", toolCallId: "call_search", resultCount: 5 }
    });
    await firstStore.close();

    const secondStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });

    expect(await secondStore.getProcessStepsByMessages([assistantMessage.id])).toEqual([
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
    await secondStore.close();
  });

  it("重新创建 store 后仍能读回 session 和 messages", async () => {
    const firstStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await firstStore.reset();
    const session = await firstStore.createSession("图片会话");
    const userMessage = await firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "生成图片" }]
    });
    const assistantMessage = await firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });

    await firstStore.updateMessage(assistantMessage.id, {
      status: "completed",
      parts: [{ type: "text", value: "你好世界" }],
      completedAt: "2026-06-25T00:00:01.000Z"
    });
    await firstStore.close();

    const secondStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    expect(await secondStore.getSession(session.id)).toMatchObject({
      id: session.id,
      title: "图片会话"
    });
    expect(await secondStore.getMessagesBySession(session.id)).toEqual([
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
    await secondStore.close();
  });

  it("run events 只通知当前 live 订阅者，不写入 Postgres 回放", async () => {
    const firstStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await firstStore.reset();
    const session = await firstStore.createSession("统一事件会话");
    const userMessage = await firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "重新生成" }]
    });
    const assistantMessage = await firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [{ type: "text", value: "" }]
    });
    const run = await firstStore.createRun({
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

    await firstStore.appendRunEvent(run.id, { type: "iteration_start", iteration: 0 }, assistantMessage.id);
    await firstStore.appendRunEvent(run.id, { type: "run_completed", messageId: assistantMessage.id }, assistantMessage.id);
    unsubscribe();
    await firstStore.close();

    const secondStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });

    expect(liveEvents).toEqual(["iteration_start", "run_completed"]);
    await secondStore.close();
  });

  it("能按更新时间倒序列出持久化会话", async () => {
    vi.useFakeTimers();
    const firstStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await firstStore.reset();
    vi.setSystemTime(new Date("2026-06-22T00:00:00.000Z"));
    const firstSession = await firstStore.createSession("旧会话");
    vi.setSystemTime(new Date("2026-06-22T00:00:01.000Z"));
    const secondSession = await firstStore.createSession("新会话");
    vi.setSystemTime(new Date("2026-06-22T00:00:02.000Z"));
    await firstStore.createMessage({
      sessionId: firstSession.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "更新旧会话" }]
    });
    await firstStore.close();

    const secondStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });

    expect((await secondStore.listSessions()).map((session) => session.id)).toEqual([firstSession.id, secondSession.id]);
    await secondStore.close();
  });

  it("按 cursor 分页列出会话", async () => {
    vi.useFakeTimers();
    const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();
    vi.setSystemTime(new Date("2026-06-22T00:00:00.000Z"));
    const firstSession = await store.createSession("第一页后");
    vi.setSystemTime(new Date("2026-06-22T00:00:01.000Z"));
    const secondSession = await store.createSession("第一页末尾");
    vi.setSystemTime(new Date("2026-06-22T00:00:02.000Z"));
    const thirdSession = await store.createSession("第一页第一条");

    const firstPage = await store.listSessions({ limit: 2 });
    const secondPage = await store.listSessions({ after: secondSession.id, limit: 2 });

    expect(firstPage.map((session) => session.id)).toEqual([thirdSession.id, secondSession.id]);
    expect(secondPage.map((session) => session.id)).toEqual([firstSession.id]);
    await store.close();
  });

  it("删除 session 时级联清理会话相关记录", async () => {
    const firstStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
    await firstStore.reset();
    const session = await firstStore.createSession("待删除会话");
    const otherSession = await firstStore.createSession("保留会话");
    const userMessage = await firstStore.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "生成图片" }]
    });
    const assistantMessage = await firstStore.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "completed",
      parts: [{ type: "text", value: "已生成" }]
    });
    const run = await firstStore.createRun({
      sessionId: session.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      status: "completed",
      phase: "completed"
    });
    await firstStore.createToolCall({
      sessionId: session.id,
      runId: run.id,
      messageId: assistantMessage.id,
      iteration: 1,
      toolCallId: "call_1",
      toolName: "generate_image",
      arguments: { prompt: "小猪" }
    });
    await firstStore.createResource({
      sessionId: session.id,
      messageId: assistantMessage.id,
      toolCallId: "call_1",
      type: "image",
      mime: "image/png",
      url: "http://127.0.0.1/image.png",
      name: "image.png",
      status: "succeeded"
    });
    await firstStore.appendRunEvent(run.id, { type: "run_completed", messageId: assistantMessage.id }, assistantMessage.id);
    await firstStore.upsertSessionSummary({
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
    await firstStore.createMessage({
      sessionId: otherSession.id,
      role: "user",
      status: "completed",
      parts: [{ type: "text", value: "保留" }]
    });
    await firstStore.close();

    const secondStore = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });

    expect(await secondStore.deleteSession(session.id)).toBe(true);
    expect(await secondStore.getSession(session.id)).toBeUndefined();
    expect(await secondStore.getMessagesBySession(session.id)).toEqual([]);
    expect(await secondStore.getRun(run.id)).toBeUndefined();
    expect(await secondStore.getToolCallsBySession(session.id)).toEqual([]);
    expect(await secondStore.getResourcesByMessages([assistantMessage.id])).toEqual([]);
    expect(await secondStore.listSessionSummaries(session.id)).toEqual([]);
    expect(await secondStore.getSession(otherSession.id)).toMatchObject({ id: otherSession.id });
    expect(await secondStore.deleteSession(session.id)).toBe(false);
    await secondStore.close();
  });

  it("应用会把会话写入配置的 Postgres 数据库", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;

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
        payload: { title: "Postgres 会话" }
      });
      const payload = response.json() as { session: { id: string } };

      await app.close();

      const store = await PostgresAgentStore.create({ connectionString: TEST_DATABASE_URL });
      expect(await store.getSession(payload.session.id)).toMatchObject({
        id: payload.session.id,
        title: "Postgres 会话"
      });
      await store.close();
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });
});
