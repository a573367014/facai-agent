import { ZodError } from "zod";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { AppError } from "../errors/app-error.js";
import {
  getAgentObservability,
  toObservationErrorCode,
  type AgentObservability
} from "../observability/agent-observability.js";
import { ToolAccessPolicy } from "./access-policy.js";
import type { ToolRegistry } from "./registry.js";
import type { JsonObject, ToolExecutionInput, ToolExecutionResult, ToolOutput } from "./types.js";

const tracer = trace.getTracer("tool-executor");

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  timeoutMs: number;
  accessPolicy?: ToolAccessPolicy;
  observability?: AgentObservability;
}

type TimedExecutionResult =
  | { type: "success"; data: unknown }
  | { type: "failure"; error: unknown }
  | { type: "timeout" };

interface NormalizedToolOutput {
  data: unknown;
  llmContent?: string;
}

// ToolExecutor 是工具运行时边界：AgentService 不直接执行工具，
// 而是把工具名、参数和上下文交给这里统一治理。
// 以后要加权限、审计、重试、取消，都优先放在这一层，而不是塞回 AgentService。
export class ToolExecutor {
  private readonly accessPolicy: ToolAccessPolicy;
  private readonly observability: AgentObservability;

  constructor(private readonly options: ToolExecutorOptions) {
    this.accessPolicy = options.accessPolicy ?? ToolAccessPolicy.allowAll();
    this.observability = options.observability ?? getAgentObservability();
  }

  async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    return tracer.startActiveSpan(`tool.${input.toolName}`, async (span) => {
      span.setAttributes({
        "tool.name": input.toolName,
        "tool.call_id": input.toolCallId,
        "tool.session_id": input.sessionId ?? "",
        "tool.message_id": input.messageId ?? ""
      });

      try {
        const result = await this.doExecute(input);
        this.observability.recordToolCall({
          sessionId: input.sessionId,
          messageId: input.messageId,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          status: result.ok ? "succeeded" : "failed",
          durationMs: result.durationMs,
          errorCode: result.ok ? undefined : result.error.code
        });
        span.setAttributes({
          "tool.success": result.ok,
          "tool.duration_ms": result.durationMs
        });
        if (!result.ok) {
          span.setAttribute("tool.error.recoverable", result.error.recoverable);
          span.setStatus({ code: SpanStatusCode.ERROR, message: result.error.message });
        }
        return result;
      } catch (error) {
        this.observability.recordToolCall({
          sessionId: input.sessionId,
          messageId: input.messageId,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          status: "failed",
          durationMs: this.durationSince(startedAt),
          errorCode: toObservationErrorCode(error, "TOOL_EXECUTION_ERROR")
        });
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async doExecute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    const tool = this.options.registry.getTool(input.toolName);

    // 未知工具通常说明模型产生了不可执行的 tool call。
    // 这里返回结构化失败，而不是 throw，方便 AgentService 发出 tool_error 事件。
    if (!tool) {
      return this.toFailure(startedAt, "TOOL_NOT_FOUND", `未找到工具：${input.toolName}`, false);
    }

    if (!this.accessPolicy.canUse(input.toolName)) {
      const error = this.accessPolicy.explainDenied(input.toolName);

      // 权限拒绝要发生在参数校验和 execute 之前，否则一个被禁用的工具仍然可能泄露校验细节，
      // 或在未来加入副作用工具时出现“先做了一点事再被拒绝”的风险。
      return this.toFailure(startedAt, error.code, error.message, error.recoverable);
    }

    let parsedArguments: JsonObject;

    try {
      // parameters 是给模型看的 JSON Schema，argumentSchema 才是后端真正执行前的校验。
      // 这一步把“不可信的模型参数”收敛成工具可以相信的 parsedArguments。
      parsedArguments = tool.argumentSchema ? (tool.argumentSchema.parse(input.arguments) as JsonObject) : input.arguments;
    } catch (error) {
      if (error instanceof ZodError) {
        // 参数错通常可恢复：模型还有机会根据错误换一组参数再调用。
        return this.toFailure(startedAt, "TOOL_INVALID_ARGUMENTS", `工具 ${input.toolName} 的参数不合法`, true);
      }

      return this.toFailure(startedAt, "TOOL_EXECUTION_ERROR", this.toMessage(error), false);
    }

    const controller = new AbortController();
    const cancelFromParent = () => controller.abort();

    // 外层 signal 预留给后续消息取消。外层取消时，这里同步取消当前工具；
    // 如果外层已经取消，也立即把内部 controller 标记为 aborted。
    if (input.signal?.aborted) {
      controller.abort();
    } else {
      input.signal?.addEventListener("abort", cancelFromParent, { once: true });
    }

    // Promise.resolve().then(...) 可以同时包住同步工具和异步工具：
    // 同步 throw 会进入 catch，异步 reject 也会进入 catch，调用方拿到统一结果。
    const execution = Promise.resolve()
      .then(() =>
        tool.execute(parsedArguments, {
          messageId: input.messageId,
          sessionId: input.sessionId,
          toolCallId: input.toolCallId,
          signal: controller.signal,
          emitProgress: input.emitProgress
        })
      )
      .then<TimedExecutionResult>((data) => ({ type: "success", data }))
      .catch<TimedExecutionResult>((error) => ({ type: "failure", error }));

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = tool.timeoutMs ?? this.options.timeoutMs;
    // 超时不是强杀 JavaScript 任务，而是先触发 AbortSignal，再让 race 返回 timeout。
    // 工具如果支持 context.signal，就能主动停止网络请求、文件读取等耗时操作。
    const timeout = new Promise<TimedExecutionResult>((resolve) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        resolve({ type: "timeout" });
      }, timeoutMs);
    });

    // 谁先结束就采用谁的结果：工具成功/失败，或者超时。
    const timedResult = await Promise.race([execution, timeout]);

    // 不论 race 谁赢，都要清理定时器和父 signal 监听，避免长时间运行后堆积监听器。
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    input.signal?.removeEventListener("abort", cancelFromParent);

    if (timedResult.type === "success") {
      const normalizedOutput = this.normalizeToolOutput(timedResult.data);
      const result: Extract<ToolExecutionResult, { ok: true }> = {
        ok: true,
        data: normalizedOutput.data,
        durationMs: this.durationSince(startedAt)
      };

      // llmContent 是一个显式能力，不是每个工具都有。
      // 没有精简文本时不返回 undefined 字段，可以让调用方通过字段存在与否判断工具是否做了 LLM 视图优化。
      if (normalizedOutput.llmContent) {
        result.llmContent = normalizedOutput.llmContent;
      }

      return result;
    }

    if (timedResult.type === "timeout") {
      // 超时标记为 recoverable，是因为 Agent 后续可以选择换工具、缩小请求范围或提示用户重试。
      return this.toFailure(startedAt, "TOOL_TIMEOUT", `工具 ${input.toolName} 执行超时`, true);
    }

    if (timedResult.error instanceof AppError) {
      // 工具内部主动抛出的 AppError 保留原始 code/message，避免丢掉业务语义。
      return this.toFailure(startedAt, timedResult.error.code, timedResult.error.message, false);
    }

    return this.toFailure(startedAt, "TOOL_EXECUTION_ERROR", this.toMessage(timedResult.error), false);
  }

  private normalizeToolOutput(output: unknown): NormalizedToolOutput {
    // 普通工具可以直接返回业务对象；只有显式 ToolOutput 才会拆出 llmContent。
    // 只有当工具显式返回 { data, llmContent } 时，才拆出给 LLM 的精简内容。
    // 这样即使某个业务工具天然返回 { data: ... }，也不会被误当成 ToolOutput。
    if (!this.isToolOutput(output)) {
      return { data: output };
    }

    return {
      data: output.data,
      llmContent: output.llmContent?.trim() || undefined
    };
  }

  private isToolOutput(output: unknown): output is ToolOutput {
    return (
      typeof output === "object" &&
      output !== null &&
      Object.prototype.hasOwnProperty.call(output, "data") &&
      Object.prototype.hasOwnProperty.call(output, "llmContent") &&
      (typeof (output as ToolOutput).llmContent === "string" || (output as ToolOutput).llmContent === undefined)
    );
  }

  private toFailure(
    startedAt: number,
    code: string,
    message: string,
    recoverable: boolean
  ): Extract<ToolExecutionResult, { ok: false }> {
    return {
      ok: false,
      error: {
        code,
        message,
        recoverable
      },
      durationMs: this.durationSince(startedAt)
    };
  }

  private durationSince(startedAt: number) {
    return Math.max(0, Date.now() - startedAt);
  }

  private toMessage(error: unknown) {
    return error instanceof Error ? error.message : "工具执行失败";
  }
}
