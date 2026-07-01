import { describe, expect, it } from "vitest";
import {
  InMemoryAgentRunLock,
  RedisAgentRunLock,
  type RedisRunLockClient
} from "../../src/agent/agent-run-lock.js";

class FakeRedisRunLockClient implements RedisRunLockClient {
  readonly values = new Map<string, string>();
  readonly expirations = new Map<string, number>();

  async set(key: string, value: string, mode: "NX", expiryMode: "EX", ttlSeconds: number): Promise<"OK" | null> {
    if (mode !== "NX" || expiryMode !== "EX") {
      throw new Error("unexpected lock mode");
    }

    if (this.values.has(key)) {
      return null;
    }

    this.values.set(key, value);
    this.expirations.set(key, ttlSeconds);
    return "OK";
  }

  async eval(_script: string, _numKeys: number, key: string, token: string): Promise<unknown> {
    if (this.values.get(key) !== token) {
      return 0;
    }

    this.values.delete(key);
    this.expirations.delete(key);
    return 1;
  }
}

describe("AgentRunLock", () => {
  it("prevents duplicate in-memory execution for the same run", async () => {
    const lock = new InMemoryAgentRunLock();

    const firstLease = await lock.acquire("run_1");
    const secondLease = await lock.acquire("run_1");

    expect(firstLease).toBeDefined();
    expect(secondLease).toBeUndefined();

    await firstLease?.release();

    expect(await lock.acquire("run_1")).toBeDefined();
  });

  it("uses Redis NX EX lock keys and releases only the matching lease", async () => {
    const client = new FakeRedisRunLockClient();
    const lock = new RedisAgentRunLock({
      client,
      keyPrefix: "agent:test",
      ttlSeconds: 900,
      tokenFactory: () => "lease-token"
    });

    const firstLease = await lock.acquire("run_1");
    const secondLease = await lock.acquire("run_1");

    const key = "agent:test:run:{run_1}:lock";
    expect(firstLease).toBeDefined();
    expect(secondLease).toBeUndefined();
    expect(client.values.get(key)).toBe("lease-token");
    expect(client.expirations.get(key)).toBe(900);

    await firstLease?.release();

    expect(client.values.has(key)).toBe(false);
  });
});
