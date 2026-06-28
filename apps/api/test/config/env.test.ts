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
  });
});
