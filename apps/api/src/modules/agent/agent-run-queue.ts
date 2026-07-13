/**
 * 模块职责：Agent Run 的 BullMQ 队列封装。
 *
 * 在 Agent 系统中，用户发起对话后，API 进程不直接执行 Agent 逻辑（那会阻塞
 * HTTP 请求几十秒甚至几分钟），而是把 run 入队，由独立的 Worker 进程异步消费。
 *
 * 这个模块是"入队端"的封装：
 * - 定义队列消息的 payload 格式（只包含 id，不含完整上下文）；
 * - 封装 BullMQ 的 add 调用，设置 jobId 去重和清理策略。
 *
 * 边界：
 * - 只负责入队，不负责消费（消费端在 Worker 进程的 agent-run-worker 里）。
 * - 队列消息是"瘦"的：只传 id，Worker 从 SQLite 重新读取完整数据。
 *   这样避免把大 payload 序列化进 Redis，也避免消息里的数据变成过期快照。
 */
import type { JobsOptions } from "bullmq";
import type { TraceContextCarrier } from "../../platform/observability/trace-context.js";

// 队列消息只保存定位执行所需的 id。Worker 会从 SQLite 重新读取 run/message，
// 避免把完整上下文、parts 或 summary 复制进 BullMQ 后变成过期快照。
export interface AgentRunJobPayload {
  runId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  traceContext?: TraceContextCarrier;
}

/**
 * Run 队列契约。
 * 只暴露 enqueueRun：把一个 run 的执行任务入队。
 */
export interface AgentRunQueue {
  enqueueRun(payload: AgentRunJobPayload): Promise<void>;
}

/**
 * BullMQ Queue 的最小契约——只暴露 add 方法。
 * 解耦后可以注入 mock queue 做单元测试。
 */
export interface AgentRunQueueClient {
  add(name: string, payload: AgentRunJobPayload, options?: JobsOptions): Promise<unknown>;
}

export interface BullMqAgentRunQueueOptions {
  queue: AgentRunQueueClient;
}

/**
 * BullMQ 中 agent run job 的名称。
 * 所有 agent run 任务都用这个名字入队，Worker 按这个名字注册 processor。
 */
export const agentRunJobName = "agent-run";

/**
 * 基于 BullMQ 的 Run 队列实现。
 *
 * enqueueRun 的关键选项：
 * - jobId = runId：BullMQ 用 jobId 去重，同一个 runId 的重复入队会收敛成同一个 job。
 *   但这只是"尽量"去重，真正的并发保护由 Worker 里的 run lock 兜底。
 * - removeOnComplete: true：完成的 job 立即从 Redis 删除，避免堆积。
 * - removeOnFail: 1000：保留最近 1000 个失败 job 用于排查，超出自动清理。
 */
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
