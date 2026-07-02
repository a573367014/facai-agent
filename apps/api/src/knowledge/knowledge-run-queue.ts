import type { JobsOptions } from "bullmq";

export interface KnowledgeIndexJobPayload {
  documentId: string;
}

export interface KnowledgeIndexQueue {
  enqueueDocumentIndex(payload: KnowledgeIndexJobPayload): Promise<void>;
}

export interface KnowledgeIndexQueueClient {
  add(name: string, payload: KnowledgeIndexJobPayload, options?: JobsOptions): Promise<unknown>;
}

export interface BullMqKnowledgeIndexQueueOptions {
  queue: KnowledgeIndexQueueClient;
}

export const knowledgeIndexJobName = "knowledge-index-document";

export class NoopKnowledgeIndexQueue implements KnowledgeIndexQueue {
  async enqueueDocumentIndex(_payload: KnowledgeIndexJobPayload): Promise<void> {}
}

export class BullMqKnowledgeIndexQueue implements KnowledgeIndexQueue {
  constructor(private readonly options: BullMqKnowledgeIndexQueueOptions) {}

  async enqueueDocumentIndex(payload: KnowledgeIndexJobPayload): Promise<void> {
    await this.options.queue.add(knowledgeIndexJobName, payload, {
      jobId: payload.documentId,
      removeOnComplete: true,
      removeOnFail: 1000
    });
  }
}
