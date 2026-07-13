/**
 * 工具系统类型定义（契约层）
 *
 * 本文件只声明类型，不含运行时逻辑，是整个 tools 子系统的基础契约：
 * - 对上（AgentService / LLM）：提供 ToolDefinition，描述模型可见的工具形态。
 * - 对内（Registry / Executor / 各具体工具）：提供 RegisteredTool、ToolExecutionInput/Result、ToolOutput，
 *   把"注册"和"执行"两种关注点拆开。
 *
 * 设计边界：parameters 是 JSON Schema（给 OpenAI-compatible 接口直接消费），
 * argumentSchema 是 zod（给后端运行时校验），两者刻意不合并——
 * 否则"模型看到的形状"会和"后端信任的形状"耦合，任一方调整都会牵连另一方。
 */
import type { ZodTypeAny } from "zod";

export type JsonObject = Record<string, unknown>;
export type ToolProgressPayload = JsonObject;

// 给 LLM 看的工具定义。这里的 parameters 保持 JSON Schema 形态，
// 因为 OpenAI-compatible tools payload 需要直接消费这个结构。
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
}

// 每一次工具执行都会带上这份上下文。当前主要使用 toolCallId 和 signal，
// messageId/sessionId 先预留给后续权限、审计、取消、工具日志等能力。
export interface ToolExecutionContext {
  messageId?: string;
  sessionId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
  // 长耗时工具可以用它发“中间态”，例如批量生图里某一张已经完成。
  // 它只负责把结构化进度交给 AgentService；最终结果仍然必须通过 execute 的 return 返回。
  emitProgress?: (progress: ToolProgressPayload) => void | Promise<void>;
}

// 后端真正注册和执行的工具。它比 ToolDefinition 多了两件事：
// argumentSchema 负责运行时校验，execute 负责真正干活。
// 这样 LLM 看到的是 JSON Schema，后端校验用的是 zod，两边职责不会混在一起。
export interface RegisteredTool extends ToolDefinition {
  argumentSchema?: ZodTypeAny;
  timeoutMs?: number;
  execute: (args: JsonObject, context: ToolExecutionContext) => Promise<unknown | ToolOutput> | unknown | ToolOutput;
}

// 工具可以直接返回普通业务数据，也可以返回 ToolOutput。
// data 是完整结构化结果，给前端、日志、回放使用；llmContent 是压缩后的文本，专门给 LLM 继续推理使用。
// 注意：只有显式提供 llmContent 才算 ToolOutput。这样普通业务对象 { data: ... } 不会被误拆。
// 不强制每个工具都写 llmContent，是为了让 calculator/current_time 这类简单工具继续保持轻量。
export interface ToolOutput {
  data: unknown;
  llmContent: string;
}

// AgentService 调用 ToolExecutor 时传入的执行请求。
// toolName/arguments 来自模型返回的 tool call，其余字段来自运行时上下文。
export interface ToolExecutionInput extends ToolExecutionContext {
  toolName: string;
  arguments: JsonObject;
}

// 工具执行统一返回 ok/data 或 ok/error，而不是让各种异常直接向外散开。
// AgentService 只需要判断 ok，就能决定发 tool_result 还是 tool_error。
export type ToolExecutionResult =
  | {
      ok: true;
      data: unknown;
      durationMs: number;
      llmContent?: string;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        // recoverable=true 时，AgentService 可以把错误作为 role=tool 的观察结果回灌给 LLM；
        // recoverable=false 时，通常直接结束本次消息，避免模型在系统级错误上空转。
        recoverable: boolean;
      };
      durationMs: number;
      llmContent?: string;
    };
