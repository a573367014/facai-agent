export interface AgentCancellationStore {
  cancelRun(runId: string): Promise<void>;
  isRunCancelled(runId: string): Promise<boolean>;
  clearRun(runId: string): Promise<void>;
}

export interface RedisCancellationClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface RedisAgentCancellationStoreOptions {
  client: RedisCancellationClient;
  keyPrefix?: string;
  ttlSeconds?: number;
}

const defaultKeyPrefix = "agent";
const defaultTtlSeconds = 2 * 60 * 60;

export class InMemoryAgentCancellationStore implements AgentCancellationStore {
  private readonly cancelledRunIds = new Set<string>();

  async cancelRun(runId: string): Promise<void> {
    this.cancelledRunIds.add(runId);
  }

  async isRunCancelled(runId: string): Promise<boolean> {
    return this.cancelledRunIds.has(runId);
  }

  async clearRun(runId: string): Promise<void> {
    this.cancelledRunIds.delete(runId);
  }
}

export class RedisAgentCancellationStore implements AgentCancellationStore {
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;

  constructor(private readonly options: RedisAgentCancellationStoreOptions) {
    this.keyPrefix = options.keyPrefix ?? defaultKeyPrefix;
    this.ttlSeconds = options.ttlSeconds ?? defaultTtlSeconds;
  }

  async cancelRun(runId: string): Promise<void> {
    // cancel key 是跨进程取消信号：API 写入后，Worker 在执行检查点读取。
    // TTL 只是异常兜底清理；业务上是否取消仍以 SQLite run/message 状态为准。
    await this.options.client.set(this.getRunKey(runId), "1", "EX", this.ttlSeconds);
  }

  async isRunCancelled(runId: string): Promise<boolean> {
    return Boolean(await this.options.client.get(this.getRunKey(runId)));
  }

  async clearRun(runId: string): Promise<void> {
    await this.options.client.del(this.getRunKey(runId));
  }

  private getRunKey(runId: string) {
    // {runId} keeps all run-scoped keys in one Redis Cluster hash slot.
    return `${this.keyPrefix}:run:{${runId}}:cancelled`;
  }
}
