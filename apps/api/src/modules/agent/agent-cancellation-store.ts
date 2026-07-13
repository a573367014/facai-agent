/**
 * 模块职责：Agent 运行取消标记的存储。
 *
 * 在 Agent 系统中，"取消"是一个跨进程信号：用户在 API 进程点击取消，
 * 但实际执行在 Worker 进程。Worker 需要在执行检查点（每个工具调用前后、
 * 每次迭代开始）读取这个标记，决定是否提前终止 run。
 *
 * 边界：
 * - 本模块只存储"取消信号"本身（一个布尔标记），不负责执行取消逻辑。
 * - 取消信号是"尽力而为"的：Worker 只在检查点检查，不能中断正在进行的 LLM 调用。
 * - TTL 是异常兜底：如果 Worker 崩溃后没人清理，TTL 到期后 key 自动消失，
 *   避免残留的取消标记影响后续重试。
 * - 业务上的最终状态以 SQLite run/message 表为准，取消标记只是运行时的信号。
 */
export interface AgentCancellationStore {
  cancelRun(runId: string): Promise<void>;
  isRunCancelled(runId: string): Promise<boolean>;
  clearRun(runId: string): Promise<void>;
}

/**
 * Redis 客户端的最小契约——只暴露取消标记所需的 get/set/del。
 * 为什么不直接依赖完整 Redis 类型：解耦，方便测试注入 mock。
 * set 的 mode 固定为 "EX"（带过期），确保取消标记不会永久残留。
 */
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

/**
 * 内存版取消标记存储，用于单进程场景或测试。
 *
 * 用 Set 存储被取消的 runId：存在即表示已取消，不存在表示未取消。
 * 不适用于多进程：API 写入的取消标记 Worker 看不到，跨进程必须用 Redis 版。
 */
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

/**
 * Redis 版取消标记存储，用于跨进程场景。
 *
 * 取消标记的值是 "1"（只需要存在性判断，不需要复杂值）。
 * TTL 默认 2 小时：覆盖一个 run 的最长执行时间，确保即使 Worker 崩溃，
 * 标记也不会永久残留导致后续重试被误判为"已取消"。
 */
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
