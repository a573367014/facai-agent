import { AppError, type AppErrorCode } from "../errors/app-error.js";
import type { LlmProvider } from "../providers/types.js";
import { ToolAccessPolicy } from "../tools/access-policy.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolRegistry } from "../tools/registry.js";
import { SYSTEM_INSTRUCTIONS } from "./instructions.js";
import type { AgentMessage, AgentExecutionInput, AgentExecutionResult, AgentStreamEvent } from "./types.js";

const MEDIA_SUMMARY_TOOL_NAMES = new Set(["generate_image", "edit_image", "generate_video"]);
const MEDIA_FAILURE_SUMMARY_INSTRUCTION = [
  "请基于上面的媒体生成工具结果给出最终回复。",
  "回复必须简短直接，最多 2 句；不要表格、不要标题、不要分点或长篇原因分析。",
  "只说明成功/失败数量和最关键失败原因；必要时用一句话提示调整提示词或稍后重试。",
  "不要再次调用工具，不要自动重试，不要输出图片链接、下载链接、任务 ID 或 base64 内容。"
].join("\n");

export interface AgentServiceOptions {
  provider: LlmProvider;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  toolAccessPolicy?: ToolAccessPolicy;
  defaultMaxIterations: number;
}

export class AgentService {
  private readonly toolAccessPolicy: ToolAccessPolicy;

  constructor(private readonly options: AgentServiceOptions) {
    this.toolAccessPolicy = options.toolAccessPolicy ?? ToolAccessPolicy.allowAll();
  }

  async run(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    const maxIterations = input.maxIterations ?? this.options.defaultMaxIterations;
    const replayToolCalls = input.replayToolCalls?.length ? input.replayToolCalls : undefined;
    const messages: AgentMessage[] = [
      { role: "system", content: SYSTEM_INSTRUCTIONS },
      ...(input.history ?? []),
      { role: "user", content: input.input }
    ];
    // LLM 只能看到当前策略允许的工具。这里不是唯一安全边界，
    // ToolExecutor 执行前还会再检查一次；双层处理能同时减少误调用和阻止越权执行。
    const tools = this.toolAccessPolicy.filterDefinitions(this.options.toolRegistry.getDefinitions());
    const emit = async (event: AgentStreamEvent) => {
      await input.onEvent?.(event);
    };

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      assertNotAborted(input.signal);
      await emit({ type: "iteration_start", iteration });
      await emit({ type: "agent_state", iteration, state: "thinking", label: "模型思考中" });
      const response =
        iteration === 0 && replayToolCalls
          ? { toolCalls: replayToolCalls }
          : await (async () => {
              await emit({ type: "llm_start", iteration });
              return input.onEvent && this.options.provider.completeStream
                ? await this.options.provider.completeStream({ messages, tools, signal: input.signal }, async (delta) => {
                    await emit({ type: "answer_delta", iteration, delta });
                  })
                : await this.options.provider.complete({ messages, tools, signal: input.signal });
            })();
      await emit({
        type: "llm_response",
        iteration,
        content: response.content,
        toolCalls: response.toolCalls
      });

      if (!response.toolCalls?.length) {
        if (!response.content) {
          await emit({ type: "agent_state", iteration, state: "failed", label: "模型响应无效" });
          throw new AppError("PROVIDER_BAD_RESPONSE", "模型响应缺少最终回答或工具调用", 502);
        }

        await emit({ type: "agent_state", iteration, state: "answering", label: "生成最终答案" });
        await emit({ type: "iteration_end", iteration, outcome: "final_answer" });
        await emit({ type: "agent_state", iteration, state: "done", label: "运行完成" });
        await emit({ type: "final_answer", answer: response.content });
        return { answer: response.content };
      }

      for (const toolCall of response.toolCalls) {
        await emit({
          type: "tool_call_ready",
          iteration,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          arguments: toolCall.arguments
        });
      }

      messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });
      let hasSuccessfulToolResult = false;
      let hasRecoverableToolError = false;
      let shouldSummarizeMediaFailure = false;

      for (const toolCall of response.toolCalls) {
        await emit({ type: "agent_state", iteration, state: "calling_tool", label: `调用工具 ${toolCall.name}` });
        await emit({
          type: "tool_start",
          iteration,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          arguments: toolCall.arguments
        });
        // AgentService 只编排 Agent 流程，不直接校验/执行工具。
        // 工具治理细节交给 ToolExecutor，这样后续加权限、超时、取消时不会把这里写胖。
        const execution = await this.options.toolExecutor.execute({
          messageId: input.messageId,
          sessionId: input.sessionId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          arguments: toolCall.arguments,
          signal: input.signal,
          // emitProgress 是工具内部发中间态的出口。
          // AgentService 在这里补上 iteration/toolCallId/toolName，让前端和持久化层不用理解工具私有上下文。
          emitProgress: async (progress) => {
            await emit({
              type: "tool_progress",
              iteration,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              progress
            });
          }
        });

        if (!execution.ok) {
          // 工具失败也是 trace 的一部分，所以先发 tool_error，让前端和持久化都能看到失败细节。
          // 随后抛 AppError，交给外层 message coordinator 把本次消息标记为 failed。
          await emit({
            type: "tool_error",
            iteration,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            durationMs: execution.durationMs,
            error: execution.error
          });

          if (!execution.error.recoverable) {
            await emit({ type: "agent_state", iteration, state: "failed", label: "工具执行失败" });
            throw new AppError(execution.error.code as AppErrorCode, execution.error.message, 500);
          }

          hasRecoverableToolError = true;
          // 可恢复失败不是消息的终点，而是一次“工具观察结果”。
          // 例如参数不合法、积分不足这类情况，LLM 需要知道失败原因，再把它整合成用户能理解的话。
          // UI 仍然依赖 tool_error 事件展示结构化操作，比如购买按钮；LLM 只负责自然语言解释。
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: execution.llmContent ?? JSON.stringify({
              ok: false,
              error: execution.error
            })
          });
          continue;
        }

        hasSuccessfulToolResult = true;
        await emit({
          type: "tool_result",
          iteration,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result: execution.data,
          durationMs: execution.durationMs
        });
        // 工具结果必须以 role=tool 写回 messages，再交给 LLM 继续推理。
        // 前端看到 tool_result 只是运行过程展示；最终自然语言答案仍由 LLM 基于工具结果整合生成。
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          name: toolCall.name,
          // role=tool 的 content 必须是字符串。简单工具可以继续用 JSON fallback；
          // 像 web_search 这种大结果工具，则优先用工具自己提供的 llmContent 控制 token 和可读性。
          content: execution.llmContent ?? JSON.stringify(execution.data)
        });
        shouldSummarizeMediaFailure ||= shouldSummarizeMediaFailureWithoutRetry(toolCall.name, execution.data);
      }

      const observationLabel =
        hasRecoverableToolError && hasSuccessfulToolResult
          ? "工具结果和错误已写回上下文"
          : hasRecoverableToolError
            ? "工具错误已写回上下文"
            : "工具结果已写回上下文";
      await emit({ type: "agent_state", iteration, state: "observing", label: observationLabel });

      if (shouldSummarizeMediaFailure) {
        // 媒体工具可能出现“部分成功”：前端已经能展示成功图片/视频，
        // 但用户还需要一句自然语言交代失败原因。这里禁止继续带工具调用，
        // 避免模型看到失败后又自动重试，导致成本和等待时间失控。
        return await this.summarizeMediaFailureWithoutTools(messages, input, iteration, emit);
      }

      await emit({ type: "iteration_end", iteration, outcome: "tool_calls" });
    }

    throw new AppError("AGENT_MAX_ITERATIONS", "Agent 达到最大迭代次数，仍未得到最终答案", 422);
  }

  private async summarizeMediaFailureWithoutTools(
    messages: AgentMessage[],
    input: AgentExecutionInput,
    iteration: number,
    emit: (event: AgentStreamEvent) => Promise<void>
  ): Promise<AgentExecutionResult> {
    const summaryMessages: AgentMessage[] = [
      ...messages,
      {
        role: "user",
        content: MEDIA_FAILURE_SUMMARY_INSTRUCTION
      }
    ];

    await emit({ type: "agent_state", iteration, state: "answering", label: "总结生成结果" });
    await emit({ type: "llm_start", iteration });
    const response =
      input.onEvent && this.options.provider.completeStream
        ? await this.options.provider.completeStream({ messages: summaryMessages, tools: [], signal: input.signal }, async (delta) => {
            await emit({ type: "answer_delta", iteration, delta });
          })
        : await this.options.provider.complete({ messages: summaryMessages, tools: [], signal: input.signal });
    await emit({
      type: "llm_response",
      iteration,
      content: response.content,
      toolCalls: response.toolCalls
    });

    if (!response.content) {
      await emit({ type: "agent_state", iteration, state: "failed", label: "模型响应无效" });
      throw new AppError("PROVIDER_BAD_RESPONSE", "模型响应缺少最终回答", 502);
    }

    await emit({ type: "iteration_end", iteration, outcome: "final_answer" });
    await emit({ type: "agent_state", iteration, state: "done", label: "运行完成" });
    await emit({ type: "final_answer", answer: response.content });
    return { answer: response.content };
  }
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function shouldSummarizeMediaFailureWithoutRetry(toolName: string, data: unknown): boolean {
  if (!MEDIA_SUMMARY_TOOL_NAMES.has(toolName) || !isRecord(data)) {
    return false;
  }

  const status = data.status;
  const failed = data.failed;

  return (status === "partial_failed" || status === "failed") && typeof failed === "number" && failed > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
