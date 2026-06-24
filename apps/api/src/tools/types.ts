import type { ZodTypeAny } from "zod";

export type JsonObject = Record<string, unknown>;

// 给 LLM 看的工具定义。这里的 parameters 保持 JSON Schema 形态，
// 因为 OpenAI-compatible tools payload 需要直接消费这个结构。
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
}

// 每一次工具执行都会带上这份上下文。当前主要使用 toolCallId 和 signal，
// runId/sessionId 先预留给后续权限、审计、取消 run、工具日志等能力。
export interface ToolExecutionContext {
  runId?: string;
  sessionId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
}

// 后端真正注册和执行的工具。它比 ToolDefinition 多了两件事：
// argumentSchema 负责运行时校验，execute 负责真正干活。
// 这样 LLM 看到的是 JSON Schema，后端校验用的是 zod，两边职责不会混在一起。
export interface RegisteredTool extends ToolDefinition {
  argumentSchema?: ZodTypeAny;
  execute: (args: JsonObject, context: ToolExecutionContext) => Promise<unknown> | unknown;
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
      displayText?: string;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        // recoverable=true 时，AgentService 可以把错误作为 role=tool 的观察结果回灌给 LLM；
        // recoverable=false 时，通常直接结束本次 run，避免模型在系统级错误上空转。
        recoverable: boolean;
      };
      durationMs: number;
    };
