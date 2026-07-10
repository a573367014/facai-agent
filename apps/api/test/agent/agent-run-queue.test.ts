import { describe, expect, it } from "vitest";
import { BullMqAgentRunQueue, type AgentRunQueueClient } from "../../src/modules/agent/agent-run-queue.js";

class FakeAgentRunQueueClient implements AgentRunQueueClient {
  readonly jobs: Array<{ name: string; payload: unknown; options?: Record<string, unknown> }> = [];

  async add(name: string, payload: unknown, options?: Record<string, unknown>): Promise<unknown> {
    this.jobs.push({ name, payload, options });
    return { id: options?.jobId };
  }
}

describe("BullMqAgentRunQueue", () => {
  it("enqueues run jobs with a stable job id and ID-only payload", async () => {
    const client = new FakeAgentRunQueueClient();
    const queue = new BullMqAgentRunQueue({ queue: client });

    await queue.enqueueRun({
      runId: "run_1",
      sessionId: "session_1",
      userMessageId: "msg_user_1",
      assistantMessageId: "msg_assistant_1"
    });

    expect(client.jobs).toEqual([
      {
        name: "agent-run",
        payload: {
          runId: "run_1",
          sessionId: "session_1",
          userMessageId: "msg_user_1",
          assistantMessageId: "msg_assistant_1"
        },
        options: {
          jobId: "run_1",
          removeOnComplete: true,
          removeOnFail: 1000
        }
      }
    ]);
  });
});
