import { describe, expect, it } from "vitest";
import {
  RedisRunningMessageStateStore,
  type RedisRunningMessageClient
} from "../../src/platform/redis/redis-running-message-state-store.js";

class FakeRedisClient implements RedisRunningMessageClient {
  readonly values = new Map<string, string>();
  readonly expirations = new Map<string, number>();
  readonly evalCalls: Array<{ script: string; numKeys: number; args: Array<string | number> }> = [];

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<unknown> {
    this.values.set(key, value);

    if (mode === "EX" && typeof ttlSeconds === "number") {
      this.expirations.set(key, ttlSeconds);
    }

    return "OK";
  }

  async del(key: string): Promise<unknown> {
    this.values.delete(key);
    this.expirations.delete(key);
    return 1;
  }

  async eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    this.evalCalls.push({ script, numKeys, args });
    const [key] = args;

    if (typeof key !== "string") {
      throw new Error("missing redis key");
    }

    const rawState = this.values.get(key);

    if (!rawState) {
      return null;
    }

    const state = JSON.parse(rawState) as {
      parts: Array<{ type: string; value?: string; [key: string]: unknown }>;
      version: number;
      updatedAt: string;
    };

    if (script.includes("delta")) {
      const [, delta, updatedAt, ttlSeconds] = args;
      const lastIndex = state.parts.length - 1;
      const lastPart = state.parts[lastIndex];
      let partIndex;

      if (lastPart && lastPart.type === "text") {
        partIndex = lastIndex;
      } else {
        state.parts.push({ type: "text", value: "" });
        partIndex = state.parts.length - 1;
      }

      state.parts[partIndex] = {
        ...state.parts[partIndex],
        value: `${state.parts[partIndex].value ?? ""}${delta}`
      };
      state.version += 1;
      state.updatedAt = String(updatedAt);
      this.values.set(key, JSON.stringify(state));
      this.expirations.set(key, Number(ttlSeconds));

      return JSON.stringify({ state, partIndex });
    }

    const [, encodedParts, updatedAt, ttlSeconds] = args;
    state.parts = JSON.parse(String(encodedParts));
    state.version += 1;
    state.updatedAt = String(updatedAt);
    this.values.set(key, JSON.stringify(state));
    this.expirations.set(key, Number(ttlSeconds));

    return JSON.stringify(state);
  }
}

describe("RedisRunningMessageStateStore", () => {
  it("uses a cluster-safe key and expires running message drafts", async () => {
    const client = new FakeRedisClient();
    const store = new RedisRunningMessageStateStore({
      client,
      keyPrefix: "agent:test",
      ttlSeconds: 60,
      now: () => "2026-06-28T10:00:00.000Z"
    });

    const state = await store.init({
      messageId: "msg_1",
      sessionId: "session_1",
      runId: "run_1",
      parts: [{ type: "text", value: "" }]
    });

    expect(state).toMatchObject({
      messageId: "msg_1",
      sessionId: "session_1",
      runId: "run_1",
      version: 0,
      updatedAt: "2026-06-28T10:00:00.000Z"
    });
    expect(client.values.has("agent:test:running-message:{msg_1}:state")).toBe(true);
    expect(client.expirations.get("agent:test:running-message:{msg_1}:state")).toBe(60);
  });

  it("appends text delta through Lua and increments the draft version", async () => {
    const client = new FakeRedisClient();
    const store = new RedisRunningMessageStateStore({
      client,
      keyPrefix: "agent:test",
      ttlSeconds: 60,
      now: () => "2026-06-28T10:01:00.000Z"
    });

    await store.init({
      messageId: "msg_1",
      sessionId: "session_1",
      parts: [{ type: "text", value: "你" }]
    });

    const result = await store.appendTextDelta("msg_1", "好");

    expect(result).toMatchObject({
      partIndex: 0,
      state: {
        messageId: "msg_1",
        parts: [{ type: "text", value: "你好" }],
        version: 1,
        updatedAt: "2026-06-28T10:01:00.000Z"
      }
    });
    expect(client.evalCalls).toHaveLength(1);
    expect(client.evalCalls[0]).toMatchObject({
      numKeys: 1,
      args: ["agent:test:running-message:{msg_1}:state", "好", "2026-06-28T10:01:00.000Z", 60]
    });
  });

  it("sets full parts through Lua and removes completed drafts", async () => {
    const client = new FakeRedisClient();
    const store = new RedisRunningMessageStateStore({
      client,
      keyPrefix: "agent:test",
      ttlSeconds: 60,
      now: () => "2026-06-28T10:02:00.000Z"
    });

    await store.init({
      messageId: "msg_1",
      sessionId: "session_1",
      parts: [{ type: "text", value: "生成中" }]
    });

    const updated = await store.setParts("msg_1", [
      { type: "text", value: "生成完成" },
      { type: "resource", mime: "image/png", extra: { resource: { id: "res_1" } } }
    ]);

    expect(updated).toMatchObject({
      parts: [
        { type: "text", value: "生成完成" },
        { type: "resource", mime: "image/png", extra: { resource: { id: "res_1" } } }
      ],
      version: 1
    });

    await store.remove("msg_1");

    expect(await store.get("msg_1")).toBeUndefined();
  });

  it("appends text delta after a resource part into a new trailing text part", async () => {
    const client = new FakeRedisClient();
    const store = new RedisRunningMessageStateStore({
      client,
      keyPrefix: "agent:test",
      ttlSeconds: 60,
      now: () => "2026-06-28T10:03:00.000Z"
    });

    await store.init({
      messageId: "msg_1",
      sessionId: "session_1",
      parts: [
        { type: "text", value: "好的，我来生成图片！" },
        { type: "resource", mime: "image/png", extra: { resource: { id: "res_1" } } }
      ]
    });

    const result = await store.appendTextDelta("msg_1", "图片已生成~");

    expect(result).toMatchObject({
      partIndex: 2,
      state: {
        parts: [
          { type: "text", value: "好的，我来生成图片！" },
          { type: "resource", mime: "image/png", extra: { resource: { id: "res_1" } } },
          { type: "text", value: "图片已生成~" }
        ],
        version: 1
      }
    });
  });
});
