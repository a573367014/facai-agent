import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isAutoStartableRedisUrl,
  parseEnvFile,
  resolveRedisUrl
} from "./ensure-redis.mjs";

describe("ensure-redis", () => {
  it("reads REDIS_URL from env file content", () => {
    const env = parseEnvFile(`
PORT=4001
REDIS_URL=redis://127.0.0.1:6380
`);

    assert.equal(resolveRedisUrl({ env }), "redis://127.0.0.1:6380");
  });

  it("only auto-starts local Redis without credentials", () => {
    assert.equal(isAutoStartableRedisUrl("redis://localhost:6379"), true);
    assert.equal(isAutoStartableRedisUrl("redis://127.0.0.1:6379"), true);
    assert.equal(isAutoStartableRedisUrl("redis://:secret@localhost:6379"), false);
    assert.equal(isAutoStartableRedisUrl("redis://redis.example.com:6379"), false);
  });
});
