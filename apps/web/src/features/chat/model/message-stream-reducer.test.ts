import { describe, expect, it } from "vitest";
import type { AgentProcessStepRecord, AgentStreamEvent } from "@/features/chat/api/agent-types";
import type { ChatMessage } from "./chat-message";
import {
  applyPartEventToMessage,
  reduceAssistantMessageEvent,
  reduceMessageStreamEvent
} from "./message-stream-reducer";

function createMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message_1",
    role: "assistant",
    status: "running",
    parts: [],
    events: [],
    ...overrides
  };
}

describe("message stream reducer", () => {
  it("跨过缺失 part 接收 delta 时会补齐连续数组", () => {
    const next = applyPartEventToMessage(createMessage(), {
      type: "message.part.delta",
      messageId: "message_1",
      partIndex: 2,
      delta: "hello",
      version: 1
    });

    expect(next.parts).toEqual([
      { type: "text", value: "" },
      { type: "text", value: "" },
      { type: "text", value: "hello" }
    ]);
    expect(Object.keys(next.parts)).toEqual(["0", "1", "2"]);
  });

  it("目标位置是 resource 时将流式文本插入它前面", () => {
    const resource = { type: "resource" as const, url: "/image.png", mime: "image/png" };
    const next = applyPartEventToMessage(createMessage({ parts: [resource] }), {
      type: "message.part.delta",
      messageId: "message_1",
      partIndex: 0,
      delta: "caption"
    });

    expect(next.parts).toEqual([{ type: "text", value: "caption" }, resource]);
  });

  it("忽略相同或更旧 version 的 part 回放", () => {
    const current = createMessage({
      version: 3,
      parts: [{ type: "text", value: "hello" }]
    });
    const event: AgentStreamEvent = {
      type: "message.part.delta",
      messageId: "message_1",
      partIndex: 0,
      delta: " duplicated",
      version: 3
    };

    expect(reduceMessageStreamEvent(current, event)).toBe(current);
  });

  it("final_answer 替换首个文本并保留 resource", () => {
    const resource = { type: "resource" as const, url: "/image.png", mime: "image/png" };
    const event: AgentStreamEvent = { type: "final_answer", answer: "final" };
    const next = reduceMessageStreamEvent(
      createMessage({
        parts: [resource, { type: "text", value: "partial" }],
        error: "old error"
      }),
      event
    );

    expect(next.parts).toEqual([resource, { type: "text", value: "final" }]);
    expect(next.status).toBe("completed");
    expect(next.error).toBeUndefined();
    expect(next.events).toEqual([event]);
  });

  it("为 process step 做 upsert 并按 orderIndex 排序", () => {
    const existing: AgentProcessStepRecord = {
      id: "step_2",
      sessionId: "session_1",
      messageId: "message_1",
      kind: "thinking",
      title: "second",
      status: "running",
      orderIndex: 2,
      startedAt: "2026-07-10T00:00:02.000Z",
      updatedAt: "2026-07-10T00:00:02.000Z"
    };
    const first: AgentProcessStepRecord = {
      ...existing,
      id: "step_1",
      title: "first",
      orderIndex: 1
    };

    const next = reduceMessageStreamEvent(createMessage({ processSteps: [existing] }), {
      type: "process.step.created",
      step: first
    });

    expect(next.processSteps?.map((step) => step.id)).toEqual(["step_1", "step_2"]);
  });

  it("消息不存在时为可渲染事件创建 assistant 并折叠当前事件", () => {
    const next = reduceAssistantMessageEvent(
      [],
      "message_new",
      {
        type: "message.part.delta",
        messageId: "message_new",
        partIndex: 0,
        delta: "hello",
        version: 1
      },
      "2026-07-10T00:00:00.000Z"
    );

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: "message_new",
      role: "assistant",
      status: "running",
      version: 1,
      parts: [{ type: "text", value: "hello" }],
      createdAt: "2026-07-10T00:00:00.000Z"
    });
  });
});
