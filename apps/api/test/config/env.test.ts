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
    expect(env.AGENT_PUBLIC_BASE_URL).toBeUndefined();
    expect(env.AGENT_TOOL_RESOURCE_MAX_BYTES).toBe(200 * 1024 * 1024);
    expect(env.AGENT_TOOL_RESOURCE_DOWNLOAD_TIMEOUT_MS).toBe(60000);
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
    expect(env.AGENT_RUNNING_STATE_TTL_SECONDS).toBe(7200);
    expect(env.AGENT_RUNNING_STATE_REDIS_KEY_PREFIX).toBe("agent");
    expect(env.AGENT_QUEUE_NAME).toBe("agent-runs");
    expect(env.AGENT_WORKER_CONCURRENCY).toBe(2);
    expect(env.AGENT_RUN_LOCK_TTL_SECONDS).toBe(1800);
    expect(env.AGENT_CANCEL_TTL_SECONDS).toBe(7200);
    expect(env.CORS_ORIGINS).toBeUndefined();
    expect("AGENT_RUNNING_STATE_STORE" in env).toBe(false);
    expect("AGENT_RUN_EXECUTION_MODE" in env).toBe(false);
    expect("AGENT_EVENT_BUS" in env).toBe(false);
    expect("VOLCENGINE_IMAGE_ENDPOINT" in env).toBe(false);
    expect("VOLCENGINE_VIDEO_REQ_KEY" in env).toBe(false);
  });

  it("忽略旧的本地 agent 事件日志路径配置", () => {
    const env = loadEnv({
      AGENT_EVENT_LOG_PATH: "./tmp/agent-events.jsonl"
    });

    expect("AGENT_EVENT_LOG_PATH" in env).toBe(false);
  });

  it("解析 Redis 连接和 key 配置", () => {
    const env = loadEnv({
      REDIS_URL: "redis://redis.internal:6379/2",
      AGENT_RUNNING_STATE_TTL_SECONDS: "3600",
      AGENT_RUNNING_STATE_REDIS_KEY_PREFIX: "facai-agent"
    });

    expect(env.REDIS_URL).toBe("redis://redis.internal:6379/2");
    expect(env.AGENT_RUNNING_STATE_TTL_SECONDS).toBe(3600);
    expect(env.AGENT_RUNNING_STATE_REDIS_KEY_PREFIX).toBe("facai-agent");
  });

  it("解析 Redis 队列运行时配置", () => {
    const env = loadEnv({
      AGENT_QUEUE_NAME: "facai-agent-runs",
      AGENT_WORKER_CONCURRENCY: "4",
      AGENT_RUN_LOCK_TTL_SECONDS: "900",
      AGENT_CANCEL_TTL_SECONDS: "3600"
    });

    expect(env.AGENT_QUEUE_NAME).toBe("facai-agent-runs");
    expect(env.AGENT_WORKER_CONCURRENCY).toBe(4);
    expect(env.AGENT_RUN_LOCK_TTL_SECONDS).toBe(900);
    expect(env.AGENT_CANCEL_TTL_SECONDS).toBe(3600);
  });

  it("解析工具资源转储配置", () => {
    const env = loadEnv({
      AGENT_PUBLIC_BASE_URL: "https://agent.example.com",
      AGENT_TOOL_RESOURCE_MAX_BYTES: "1048576",
      AGENT_TOOL_RESOURCE_DOWNLOAD_TIMEOUT_MS: "30000"
    });

    expect(env.AGENT_PUBLIC_BASE_URL).toBe("https://agent.example.com");
    expect(env.AGENT_TOOL_RESOURCE_MAX_BYTES).toBe(1048576);
    expect(env.AGENT_TOOL_RESOURCE_DOWNLOAD_TIMEOUT_MS).toBe(30000);
  });

  it("解析 CORS 白名单配置", () => {
    const env = loadEnv({
      CORS_ORIGINS: "https://app.example.com, http://127.0.0.1:4000 "
    });

    expect(env.CORS_ORIGINS).toEqual(["https://app.example.com", "http://127.0.0.1:4000"]);
  });

  it("解析独立 embedding 模型配置", () => {
    const env = loadEnv({
      OPENAI_API_KEY: "deepseek-key",
      OPENAI_BASE_URL: "https://api.deepseek.com",
      OPENAI_MODEL: "deepseek-v4-flash",
      OPENAI_EMBEDDING_API_KEY: "ollama",
      OPENAI_EMBEDDING_BASE_URL: "http://localhost:11434/v1",
      OPENAI_EMBEDDING_MODEL: "embeddinggemma"
    });

    expect(env.OPENAI_BASE_URL).toBe("https://api.deepseek.com");
    expect(env.OPENAI_MODEL).toBe("deepseek-v4-flash");
    expect(env.OPENAI_EMBEDDING_API_KEY).toBe("ollama");
    expect(env.OPENAI_EMBEDDING_BASE_URL).toBe("http://localhost:11434/v1");
    expect(env.OPENAI_EMBEDDING_MODEL).toBe("embeddinggemma");
  });

  it("解析本地 Ollama embedding 配置", () => {
    const env = loadEnv({
      EMBEDDING_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "http://localhost:11434",
      OLLAMA_EMBEDDING_MODEL: "embeddinggemma"
    });

    expect(env.EMBEDDING_PROVIDER).toBe("ollama");
    expect(env.OLLAMA_BASE_URL).toBe("http://localhost:11434");
    expect(env.OLLAMA_EMBEDDING_MODEL).toBe("embeddinggemma");
  });

  it("不再解析火山供应商默认配置", () => {
    const env = loadEnv({
      VOLCENGINE_ACCESS_KEY_ID: "ak-test",
      VOLCENGINE_SECRET_ACCESS_KEY: "sk-test",
      VOLCENGINE_IMAGE_ENDPOINT: "https://example.com",
      VOLCENGINE_IMAGE_REQ_KEY: "custom-image",
      VOLCENGINE_IMAGE_MAX_POLL_ATTEMPTS: "99",
      VOLCENGINE_VIDEO_REQ_KEY: "custom-video",
      VOLCENGINE_VIDEO_MAX_POLL_ATTEMPTS: "99"
    });

    expect(env.VOLCENGINE_ACCESS_KEY_ID).toBe("ak-test");
    expect(env.VOLCENGINE_SECRET_ACCESS_KEY).toBe("sk-test");
    expect("VOLCENGINE_IMAGE_ENDPOINT" in env).toBe(false);
    expect("VOLCENGINE_IMAGE_REQ_KEY" in env).toBe(false);
    expect("VOLCENGINE_IMAGE_MAX_POLL_ATTEMPTS" in env).toBe(false);
    expect("VOLCENGINE_VIDEO_REQ_KEY" in env).toBe(false);
    expect("VOLCENGINE_VIDEO_MAX_POLL_ATTEMPTS" in env).toBe(false);
  });
});
