import { describe, expect, it } from "vitest";
import {
  clearActiveRunId,
  readActiveRunId,
  readRunningRunsBySession,
  withRunningRun,
  withoutRunningRunByRunId,
  withoutRunningRunForSession,
  writeActiveRunId,
  writeRunningRunsBySession
} from "./run-registry";

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    }
  };

  return { storage, values };
}

describe("run registry", () => {
  it("读取时过滤非法 session 条目", () => {
    const { storage } = createStorage({
      "agent.runningRunsBySession": JSON.stringify({
        session_1: { runId: "run_1" },
        missingRun: {},
        numericRun: { runId: 1 },
        primitive: "run_2"
      })
    });

    expect(readRunningRunsBySession(storage)).toEqual({
      session_1: { runId: "run_1" }
    });
  });

  it("非法 JSON 回退为空 registry", () => {
    const { storage } = createStorage({ "agent.runningRunsBySession": "{" });

    expect(readRunningRunsBySession(storage)).toEqual({});
  });

  it("非空 registry 序列化，空 registry 删除 storage key", () => {
    const { storage, values } = createStorage();

    writeRunningRunsBySession({ session_1: { runId: "run_1" } }, storage);
    expect(JSON.parse(values.get("agent.runningRunsBySession") ?? "{}")).toEqual({
      session_1: { runId: "run_1" }
    });

    writeRunningRunsBySession({}, storage);
    expect(values.has("agent.runningRunsBySession")).toBe(false);
  });

  it("设置、覆盖并按 runId 删除所有匹配会话", () => {
    const first = withRunningRun({}, "session_1", "run_old");
    const registry = withRunningRun(
      withRunningRun(first, "session_1", "run_shared"),
      "session_2",
      "run_shared"
    );

    expect(registry).toEqual({
      session_1: { runId: "run_shared" },
      session_2: { runId: "run_shared" }
    });
    expect(withoutRunningRunByRunId(registry, "run_shared")).toEqual({});
  });

  it("删除不存在的 run/session 时保持原引用", () => {
    const registry = { session_1: { runId: "run_1" } };

    expect(withoutRunningRunByRunId(registry, "missing")).toBe(registry);
    expect(withoutRunningRunForSession(registry, "missing")).toBe(registry);
  });

  it("统一读写和清理 active run", () => {
    const { storage } = createStorage();

    writeActiveRunId("run_1", storage);
    expect(readActiveRunId(storage)).toBe("run_1");

    clearActiveRunId(storage);
    expect(readActiveRunId(storage)).toBeNull();
  });
});
