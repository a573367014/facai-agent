import { describe, expect, it } from "vitest";
import {
  InMemoryAgentCancellationStore,
  RedisAgentCancellationStore,
  type RedisCancellationClient
} from "../../src/modules/agent/agent-cancellation-store.js";

class FakeRedisCancellationClient implements RedisCancellationClient {
  readonly values = new Map<string, string>();
  readonly expirations = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown> {
    this.values.set(key, value);
    this.expirations.set(key, ttlSeconds);
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    this.values.delete(key);
    this.expirations.delete(key);
    return 1;
  }
}

describe("AgentCancellationStore", () => {
  it("stores run cancellation in memory", async () => {
    const store = new InMemoryAgentCancellationStore();

    expect(await store.isRunCancelled("run_1")).toBe(false);

    await store.cancelRun("run_1");

    expect(await store.isRunCancelled("run_1")).toBe(true);

    await store.clearRun("run_1");

    expect(await store.isRunCancelled("run_1")).toBe(false);
  });

  it("stores run cancellation in Redis with a TTL and cluster-safe key", async () => {
    const client = new FakeRedisCancellationClient();
    const store = new RedisAgentCancellationStore({
      client,
      keyPrefix: "agent:test",
      ttlSeconds: 3600
    });

    await store.cancelRun("run_1");

    const key = "agent:test:run:{run_1}:cancelled";
    expect(client.values.get(key)).toBe("1");
    expect(client.expirations.get(key)).toBe(3600);
    expect(await store.isRunCancelled("run_1")).toBe(true);

    await store.clearRun("run_1");

    expect(await store.isRunCancelled("run_1")).toBe(false);
  });
});
