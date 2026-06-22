import { ZodError } from "zod";
import type { JsonObject, RegisteredTool, ToolDefinition } from "../agent/types.js";
import { AppError } from "../errors/app-error.js";

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters
    }));
  }

  async execute(name: string, args: JsonObject): Promise<unknown> {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new AppError("TOOL_NOT_FOUND", `未找到工具：${name}`, 404);
    }

    try {
      const parsedArgs = tool.argumentSchema ? tool.argumentSchema.parse(args) : args;
      return await tool.execute(parsedArgs as JsonObject);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      if (error instanceof ZodError) {
        throw new AppError("TOOL_ARGUMENT_INVALID", `工具 ${name} 的参数不合法`, 400);
      }

      const message = error instanceof Error ? error.message : "工具执行失败";
      throw new AppError("TOOL_EXECUTION_ERROR", message, 500);
    }
  }
}
