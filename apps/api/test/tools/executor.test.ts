import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolAccessPolicy } from "../../src/modules/tools/access-policy.js";
import { ToolExecutor } from "../../src/modules/tools/executor.js";
import { ToolRegistry } from "../../src/modules/tools/registry.js";

describe("ToolExecutor", () => {
  it("校验参数后执行工具并返回统一成功结果", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "Echo input",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      },
      argumentSchema: z.object({ text: z.string().min(1) }),
      execute: async (args, context) => ({
        text: args.text,
        messageId: context.messageId
      })
    });
    const executor = new ToolExecutor({ registry, timeoutMs: 100 });

    const result = await executor.execute({
      toolName: "echo",
      arguments: { text: "hi" },
      messageId: "msg_1"
    });

    expect(result).toMatchObject({
      ok: true,
      data: { text: "hi", messageId: "msg_1" }
    });
    expect(result.durationMs).toEqual(expect.any(Number));
  });

  it("工具显式返回 llmContent 时拆分系统数据和 LLM 文本", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "search",
      description: "Search",
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        data: {
          raw: "完整搜索结果",
          results: [{ title: "A", url: "https://example.com" }]
        },
        llmContent: "给 LLM 的短搜索摘要"
      })
    });
    const executor = new ToolExecutor({ registry, timeoutMs: 100 });

    const result = await executor.execute({
      toolName: "search",
      arguments: {}
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        raw: "完整搜索结果",
        results: [{ title: "A", url: "https://example.com" }]
      },
      llmContent: "给 LLM 的短搜索摘要"
    });
  });

  it("普通工具返回带 data 字段的业务对象时不会被误拆", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "plain_data",
      description: "Plain data",
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        data: "这是业务字段，不是 ToolOutput"
      })
    });
    const executor = new ToolExecutor({ registry, timeoutMs: 100 });

    const result = await executor.execute({
      toolName: "plain_data",
      arguments: {}
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        data: "这是业务字段，不是 ToolOutput"
      }
    });
    expect(result).not.toHaveProperty("llmContent");
  });

  it("未知工具返回 TOOL_NOT_FOUND", async () => {
    const executor = new ToolExecutor({ registry: new ToolRegistry(), timeoutMs: 100 });

    const result = await executor.execute({
      toolName: "missing",
      arguments: {}
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "TOOL_NOT_FOUND",
        message: "未找到工具：missing",
        recoverable: false
      }
    });
  });

  it("参数校验失败返回 TOOL_INVALID_ARGUMENTS", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "Echo input",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      },
      argumentSchema: z.object({ text: z.string().min(1) }),
      execute: async (args) => ({ text: args.text })
    });
    const executor = new ToolExecutor({ registry, timeoutMs: 100 });

    const result = await executor.execute({
      toolName: "echo",
      arguments: {}
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "TOOL_INVALID_ARGUMENTS",
        message: "工具 echo 的参数不合法",
        recoverable: true
      }
    });
  });

  it("权限策略拒绝的工具不会进入参数校验和执行阶段", async () => {
    const registry = new ToolRegistry();
    let executed = false;
    registry.register({
      name: "dangerous_tool",
      description: "Dangerous tool",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      },
      argumentSchema: z.object({ path: z.string().min(1) }),
      execute: async () => {
        executed = true;
        return { ok: true };
      }
    });
    const executor = new ToolExecutor({
      registry,
      timeoutMs: 100,
      accessPolicy: new ToolAccessPolicy({ allowedToolNames: ["calculator"] })
    });

    const result = await executor.execute({
      toolName: "dangerous_tool",
      arguments: {}
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "TOOL_FORBIDDEN",
        message: "工具 dangerous_tool 未被当前权限策略允许",
        recoverable: false
      }
    });
    expect(executed).toBe(false);
  });

  it("工具抛错时返回 TOOL_EXECUTION_ERROR", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "explode",
      description: "Explode",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("boom");
      }
    });
    const executor = new ToolExecutor({ registry, timeoutMs: 100 });

    const result = await executor.execute({
      toolName: "explode",
      arguments: {}
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "TOOL_EXECUTION_ERROR",
        message: "boom",
        recoverable: false
      }
    });
  });

  it("工具执行超过超时时间返回 TOOL_TIMEOUT 并通知工具 signal", async () => {
    const registry = new ToolRegistry();
    let aborted = false;
    registry.register({
      name: "slow",
      description: "Slow tool",
      parameters: { type: "object", properties: {} },
      execute: async (_args, context) => {
        context.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { ok: true };
      }
    });
    const executor = new ToolExecutor({ registry, timeoutMs: 5 });

    const result = await executor.execute({
      toolName: "slow",
      arguments: {}
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "TOOL_TIMEOUT",
        message: "工具 slow 执行超时",
        recoverable: true
      }
    });
    expect(aborted).toBe(true);
  });

  it("工具配置了独立超时时间时优先使用工具超时", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "slow_image_tool",
      description: "Slow image tool",
      parameters: { type: "object", properties: {} },
      timeoutMs: 5,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { ok: true };
      }
    });
    const executor = new ToolExecutor({ registry, timeoutMs: 1000 });

    const result = await executor.execute({
      toolName: "slow_image_tool",
      arguments: {}
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "TOOL_TIMEOUT",
        message: "工具 slow_image_tool 执行超时",
        recoverable: true
      }
    });
  });
});
