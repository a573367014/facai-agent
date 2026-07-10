import { describe, expect, it } from "vitest";
import { AgentContextBuilder } from "../../src/modules/agent/context-builder.js";
import type { AgentMessageRecord } from "../../src/modules/agent/agent-store.js";
import { createTextPart, type MessagePart } from "../../src/modules/agent/message-parts.js";

function createMessage(
  overrides: Partial<Omit<AgentMessageRecord, "parts">> & { content?: string; parts?: MessagePart[] }
): AgentMessageRecord {
  const content = overrides.content ?? "默认消息";
  const { content: _content, ...recordOverrides } = overrides;

  return {
    id: "msg_test",
    sessionId: "session_test",
    role: "user",
    status: "completed",
    parts: overrides.parts ?? (content ? [createTextPart(content)] : []),
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    ...recordOverrides
  };
}

describe("AgentContextBuilder", () => {
  it("带会话摘要时先注入结构化摘要，并只保留摘要之后的最近消息", () => {
    const builder = new AgentContextBuilder({ maxHistoryMessages: 10 });
    const history = builder.buildConversationHistory(
      [
        createMessage({ id: "msg_1", role: "user", content: "第一轮问题", createdAt: "2026-06-25T00:00:01.000Z" }),
        createMessage({ id: "msg_2", role: "assistant", content: "第一轮回答", createdAt: "2026-06-25T00:00:02.000Z" }),
        createMessage({ id: "msg_3", role: "user", content: "第二轮问题", createdAt: "2026-06-25T00:00:03.000Z" }),
        createMessage({ id: "msg_4", role: "assistant", content: "第二轮回答", createdAt: "2026-06-25T00:00:04.000Z" })
      ],
      {
        sessionId: "session_test",
        coveredMessageId: "msg_2",
        schemaVersion: 1,
        summary: {
          userGoal: "理解并实现 Agent 项目",
          currentTask: "实现阶段 2 的结构化会话摘要",
          decisions: ["上下文采用摘要加最近原文"],
          preferences: ["用户希望中文解释"],
          constraints: [],
          importantFacts: ["项目后端使用 Fastify"],
          openQuestions: [],
          recentProgress: ["已完成第一轮讨论"]
        },
        createdAt: "2026-06-25T00:00:02.000Z",
        updatedAt: "2026-06-25T00:00:02.000Z"
      }
    );

    expect(history).toEqual([
      {
        role: "system",
        content: expect.stringContaining("以下是此前对话的结构化摘要")
      },
      { role: "user", content: "第二轮问题" },
      { role: "assistant", content: "第二轮回答" }
    ]);
    expect(history[0]?.content).toContain("用户目标：理解并实现 Agent 项目");
    expect(history[0]?.content).toContain("已确认决策：");
    expect(history[0]?.content).toContain("- 上下文采用摘要加最近原文");
  });

  it("把已完成、失败和中断的消息转成历史上下文，并保持时间顺序", () => {
    const builder = new AgentContextBuilder();
    const history = builder.buildConversationHistory([
      createMessage({
        id: "msg_assistant_2",
        role: "assistant",
        content: "第二轮回答",
        createdAt: "2026-06-25T00:00:04.000Z"
      }),
      createMessage({
        id: "msg_user_failed",
        role: "user",
        content: "生成一张小猪图片",
        createdAt: "2026-06-25T00:00:05.000Z"
      }),
      createMessage({
        id: "msg_assistant_failed",
        role: "assistant",
        status: "failed",
        content: "本轮运行失败。",
        error: {
          code: "TOOL_EXECUTION_ERROR",
          message: "图片生成工具鉴权失败"
        },
        createdAt: "2026-06-25T00:00:06.000Z"
      }),
      createMessage({
        id: "msg_assistant_running",
        role: "assistant",
        status: "running",
        content: "",
        createdAt: "2026-06-25T00:00:07.000Z"
      }),
      createMessage({
        id: "msg_user_cancelled",
        role: "user",
        content: "写一篇很长的文章",
        createdAt: "2026-06-25T00:00:08.000Z"
      }),
      createMessage({
        id: "msg_assistant_cancelled",
        role: "assistant",
        status: "cancelled",
        content: "",
        createdAt: "2026-06-25T00:00:09.000Z"
      }),
      createMessage({
        id: "msg_user_1",
        role: "user",
        content: "第一轮问题",
        createdAt: "2026-06-25T00:00:01.000Z"
      }),
      createMessage({
        id: "msg_assistant_1",
        role: "assistant",
        content: "第一轮回答",
        createdAt: "2026-06-25T00:00:02.000Z"
      }),
      createMessage({
        id: "msg_user_2",
        role: "user",
        content: "第二轮问题",
        createdAt: "2026-06-25T00:00:03.000Z"
      })
    ]);

    expect(history).toEqual([
      { role: "user", content: "第一轮问题" },
      { role: "assistant", content: "第一轮回答" },
      { role: "user", content: "第二轮问题" },
      { role: "assistant", content: "第二轮回答" },
      { role: "user", content: "生成一张小猪图片" },
      { role: "assistant", content: "上一轮没有完成，失败原因：图片生成工具鉴权失败" },
      { role: "user", content: "写一篇很长的文章" },
      { role: "assistant", content: "上一轮回答被用户中断。" }
    ]);
  });

  it("超过最大历史消息数时只保留最近的消息", () => {
    const builder = new AgentContextBuilder({ maxHistoryMessages: 2 });
    const history = builder.buildConversationHistory([
      createMessage({ id: "msg_1", role: "user", content: "第一轮问题", createdAt: "2026-06-25T00:00:01.000Z" }),
      createMessage({ id: "msg_2", role: "assistant", content: "第一轮回答", createdAt: "2026-06-25T00:00:02.000Z" }),
      createMessage({ id: "msg_3", role: "user", content: "第二轮问题", createdAt: "2026-06-25T00:00:03.000Z" }),
      createMessage({ id: "msg_4", role: "assistant", content: "第二轮回答", createdAt: "2026-06-25T00:00:04.000Z" })
    ]);

    expect(history).toEqual([
      { role: "user", content: "第二轮问题" },
      { role: "assistant", content: "第二轮回答" }
    ]);
  });

  it("最大历史消息数为 0 时不携带任何历史上下文", () => {
    const builder = new AgentContextBuilder({ maxHistoryMessages: 0 });
    const history = builder.buildConversationHistory([
      createMessage({ id: "msg_1", role: "user", content: "第一轮问题", createdAt: "2026-06-25T00:00:01.000Z" })
    ]);

    expect(history).toEqual([]);
  });

  it("从 message parts 投影结构化输入", () => {
    const builder = new AgentContextBuilder();
    const history = builder.buildConversationHistory([
      createMessage({
        content: "",
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
      })
    ]);

    expect(history).toEqual([{ role: "user", content: "帮我生成图片\n风格：温馨田园风" }]);
  });

  it("达到字符预算后丢弃更早历史，但至少保留最近一条上下文", () => {
    const builder = new AgentContextBuilder({ maxHistoryMessages: 10, maxHistoryCharacters: 6 });
    const history = builder.buildConversationHistory([
      createMessage({ id: "msg_1", role: "user", content: "旧问题", createdAt: "2026-06-25T00:00:01.000Z" }),
      createMessage({ id: "msg_2", role: "assistant", content: "最近回答很长", createdAt: "2026-06-25T00:00:02.000Z" })
    ]);

    expect(history).toEqual([{ role: "assistant", content: "最近回答很长" }]);
  });
});
