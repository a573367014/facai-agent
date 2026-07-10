/**
 * 工具权限控制策略（ToolAccessPolicy）
 *
 * 工具子系统里"谁能用哪些工具"这道闸门，被两处复用：
 * - AgentService 用它过滤暴露给 LLM 的 tools 列表，避免模型看到不该调用的工具；
 * - ToolExecutor 在真正执行前再校验一次，防止调用方绕过可见列表直接请求工具。
 *
 * 边界：当前只做 allow-list 级别的可见性控制；
 * 参数级、用户级、租户级鉴权属于后续要在这层之上扩展的能力，不放在本文件。
 */
import type { ToolDefinition } from "./types.js";

export interface ToolAccessPolicyOptions {
  allowedToolNames?: string[];
}

// ToolAccessPolicy 是工具权限的第一层形态：先用 allow-list 控制哪些工具可见、可执行。
// 它同时被 AgentService 和 ToolExecutor 使用：
// 1. AgentService 用它过滤暴露给 LLM 的 tools，减少模型误调用不可用工具；
// 2. ToolExecutor 在真正执行前再次检查，防止模型或调用方绕过“可见工具列表”直接请求工具。
export class ToolAccessPolicy {
  private readonly allowedToolNames?: Set<string>;

  constructor(options: ToolAccessPolicyOptions = {}) {
    const normalizedToolNames = options.allowedToolNames?.map((name) => name.trim()).filter(Boolean);
    this.allowedToolNames = normalizedToolNames?.length ? new Set(normalizedToolNames) : undefined;
  }

  static allowAll(): ToolAccessPolicy {
    return new ToolAccessPolicy();
  }

  filterDefinitions(definitions: ToolDefinition[]): ToolDefinition[] {
    return definitions.filter((definition) => this.canUse(definition.name));
  }

  canUse(toolName: string): boolean {
    // 没有配置 allow-list 时表示“允许注册表里的所有工具”。
    // 这样 demo 默认开箱即用；一旦接入高风险工具，再通过 AGENT_ALLOWED_TOOLS 缩小范围。
    return !this.allowedToolNames || this.allowedToolNames.has(toolName);
  }

  explainDenied(toolName: string) {
    return {
      code: "TOOL_FORBIDDEN",
      message: `工具 ${toolName} 未被当前权限策略允许`,
      recoverable: false
    };
  }
}
