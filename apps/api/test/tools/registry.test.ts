import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "../../src/errors/app-error.js";
import { ToolRegistry } from "../../src/tools/registry.js";

describe("ToolRegistry", () => {
  it("注册并执行工具", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "Echo input",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      },
      execute: async (args) => ({ text: String(args.text) })
    });

    await expect(registry.execute("echo", { text: "hi" })).resolves.toEqual({ text: "hi" });
    expect(registry.getDefinitions()).toHaveLength(1);
  });

  it("未知工具返回 TOOL_NOT_FOUND", async () => {
    const registry = new ToolRegistry();

    await expect(registry.execute("missing", {})).rejects.toMatchObject<AppError>({
      code: "TOOL_NOT_FOUND",
      message: "未找到工具：missing"
    });
  });

  it("统一校验工具参数", async () => {
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

    await expect(registry.execute("echo", {})).rejects.toMatchObject<AppError>({
      code: "TOOL_ARGUMENT_INVALID",
      message: "工具 echo 的参数不合法"
    });
  });
});
