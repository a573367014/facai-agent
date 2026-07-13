/**
 * 模块职责：Agent Run 执行锁。
 *
 * 在多 Worker 部署时，同一个 run 可能被多个 Worker 同时拉取（比如 BullMQ 重试、
 * 或手动重新入队）。如果不加锁，两个 Worker 会同时执行同一个 run，导致：
 * - 同一个 assistant message 被并发写入，parts 互相覆盖；
 * - 事件序列混乱，前端收到重复或矛盾的事件；
 * - 资源（工具调用、文件）被重复创建。
 *
 * 执行锁确保：同一时刻只有一个 Worker 能持有某个 run 的锁并执行。
 *
 * 边界：
 * - 锁是"尽力而为"的互斥，不是强一致性的分布式锁（没有 fencing token 机制）。
 * - TTL 兜底：如果持锁 Worker 崩溃，TTL 到期后锁自动释放，其他 Worker 可以接管。
 * - 锁只保护"执行入口"，不保护数据一致性——数据一致性由 SQLite 状态机保证。
 */
import { randomUUID } from "node:crypto";

/**
 * 锁租约：获取锁成功后返回，调用方通过 release() 释放锁。
 * 为什么用对象而不是 boolean：release 需要携带 token 信息（Redis 版），
 * 用对象封装让接口统一，内存版和 Redis 版的调用方代码一致。
 */
export interface AgentRunLockLease {
  release(): Promise<void>;
}

/**
 * Run 锁契约。
 * acquire 返回 undefined 表示锁已被占用（已有 Worker 在执行）。
 * 返回 lease 表示获取成功，调用方在执行完成后必须调用 lease.release()。
 */
export interface AgentRunLock {
  acquire(runId: string): Promise<AgentRunLockLease | undefined>;
}

/**
 * Redis 客户端的最小契约——只暴露 SET（带 NX EX）和 EVAL（执行 Lua 脚本）。
 * EVAL 用于释放锁时的原子性校验（GET + DEL 必须原子执行）。
 */
export interface RedisRunLockClient {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface RedisAgentRunLockOptions {
  client: RedisRunLockClient;
  keyPrefix?: string;
  ttlSeconds?: number;
  tokenFactory?: () => string;
}

const defaultKeyPrefix = "agent";
const defaultTtlSeconds = 30 * 60;

/**
 * 释放锁的 Lua 脚本。
 *
 * 为什么用 Lua 而不是先 GET 再 DEL：
 * GET 和 DEL 是两条命令，中间可能被其他客户端插入操作。
 * 场景：A 的锁过期 → B 获取锁 → A 执行 GET 发现 key 存在 → A 执行 DEL
 * → 结果删掉了 B 的锁！用 Lua 脚本保证"检查 token + 删除"是原子操作。
 */
const releaseLockScript = `
local key = KEYS[1]
local token = ARGV[1]

if redis.call("GET", key) ~= token then
  return 0
end

return redis.call("DEL", key)
`;

/**
 * 内存版 Run 锁，用于单进程场景或测试。
 * 用 Set 记录被锁定的 runId，简单互斥。
 * 不适用于多进程：跨进程必须用 Redis 版。
 */
export class InMemoryAgentRunLock implements AgentRunLock {
  private readonly lockedRunIds = new Set<string>();

  async acquire(runId: string): Promise<AgentRunLockLease | undefined> {
    if (this.lockedRunIds.has(runId)) {
      return undefined;
    }

    this.lockedRunIds.add(runId);

    return {
      release: async () => {
        this.lockedRunIds.delete(runId);
      }
    };
  }
}

/**
 * Redis 版 Run 锁，基于 SET NX EX 实现。
 *
 * 这是 Redis 分布式锁的经典实现（Redlock 的单节点简化版）：
 * - SET NX：只在 key 不存在时设置（互斥语义）；
 * - EX：设置过期时间，防止持锁进程崩溃后锁永不释放；
 * - token：随机 UUID，释放时校验，防止误删别人的锁。
 *
 * TTL 默认 30 分钟：覆盖一个 run 的最长执行时间。太短会导致 run 还在执行锁就过期了，
 * 太长会导致 Worker 崩溃后其他 Worker 等待太久才能接管。
 */
export class RedisAgentRunLock implements AgentRunLock {
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly tokenFactory: () => string;

  constructor(private readonly options: RedisAgentRunLockOptions) {
    this.keyPrefix = options.keyPrefix ?? defaultKeyPrefix;
    this.ttlSeconds = options.ttlSeconds ?? defaultTtlSeconds;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
  }

  async acquire(runId: string): Promise<AgentRunLockLease | undefined> {
    const key = this.getRunKey(runId);
    const token = this.tokenFactory();
    // SET NX EX 是最小可用的分布式锁：拿不到锁说明已有 Worker 在执行这个 run。
    // token 用于释放时校验所有权，避免 A 的锁过期后 B 拿到锁，A 又把 B 的锁删掉。
    const result = await this.options.client.set(key, token, "NX", "EX", this.ttlSeconds);

    if (result !== "OK") {
      return undefined;
    }

    return {
      release: async () => {
        await this.options.client.eval(releaseLockScript, 1, key, token);
      }
    };
  }

  private getRunKey(runId: string) {
    // {runId} keeps lock and cancellation keys co-located in Redis Cluster.
    return `${this.keyPrefix}:run:{${runId}}:lock`;
  }
}
