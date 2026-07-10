/**
 * 工具注册中心（ToolRegistry）
 *
 * 系统中所有工具的"目录层"：AgentService 通过它拿到要暴露给 LLM 的工具定义，
 * ToolExecutor 通过它按名称查到具体工具再执行。
 *
 * 边界：本文件只管"登记 / 查询 / 暴露定义"，不参与运行时治理——
 * 超时、错误包装、权限校验统一交给 executor.ts 和 access-policy.ts。
 * 这样工具目录本身保持简单，未来可以搭配不同的执行策略而不必改动这里。
 */
import type { RegisteredTool, ToolDefinition } from "./types.js";

// ToolRegistry 只是“工具目录”：负责登记工具、按名称查工具、给 LLM 暴露工具定义。
// 它不负责执行、超时、错误包装；这些运行时职责放在 ToolExecutor。
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  // 给模型的定义只包含 name/description/parameters。
  // execute、argumentSchema 是后端内部能力，不能出现在 LLM tools payload 里。
  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters
    }));
  }
}
