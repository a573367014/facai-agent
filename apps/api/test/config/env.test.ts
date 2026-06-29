import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";

describe("loadEnv", () => {
  it("解析上下文构建配置", () => {
    const env = loadEnv({
      AGENT_CONTEXT_MAX_MESSAGES: "3",
      AGENT_CONTEXT_MAX_HISTORY_CHARS: "2000",
      AGENT_SUMMARY_TRIGGER_MESSAGES: "8",
      AGENT_SUMMARY_KEEP_RECENT_MESSAGES: "4",
      AGENT_SUMMARY_TRIGGER_CHARS: "1000"
    });

    expect(env.AGENT_CONTEXT_MAX_MESSAGES).toBe(3);
    expect(env.AGENT_CONTEXT_MAX_HISTORY_CHARS).toBe(2000);
    expect(env.AGENT_SUMMARY_TRIGGER_MESSAGES).toBe(8);
    expect(env.AGENT_SUMMARY_KEEP_RECENT_MESSAGES).toBe(4);
    expect(env.AGENT_SUMMARY_TRIGGER_CHARS).toBe(1000);
    expect(env.AGENT_EVENT_RETENTION_DAYS).toBe(3);
    expect(env.AGENT_EVENT_CLEANUP_HOUR).toBe(3);
    expect(env.AGENT_EVENT_CLEANUP_BATCH_SIZE).toBe(2000);
    expect(env.AGENT_EVENT_CLEANUP_MAX_BATCHES).toBe(20);
    expect(env.VOLCENGINE_IMAGE_EDIT_VERSION).toBe("2022-08-31");
    expect(env.VOLCENGINE_IMAGE_EDIT_REQ_KEY).toBe("seededit_v3.0");
    expect(env.AGENT_RUNNING_STATE_STORE).toBe("memory");
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
    expect(env.AGENT_RUNNING_STATE_TTL_SECONDS).toBe(7200);
    expect(env.AGENT_RUNNING_STATE_REDIS_KEY_PREFIX).toBe("agent");
    expect(env.CORS_ORIGINS).toBeUndefined();
  });

  it("解析事件清理配置", () => {
    const env = loadEnv({
      AGENT_EVENT_RETENTION_DAYS: "5",
      AGENT_EVENT_CLEANUP_HOUR: "4",
      AGENT_EVENT_CLEANUP_BATCH_SIZE: "200",
      AGENT_EVENT_CLEANUP_MAX_BATCHES: "8"
    });

    expect(env.AGENT_EVENT_RETENTION_DAYS).toBe(5);
    expect(env.AGENT_EVENT_CLEANUP_HOUR).toBe(4);
    expect(env.AGENT_EVENT_CLEANUP_BATCH_SIZE).toBe(200);
    expect(env.AGENT_EVENT_CLEANUP_MAX_BATCHES).toBe(8);
  });

  it("解析运行态 Redis 配置", () => {
    const env = loadEnv({
      AGENT_RUNNING_STATE_STORE: "redis",
      REDIS_URL: "redis://redis.internal:6379/2",
      AGENT_RUNNING_STATE_TTL_SECONDS: "3600",
      AGENT_RUNNING_STATE_REDIS_KEY_PREFIX: "facai-agent"
    });

    expect(env.AGENT_RUNNING_STATE_STORE).toBe("redis");
    expect(env.REDIS_URL).toBe("redis://redis.internal:6379/2");
    expect(env.AGENT_RUNNING_STATE_TTL_SECONDS).toBe(3600);
    expect(env.AGENT_RUNNING_STATE_REDIS_KEY_PREFIX).toBe("facai-agent");
  });

  it("解析 CORS 白名单配置", () => {
    const env = loadEnv({
      CORS_ORIGINS: "https://app.example.com, http://127.0.0.1:4000 "
    });

    expect(env.CORS_ORIGINS).toEqual(["https://app.example.com", "http://127.0.0.1:4000"]);
  });
});
