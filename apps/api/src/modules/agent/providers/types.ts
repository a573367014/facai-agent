/**
 * LLM 供应商抽象接口定义。
 *
 * 本文件定义 Agent 引擎与 LLM 供应商之间的契约边界。Agent 引擎只依赖
 * 这里的 LlmProvider 接口，不直接耦合任何具体供应商 SDK（LangChain、
 * Anthropic SDK 等）。这样供应商适配层（如 runtime/provider-shim.ts）
 * 可以独立替换，Agent 引擎本身不用改。
 *
 * 边界说明：本文件只声明接口，不含任何实现。具体实现由各供应商的
 * shim 文件提供（目前只有 LangChainProviderShim）。
 */
import type { AgentMessage, ToolCall, ToolDefinition } from "../types.js";

/**
 * 向 LLM 发起的补全请求。
 *
 * - messages：对话历史（含 system/user/assistant/tool 各种角色）；
 * - tools：本轮可用的工具定义，空数组表示本轮不绑工具（纯文本对话）；
 * - signal：取消信号，长任务可被外部中断。
 */
export interface LlmProviderRequest {
  messages: AgentMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}

/**
 * LLM 补全响应。
 *
 * 一次响应要么是文字内容（content），要么是工具调用列表（toolCalls），
 * 也可能两者都有（模型边说话边调工具）。两者都可选，但至少有一个——
 * 这个校验由具体实现（如 provider-shim）负责，不在类型层面强制。
 */
export interface LlmProviderResponse {
  content?: string;
  toolCalls?: ToolCall[];
}

/**
 * 流式输出的增量回调。
 *
 * 每收到一段文本 token 就调用一次，让上层能实时推给前端。
 * 支持返回 Promise，允许异步处理（如写 SSE）。
 */
export type LlmDeltaHandler = (delta: string) => void | Promise<void>;

/**
 * LLM 供应商统一接口。
 *
 * - complete：非流式补全，一次性返回完整响应；
 * - completeStream：流式补全（可选实现），边收 token 边回调 onDelta，
 *   最终返回汇总后的完整响应。
 *
 * completeStream 是可选的（?），因为不是所有供应商都支持流式。
 * 不支持流式的供应商只实现 complete 即可，Agent 引擎会降级处理。
 */
export interface LlmProvider {
  complete(request: LlmProviderRequest): Promise<LlmProviderResponse>;
  completeStream?(request: LlmProviderRequest, onDelta: LlmDeltaHandler): Promise<LlmProviderResponse>;
}
