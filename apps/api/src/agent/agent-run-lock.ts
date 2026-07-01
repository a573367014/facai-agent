import { randomUUID } from "node:crypto";

export interface AgentRunLockLease {
  release(): Promise<void>;
}

export interface AgentRunLock {
  acquire(runId: string): Promise<AgentRunLockLease | undefined>;
}

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

const releaseLockScript = `
local key = KEYS[1]
local token = ARGV[1]

if redis.call("GET", key) ~= token then
  return 0
end

return redis.call("DEL", key)
`;

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
