/**
 * 工具桥接层：把内部 ToolDefinition 转成 LangChain/OpenAI 工具格式。
 *
 * 本文件是"工具系统"和"LLM 调用层"之间的桥梁。工具注册中心（ToolRegistry）
 * 存的是内部 ToolDefinition（扁平结构），而 LangChain 的 bindTools 需要
 * OpenAI-compatible 的嵌套结构 { type: "function", function: {...} }。
 * 本文件负责这两种格式之间的转换，以及按权限策略过滤工具、按名称查找工具。
 *
 * 边界说明：本文件只做格式转换和查询代理，不做工具执行——
 * 真正执行工具的逻辑在 tools/executor.ts 里。把"转换"和"执行"拆开，
 * 是为了让 Agent 引擎在"决定给模型看哪些工具"和"执行模型选中的工具"
 * 两个阶段各自独立变化。
 */
import type { ToolDefinition } from "../types.js";
import type { RegisteredTool } from "../../tools/types.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { ToolAccessPolicy } from "../../tools/access-policy.js";

/**
 * OpenAI-compatible 工具描述格式。
 *
 * 这是 LangChain bindTools 和 OpenAI Chat Completions API 共同要求的
 * 工具 payload 结构：外层 type 固定 "function"，内层 function 携带
 * name/description/parameters（JSON Schema）。
 */
export interface BindingsTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * 把内部 ToolDefinition 数组转成 OpenAI-compatible 工具格式。
 *
 * 内部 ToolDefinition 是扁平的 { name, description, parameters }，
 * 而模型 API 需要嵌套的 { type: "function", function: {...} }。
 * 这层包装是纯结构映射，不改变任何语义。
 */
export function toBindingsTools(definitions: ToolDefinition[]): BindingsTool[] {
  return definitions.map((definition) => ({
    type: "function" as const,
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters
    }
  }));
}

/**
 * 按权限策略过滤工具定义列表。
 *
 * 不是所有注册的工具都应该对所有用户/场景可见。ToolAccessPolicy 负责
 * 决定"哪些工具能用"，本函数只是把策略应用到注册中心的完整列表上。
 * 拆出来的好处：权限策略可以独立测试和替换，不影响工具注册逻辑。
 */
export function collectToolDefinitions(
  registry: ToolRegistry,
  accessPolicy: ToolAccessPolicy
): ToolDefinition[] {
  return accessPolicy.filterDefinitions(registry.getDefinitions());
}

/**
 * 按名称从注册中心查找已注册工具。
 *
 * 返回 RegisteredTool（含 execute 函数和 argumentSchema），
 * 找不到时返回 undefined，由调用方决定如何处理（通常是报"工具不存在"错误）。
 */
export function lookupRegisteredTool(
  registry: ToolRegistry,
  name: string
): RegisteredTool | undefined {
  return registry.getTool(name);
}
