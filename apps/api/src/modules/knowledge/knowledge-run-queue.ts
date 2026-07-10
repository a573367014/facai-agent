/**
 * 知识库索引任务队列。
 *
 * 职责：把"耗时的索引操作"从 HTTP 请求路径里解耦出来，异步执行。
 *
 * 为什么需要队列（第一性原理）：
 * - 索引一份文档要经过解析→切块→向量化→落库，可能耗时几秒到几十秒。
 * - 如果在 HTTP 请求里同步做，客户端会长时间等待、甚至超时；服务端线程也会被占住。
 * - 引入队列后，上传接口只需"入库 + 投递任务"即可立即返回 201，真正的索引由后台 worker 消费。
 *
 * 同样采用端口-适配器模式：KnowledgeIndexQueue 是抽象端口，
 * NoopKnowledgeIndexQueue 用于测试/无 Redis 环境（直接吞掉任务），
 * BullMqKnowledgeIndexQueue 是基于 BullMQ + Redis 的生产实现。
 */
import type { JobsOptions } from "bullmq";

/** 队列任务的载荷，只携带 documentId，worker 消费时再从库里读完整文档信息。 */
export interface KnowledgeIndexJobPayload {
  documentId: string;
}

/** 队列抽象端口：上游只依赖它来"投递一个索引任务"。 */
export interface KnowledgeIndexQueue {
  enqueueDocumentIndex(payload: KnowledgeIndexJobPayload): Promise<void>;
}

/** 对 BullMQ Queue 的最小抽象，便于在不直接依赖 BullMQ 类型的情况下注入 mock。 */
export interface KnowledgeIndexQueueClient {
  add(name: string, payload: KnowledgeIndexJobPayload, options?: JobsOptions): Promise<unknown>;
}

export interface BullMqKnowledgeIndexQueueOptions {
  queue: KnowledgeIndexQueueClient;
}

/** 队列里任务的统一名称，worker 端按此名称注册消费者。 */
export const knowledgeIndexJobName = "knowledge-index-document";

/**
 * 空实现队列：投递后什么都不做。
 * 用于单元测试，或在未配置 Redis 的环境里保证系统仍能启动（只是不会真正执行索引）。
 */
export class NoopKnowledgeIndexQueue implements KnowledgeIndexQueue {
  async enqueueDocumentIndex(_payload: KnowledgeIndexJobPayload): Promise<void> {}
}

/**
 * 基于 BullMQ 的生产级队列实现。
 * BullMQ 底层用 Redis，提供重试、延迟、优先级、结果保留等能力。
 */
export class BullMqKnowledgeIndexQueue implements KnowledgeIndexQueue {
  constructor(private readonly options: BullMqKnowledgeIndexQueueOptions) {}

  async enqueueDocumentIndex(payload: KnowledgeIndexJobPayload): Promise<void> {
    await this.options.queue.add(knowledgeIndexJobName, payload, {
      // 用 documentId 作 jobId：同一文档的重复投递会被 BullMQ 去重，
      // 避免对同一文档并发索引产生脏数据
      jobId: payload.documentId,
      removeOnComplete: true,
      // 最多保留 1000 条失败记录用于排查，超出自动清理，防止 Redis 无限膨胀
      removeOnFail: 1000
    });
  }
}
