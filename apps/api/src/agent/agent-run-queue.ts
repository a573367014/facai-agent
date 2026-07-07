import type { JobsOptions } from "bullmq";
import type { TraceContextCarrier } from "../observability/trace-context.js";

// 队列消息只保存定位执行所需的 id。Worker 会从 SQLite 重新读取 run/message，
// 避免把完整上下文、parts 或 summary 复制进 BullMQ 后变成过期快照。
export interface AgentRunJobPayload {
  runId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  traceContext?: TraceContextCarrier;
}

export interface AgentRunQueue {
  enqueueRun(payload: AgentRunJobPayload): Promise<void>;
}

export interface AgentRunQueueClient {
  add(name: string, payload: AgentRunJobPayload, options?: JobsOptions): Promise<unknown>;
}

export interface BullMqAgentRunQueueOptions {
  queue: AgentRunQueueClient;
}

export const agentRunJobName = "agent-run";

export class BullMqAgentRunQueue implements AgentRunQueue {
  constructor(private readonly options: BullMqAgentRunQueueOptions) {}

  async enqueueRun(payload: AgentRunJobPayload): Promise<void> {
    await this.options.queue.add(agentRunJobName, payload, {
      // 用 runId 做 jobId，让重复 enqueue 同一个 run 时尽量收敛成同一项任务；
      // 真正的重复执行保护仍由 Worker 里的 run lock 和 SQLite 状态机兜底。
      jobId: payload.runId,
      removeOnComplete: true,
      removeOnFail: 1000
    });
  }
}
