import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";

describe("loadEnv", () => {
  it("解析上下文构建配置", () => {
    const env = loadEnv({
      AGENT_CONTEXT_MAX_COMPLETED_RUNS: "3",
      AGENT_CONTEXT_MAX_HISTORY_CHARS: "2000"
    });

    expect(env.AGENT_CONTEXT_MAX_COMPLETED_RUNS).toBe(3);
    expect(env.AGENT_CONTEXT_MAX_HISTORY_CHARS).toBe(2000);
  });
});
