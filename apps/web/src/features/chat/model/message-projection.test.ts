import { describe, expect, it } from "vitest";
import type {
  AgentMessageRecord,
  AgentProcessStepRecord,
  AgentRunRecord
} from "@/features/chat/api/agent-types";
import type { ChatMessage } from "./chat-message";
import {
  buildMessagesFromRecords,
  markRunMessagesCancelled,
  upsertMessageRecord,
  upsertMessageSnapshot
} from "./message-projection";

const timestamp = "2026-07-10T00:00:00.000Z";

function createRecord(
  id: string,
  overrides: Partial<AgentMessageRecord> = {}
): AgentMessageRecord {
  return {
    id,
    sessionId: "session_1",
    role: "assistant",
    status: "completed",
    parts: [{ type: "text", value: id }],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function createStep(
  id: string,
  messageId: string,
  orderIndex: number,
  startedAt = timestamp
): AgentProcessStepRecord {
  return {
    id,
    sessionId: "session_1",
    messageId,
    kind: "thinking",
    title: id,
    status: "succeeded",
    orderIndex,
    startedAt,
    updatedAt: startedAt
  };
}

describe("message projection", () => {
  it("按创建时间投影 record，并将 process step 分组排序", () => {
    const later = createRecord("later", { createdAt: "2026-07-10T00:00:02.000Z" });
    const earlier = createRecord("earlier", { createdAt: "2026-07-10T00:00:01.000Z" });
    const steps = [
      createStep("step_2", "earlier", 2),
      createStep("step_1", "earlier", 1),
      createStep("other", "later", 0)
    ];

    const messages = buildMessagesFromRecords([later, earlier], steps);

    expect(messages.map((message) => message.id)).toEqual(["earlier", "later"]);
    expect(messages[0].processSteps?.map((step) => step.id)).toEqual(["step_1", "step_2"]);
    expect(messages[1].processSteps?.map((step) => step.id)).toEqual(["other"]);
  });

  it("统一摘要文案并只保留最新的已完成摘要", () => {
    const messages = buildMessagesFromRecords([
      createRecord("summary_1", {
        role: "system",
        parts: [{ type: "text", value: "已自动整理较早上下文" }],
        createdAt: "2026-07-10T00:00:01.000Z"
      }),
      createRecord("summary_2", {
        role: "system",
        parts: [{ type: "text", value: "已自动压缩较早上下文" }],
        createdAt: "2026-07-10T00:00:02.000Z"
      }),
      createRecord("summary_running", {
        role: "system",
        status: "running",
        parts: [{ type: "text", value: "上下文压缩中" }],
        createdAt: "2026-07-10T00:00:03.000Z"
      }),
      createRecord("answer", { createdAt: "2026-07-10T00:00:04.000Z" })
    ]);

    expect(messages.map((message) => message.id)).toEqual(["summary_2", "answer"]);
    expect(messages[0].parts).toEqual([{ type: "text", value: "上下文已自动压缩" }]);
  });

  it("record upsert 保留本地 version 和 process step", () => {
    const step = createStep("step_1", "message_1", 0);
    const current: ChatMessage[] = [
      {
        id: "message_1",
        role: "assistant",
        status: "running",
        version: 7,
        parts: [{ type: "text", value: "old" }],
        processSteps: [step],
        events: []
      }
    ];

    const next = upsertMessageRecord(
      current,
      createRecord("message_1", { parts: [{ type: "text", value: "new" }] })
    );

    expect(next[0]).toMatchObject({
      version: 7,
      parts: [{ type: "text", value: "new" }],
      processSteps: [step]
    });
  });

  it("忽略比本地 version 更旧的 snapshot", () => {
    const current: ChatMessage[] = [
      {
        id: "message_1",
        role: "assistant",
        status: "running",
        version: 5,
        parts: [{ type: "text", value: "newer" }]
      }
    ];

    const next = upsertMessageSnapshot(current, {
      type: "message.snapshot",
      message: createRecord("message_1", { parts: [{ type: "text", value: "older" }] }),
      resources: [],
      version: 4
    });

    expect(next).toBe(current);
  });

  it("取消 run 时移除运行中的 system 消息并标记 assistant", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant_1",
        role: "assistant",
        status: "running",
        parts: [{ type: "text", value: "partial" }]
      },
      {
        id: "system_1",
        role: "system",
        status: "running",
        parts: [{ type: "text", value: "上下文压缩中" }]
      },
      {
        id: "completed_1",
        role: "assistant",
        status: "completed",
        parts: [{ type: "text", value: "done" }]
      }
    ];
    const run: AgentRunRecord = {
      id: "run_1",
      sessionId: "session_1",
      status: "cancelled",
      phase: "cancelled",
      userMessageId: "user_1",
      assistantMessageId: "assistant_1",
      systemMessageId: "system_1",
      createdAt: timestamp,
      updatedAt: timestamp
    };

    const next = markRunMessagesCancelled(messages, run);

    expect(next.map((message) => message.id)).toEqual(["assistant_1", "completed_1"]);
    expect(next[0].status).toBe("cancelled");
    expect(next[1].status).toBe("completed");
  });
});
