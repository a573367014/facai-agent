import { AppError } from "../errors/app-error.js";
import type { LlmProvider } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { SYSTEM_INSTRUCTIONS } from "./instructions.js";
import type { AgentErrorDetail, AgentMessage, AgentRunInput, AgentRunResult, AgentStep, AgentStreamEvent } from "./types.js";

export interface AgentServiceOptions {
  provider: LlmProvider;
  toolRegistry: ToolRegistry;
  defaultMaxIterations: number;
}

export class AgentService {
  constructor(private readonly options: AgentServiceOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const maxIterations = input.maxIterations ?? this.options.defaultMaxIterations;
    const messages: AgentMessage[] = [
      { role: "system", content: SYSTEM_INSTRUCTIONS },
      ...(input.history ?? []),
      { role: "user", content: input.input }
    ];
    const steps: AgentStep[] = [];
    const tools = this.options.toolRegistry.getDefinitions();
    const emit = async (event: AgentStreamEvent) => {
      await input.onEvent?.(event);
    };
    const toErrorDetail = (error: unknown): AgentErrorDetail => {
      if (error instanceof AppError) {
        return { code: error.code, message: error.message };
      }

      return {
        code: "TOOL_EXECUTION_ERROR",
        message: error instanceof Error ? error.message : "工具执行失败"
      };
    };

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      await emit({ type: "iteration_start", iteration });
      await emit({ type: "agent_state", iteration, state: "thinking", label: "模型思考中" });
      await emit({ type: "llm_start", iteration });
      const response =
        input.onEvent && this.options.provider.completeStream
          ? await this.options.provider.completeStream({ messages, tools }, async (delta) => {
              await emit({ type: "answer_delta", iteration, delta });
            })
          : await this.options.provider.complete({ messages, tools });
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
        await emit({ type: "final_answer", answer: response.content, steps });
        return { answer: response.content, steps };
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

      for (const toolCall of response.toolCalls) {
        await emit({ type: "agent_state", iteration, state: "calling_tool", label: `调用工具 ${toolCall.name}` });
        await emit({
          type: "tool_start",
          iteration,
          toolName: toolCall.name,
          arguments: toolCall.arguments
        });
        let result: unknown;

        try {
          result = await this.options.toolRegistry.execute(toolCall.name, toolCall.arguments);
        } catch (error) {
          await emit({
            type: "tool_error",
            iteration,
            toolName: toolCall.name,
            error: toErrorDetail(error)
          });
          await emit({ type: "agent_state", iteration, state: "failed", label: "工具执行失败" });
          throw error;
        }

        steps.push({
          type: "tool_call",
          toolName: toolCall.name,
          arguments: toolCall.arguments,
          result
        });
        await emit({
          type: "tool_result",
          iteration,
          toolName: toolCall.name,
          result
        });
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: JSON.stringify(result)
        });
      }

      await emit({ type: "agent_state", iteration, state: "observing", label: "工具结果已写回上下文" });
      await emit({ type: "iteration_end", iteration, outcome: "tool_calls" });
    }

    throw new AppError("AGENT_MAX_ITERATIONS", "Agent 达到最大迭代次数，仍未得到最终答案", 422);
  }
}
