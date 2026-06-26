import { describe, expect, it } from "vitest";
import { AgentContextBuilder } from "../../src/agent/context-builder.js";
import type { AgentMessageRecord } from "../../src/agent/agent-store.js";
import { legacyContentToParts } from "../../src/agent/message-parts.js";

function createMessage(overrides: Partial<AgentMessageRecord>): AgentMessageRecord {
  const content = overrides.content ?? "默认消息";

  return {
    id: "msg_test",
    sessionId: "session_test",
    role: "user",
    status: "completed",
    content,
    parts: legacyContentToParts(content),
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    ...overrides
  };
}

describe("AgentContextBuilder", () => {
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

  it("从 message parts 投影结构化输入，而不是直接读取 legacy content", () => {
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
