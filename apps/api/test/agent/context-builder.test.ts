import { describe, expect, it } from "vitest";
import { AgentContextBuilder } from "../../src/agent/context-builder.js";
import type { AgentRunRecord } from "../../src/agent/run-store.js";

function createRun(overrides: Partial<AgentRunRecord>): AgentRunRecord {
  return {
    id: "run_test",
    sessionId: "session_test",
    input: "默认问题",
    status: "completed",
    answer: "默认回答",
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    completedAt: "2026-06-25T00:00:01.000Z",
    ...overrides
  };
}

describe("AgentContextBuilder", () => {
  it("把已完成 run、失败 run 和中断 run 转成历史消息，并保持时间顺序", () => {
    const builder = new AgentContextBuilder();
    const history = builder.buildConversationHistory([
      createRun({
        id: "run_2",
        input: "第二轮问题",
        answer: "第二轮回答",
        createdAt: "2026-06-25T00:00:02.000Z"
      }),
      createRun({
        id: "run_failed",
        input: "生成一张小猪图片",
        status: "failed",
        answer: undefined,
        error: {
          code: "TOOL_EXECUTION_ERROR",
          message: "图片生成工具鉴权失败"
        },
        createdAt: "2026-06-25T00:00:03.000Z"
      }),
      createRun({
        id: "run_running",
        input: "运行中问题",
        status: "running",
        answer: undefined,
        createdAt: "2026-06-25T00:00:05.000Z"
      }),
      createRun({
        id: "run_cancelled",
        input: "写一篇很长的文章",
        status: "cancelled",
        answer: undefined,
        createdAt: "2026-06-25T00:00:06.000Z"
      }),
      createRun({
        id: "run_empty",
        input: "空答案问题",
        answer: "",
        createdAt: "2026-06-25T00:00:04.000Z"
      }),
      createRun({
        id: "run_1",
        input: "第一轮问题",
        answer: "第一轮回答",
        createdAt: "2026-06-25T00:00:01.000Z"
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

  it("超过最大历史轮数时只保留最近的历史 run", () => {
    const builder = new AgentContextBuilder({ maxHistoryRuns: 2 });
    const history = builder.buildConversationHistory([
      createRun({
        id: "run_1",
        input: "第一轮问题",
        answer: "第一轮回答",
        createdAt: "2026-06-25T00:00:01.000Z"
      }),
      createRun({
        id: "run_2",
        input: "第二轮问题",
        answer: "第二轮回答",
        createdAt: "2026-06-25T00:00:02.000Z"
      }),
      createRun({
        id: "run_3",
        input: "第三轮问题",
        answer: "第三轮回答",
        createdAt: "2026-06-25T00:00:03.000Z"
      })
    ]);

    expect(history).toEqual([
      { role: "user", content: "第二轮问题" },
      { role: "assistant", content: "第二轮回答" },
      { role: "user", content: "第三轮问题" },
      { role: "assistant", content: "第三轮回答" }
    ]);
  });

  it("最大历史轮数为 0 时不携带任何历史上下文", () => {
    const builder = new AgentContextBuilder({ maxHistoryRuns: 0 });
    const history = builder.buildConversationHistory([
      createRun({
        id: "run_1",
        input: "第一轮问题",
        answer: "第一轮回答",
        createdAt: "2026-06-25T00:00:01.000Z"
      })
    ]);

    expect(history).toEqual([]);
  });

  it("达到字符预算后丢弃更早历史，但至少保留最近一轮上下文", () => {
    const builder = new AgentContextBuilder({ maxHistoryRuns: 10, maxHistoryCharacters: 12 });
    const history = builder.buildConversationHistory([
      createRun({
        id: "run_1",
        input: "旧问题",
        answer: "旧回答",
        createdAt: "2026-06-25T00:00:01.000Z"
      }),
      createRun({
        id: "run_2",
        input: "最近问题很长",
        answer: "最近回答也长",
        createdAt: "2026-06-25T00:00:02.000Z"
      })
    ]);

    expect(history).toEqual([
      { role: "user", content: "最近问题很长" },
      { role: "assistant", content: "最近回答也长" }
    ]);
  });
});
