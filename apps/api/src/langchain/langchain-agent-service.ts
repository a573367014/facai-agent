import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages";
import { END, StateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { ChatOpenAI } from "@langchain/openai";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import type {
  AgentExecutionInput,
  AgentExecutionResult,
  AgentMessage,
  AgentStreamEvent,
  JsonObject,
  ToolCall,
  ToolDefinition
} from "../agent/types.js";
import { SYSTEM_INSTRUCTIONS } from "../agent/instructions.js";
import { AppError, type AppErrorCode } from "../errors/app-error.js";
import {
  getAgentObservability,
  toObservationErrorCode,
  type AgentObservability,
  type AgentLlmCallObservation
} from "../observability/agent-observability.js";
import type { ToolExecutor } from "../tools/executor.js";
import { ToolAccessPolicy } from "../tools/access-policy.js";
import type { ToolRegistry } from "../tools/registry.js";
import { AgentState, type AgentStateType, type ToolNodeEvents } from "./governed-tool-node.js";
import { toBindingsTools } from "./tools-bridge.js";

const tracer = trace.getTracer("langchain-agent-service");

const MEDIA_SUMMARY_TOOL_NAMES = new Set(["generate_image", "edit_image", "generate_video"]);
const MEDIA_FAILURE_SUMMARY_INSTRUCTION = [
  "请基于上面的媒体生成工具结果给出最终回复。",
  "回复必须简短直接，最多 2 句；不要表格、不要标题、不要分点或长篇原因分析。",
  "只说明成功/失败数量和最关键失败原因；必要时用一句话提示调整提示词或稍后重试。",
  "不要再次调用工具，不要自动重试，不要输出图片链接、下载链接、任务 ID 或 base64 内容。"
].join("\n");

const MAX_ITERATIONS_REACHED_PROMPT = [
  "已达到工具调用次数上限，不能再调用工具。",
  "请根据已有信息和工具结果，直接给出最终回答。"
].join("\n");

function toLangChainMessage(message: AgentMessage): BaseMessage {
  switch (message.role) {
    case "system":
      return new SystemMessage({ content: message.content });
    case "user":
      return new HumanMessage({ content: message.content });
    case "assistant": {
      return new AIMessage({
        content: message.content ?? "",
        tool_calls: message.toolCalls?.map((tc) => ({ id: tc.id, name: tc.name, args: tc.arguments }))
      });
    }
    case "tool":
      return new ToolMessage({
        content: message.content,
        tool_call_id: message.toolCallId,
        name: message.name
      });
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          return String((block as { text: unknown }).text);
        }
        return "";
      })
      .join("");
  }
  return "";
}

function shouldSummarizeMediaFailure(toolName: string, data: unknown): boolean {
  if (!MEDIA_SUMMARY_TOOL_NAMES.has(toolName) || typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return (
    (record.status === "partial_failed" || record.status === "failed") &&
    typeof record.failed === "number" &&
    record.failed > 0
  );
}

export interface LangChainAgentServiceOptions {
  model: ChatOpenAI;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  toolAccessPolicy?: ToolAccessPolicy;
  defaultMaxIterations: number;
  observability?: AgentObservability;
}

export class LangChainAgentService {
  private readonly toolAccessPolicy: ToolAccessPolicy;
  private readonly observability: AgentObservability;

  constructor(private readonly options: LangChainAgentServiceOptions) {
    this.toolAccessPolicy = options.toolAccessPolicy ?? ToolAccessPolicy.allowAll();
    this.observability = options.observability ?? getAgentObservability();
  }

  async run(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    const span = tracer.startSpan("agent.run");
    span.setAttributes({
      "agent.session_id": input.sessionId ?? "",
      "agent.message_id": input.messageId ?? "",
      "agent.max_iterations": input.maxIterations ?? this.options.defaultMaxIterations
    });

    try {
      const result = await this.executeGraph(input, span);
      span.setAttribute("agent.outcome", "completed");
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  }

  private async executeGraph(input: AgentExecutionInput, parentSpan: Span): Promise<AgentExecutionResult> {
    parentSpan.setAttribute("agent.graph", "langgraph");
    const self = this;
    const maxIterations = input.maxIterations ?? this.options.defaultMaxIterations;
    const replayToolCalls = input.replayToolCalls?.length ? input.replayToolCalls : undefined;
    const toolDefinitions = this.toolAccessPolicy.filterDefinitions(
      this.options.toolRegistry.getDefinitions()
    );

    const emit = async (event: AgentStreamEvent) => {
      await input.onEvent?.(event);
    };

    const boundModel = this.options.model.bindTools(toBindingsTools(toolDefinitions));
    const summaryModel = this.options.model;

    let currentIteration = 0;

    async function callModel(state: AgentStateType, config: RunnableConfig): Promise<Partial<AgentStateType>> {
      return tracer.startActiveSpan("agent.call_model", async (iterSpan) => {
        iterSpan.setAttribute("agent.iteration", currentIteration);
        try {
          const result = await callModelInner(state, config);
          return result;
        } finally {
          iterSpan.end();
        }
      });
    }

    async function callModelInner(state: AgentStateType, config: RunnableConfig): Promise<Partial<AgentStateType>> {
      const signal = config.signal as AbortSignal | undefined;
      assertNotAborted(signal);

      const iteration = currentIteration;
      const isFinalIteration = iteration >= maxIterations - 1;

      await emit({ type: "iteration_start", iteration });
      await emit({
        type: "agent_state",
        iteration,
        state: "thinking",
        label: isFinalIteration ? "生成最终答案" : "模型思考中"
      });
      await emit({ type: "llm_start", iteration });

      let aiMessage: AIMessage;

      if (iteration === 0 && replayToolCalls) {
        aiMessage = new AIMessage({
          content: "",
          tool_calls: replayToolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.arguments }))
        });
      } else {
        const activeModel = isFinalIteration ? self.options.model : boundModel;
        const messages = isFinalIteration
          ? [...state.messages, new SystemMessage({ content: MAX_ITERATIONS_REACHED_PROMPT })]
          : state.messages;
        const contentParts: string[] = [];
        const toolCallMap = new Map<number, { id?: string; name?: string; args: string }>();

        await self.observeLlmCall(input, iteration, isFinalIteration ? "final" : "tool_bound", async () => {
          const stream = await activeModel.stream(messages, { signal });

          for await (const chunk of stream) {
            const text = extractTextContent(chunk.content);
            if (text) {
              contentParts.push(text);
              await emit({ type: "answer_delta", iteration, delta: text });
            }

            const rawChunks = (chunk as { tool_call_chunks?: Array<{ index?: number; id?: string; name?: string; args?: string }> }).tool_call_chunks;
            for (const tcChunk of rawChunks ?? []) {
              const idx = tcChunk.index ?? 0;
              const existing = toolCallMap.get(idx) ?? { id: undefined, name: undefined, args: "" };
              if (tcChunk.id) existing.id = tcChunk.id;
              if (tcChunk.name) existing.name = tcChunk.name;
              existing.args += tcChunk.args ?? "";
              toolCallMap.set(idx, existing);
            }
          }
        });

        const content = contentParts.join("") || undefined;
        const toolCalls = [...toolCallMap.values()].map((tc) => {
          let args: Record<string, unknown> = {};
          if (tc.args) {
            try { args = JSON.parse(tc.args) as Record<string, unknown>; } catch { args = {}; }
          }
          return { id: tc.id ?? "", name: tc.name ?? "", args };
        }).filter((tc) => tc.name);

        aiMessage = new AIMessage({
          content: content ?? "",
          tool_calls: toolCalls.length ? toolCalls : undefined
        });
      }

      const responseContent = extractTextContent(aiMessage.content) || undefined;
      const responseToolCalls = (aiMessage.tool_calls ?? []).map((tc) => ({
        id: tc.id ?? "",
        name: tc.name ?? "",
        arguments: (tc.args ?? {}) as Record<string, unknown>
      }));

      await emit({
        type: "llm_response",
        iteration,
        content: responseContent,
        toolCalls: responseToolCalls.length ? responseToolCalls : undefined
      });

      if (!responseToolCalls.length) {
        if (!responseContent) {
          await emit({ type: "agent_state", iteration, state: "failed", label: "模型响应无效" });
          throw new AppError("PROVIDER_BAD_RESPONSE", "模型响应缺少最终回答或工具调用", 502);
        }

        await emit({ type: "agent_state", iteration, state: "answering", label: "生成最终答案" });
        await emit({ type: "iteration_end", iteration, outcome: "final_answer" });
        await emit({ type: "agent_state", iteration, state: "done", label: "运行完成" });
        await emit({ type: "final_answer", answer: responseContent });
        return { messages: [aiMessage], iteration: iteration + 1 };
      }

      for (const toolCall of responseToolCalls) {
        await emit({
          type: "tool_call_ready",
          iteration,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          arguments: toolCall.arguments
        });
      }

      return { messages: [aiMessage], iteration: iteration + 1 };
    }

    const toolEvents: ToolNodeEvents = {
      onToolStart: async (toolCallId, toolName, args) => {
        const iteration = currentIteration;
        await emit({ type: "agent_state", iteration, state: "calling_tool", label: `调用工具 ${toolName}` });
        await emit({ type: "tool_start", iteration, toolCallId, toolName, arguments: args });
      },
      onToolProgress: async (toolCallId, toolName, progress) => {
        await emit({ type: "tool_progress", iteration: currentIteration, toolCallId, toolName, progress });
      },
      onToolResult: async (toolCallId, toolName, data, durationMs) => {
        await emit({
          type: "tool_result",
          iteration: currentIteration,
          toolCallId,
          toolName,
          result: data,
          durationMs
        });
      },
      onToolError: async (toolCallId, toolName, error, durationMs) => {
        await emit({ type: "tool_error", iteration: currentIteration, toolCallId, toolName, durationMs, error });
      }
    };

    async function governedTools(state: AgentStateType, config: RunnableConfig): Promise<Partial<AgentStateType>> {
      const signal = config.signal as AbortSignal | undefined;
      const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
      const toolCalls = (lastMessage?.tool_calls ?? []) as unknown as Array<{
        id: string;
        name: string;
        args: JsonObject;
      }>;
      const toolMessages: ToolMessage[] = [];
      let hasRecoverableError = false;
      let hasSuccess = false;
      let shouldSummarizeMedia = false;

      for (const toolCall of toolCalls) {
        await toolEvents.onToolStart(toolCall.id, toolCall.name, toolCall.args);

        const execution = await self.options.toolExecutor.execute({
          messageId: input.messageId,
          sessionId: input.sessionId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          arguments: toolCall.args,
          signal,
          emitProgress: async (progress) => {
            await toolEvents.onToolProgress(toolCall.id, toolCall.name, progress);
          }
        });

        if (!execution.ok) {
          await toolEvents.onToolError(toolCall.id, toolCall.name, execution.error, execution.durationMs);

          if (!execution.error.recoverable) {
            await emit({ type: "agent_state", iteration: currentIteration, state: "failed", label: "工具执行失败" });
            throw new AppError(execution.error.code as AppErrorCode, execution.error.message, 500);
          }

          hasRecoverableError = true;
          toolMessages.push(
            new ToolMessage({
              content: execution.llmContent ?? JSON.stringify({ ok: false, error: execution.error }),
              tool_call_id: toolCall.id,
              name: toolCall.name
            })
          );
          continue;
        }

        hasSuccess = true;
        await toolEvents.onToolResult(toolCall.id, toolCall.name, execution.data, execution.durationMs, execution.llmContent);
        shouldSummarizeMedia ||= shouldSummarizeMediaFailure(toolCall.name, execution.data);

        toolMessages.push(
          new ToolMessage({
            content: execution.llmContent ?? JSON.stringify(execution.data),
            tool_call_id: toolCall.id,
            name: toolCall.name
          })
        );
      }

      const observationLabel =
        hasRecoverableError && hasSuccess
          ? "工具结果和错误已写回上下文"
          : hasRecoverableError
            ? "工具错误已写回上下文"
            : "工具结果已写回上下文";
      await emit({ type: "agent_state", iteration: currentIteration, state: "observing", label: observationLabel });

      if (shouldSummarizeMedia) {
        await emit({ type: "iteration_end", iteration: currentIteration, outcome: "tool_calls" });
        return { messages: toolMessages, needsMediaSummary: true };
      }

      await emit({ type: "iteration_end", iteration: currentIteration, outcome: "tool_calls" });
      currentIteration += 1;
      return { messages: toolMessages, needsMediaSummary: false };
    }

    function shouldContinue(state: AgentStateType): "tools" | typeof END {
      if (state.iteration >= maxIterations) {
        return END;
      }
      const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
      const toolCalls = lastMessage?.tool_calls ?? [];
      if (toolCalls.length === 0) return END;
      return "tools";
    }

    async function summarizeMedia(state: AgentStateType, config: RunnableConfig): Promise<Partial<AgentStateType>> {
      const signal = config.signal as AbortSignal | undefined;
      const messagesWithInstruction = [
        ...state.messages,
        new HumanMessage({ content: MEDIA_FAILURE_SUMMARY_INSTRUCTION })
      ];
      const iteration = currentIteration;
      await emit({ type: "iteration_start", iteration });
      await emit({ type: "agent_state", iteration, state: "thinking", label: "生成媒体总结" });
      await emit({ type: "llm_start", iteration });

      const contentParts: string[] = [];

      await self.observeLlmCall(input, iteration, "summary", async () => {
        const stream = await summaryModel.stream(messagesWithInstruction, { signal });

        for await (const chunk of stream) {
          const text = extractTextContent(chunk.content);
          if (text) {
            contentParts.push(text);
            await emit({ type: "answer_delta", iteration, delta: text });
          }
        }
      });

      const content = contentParts.join("") || "";
      await emit({ type: "llm_response", iteration, content });
      await emit({ type: "agent_state", iteration, state: "answering", label: "生成最终答案" });
      await emit({ type: "iteration_end", iteration, outcome: "final_answer" });
      await emit({ type: "agent_state", iteration, state: "done", label: "运行完成" });
      await emit({ type: "final_answer", answer: content });

      return { messages: [new AIMessage({ content })], iteration: iteration + 1 };
    }

    const graph = new StateGraph(AgentState)
      .addNode("agent", callModel)
      .addNode("tools", governedTools)
      .addNode("summarize_media", summarizeMedia)
      .addEdge("__start__", "agent")
      .addConditionalEdges("agent", shouldContinue, {
        tools: "tools",
        [END]: END
      })
      .addConditionalEdges("tools", (state: AgentStateType) => {
        return state.needsMediaSummary ? "summarize_media" : "agent";
      }, {
        agent: "agent",
        summarize_media: "summarize_media"
      })
      .addEdge("summarize_media", END)
      .compile();

    const messages: BaseMessage[] = [
      new SystemMessage({ content: SYSTEM_INSTRUCTIONS }),
      ...(input.history ?? []).map(toLangChainMessage),
      new HumanMessage({ content: input.input })
    ];

    const result = await graph.invoke(
      { messages, iteration: 0 },
      {
        signal: input.signal,
        recursionLimit: maxIterations * 2 + 4,
        configurable: {
          messageId: input.messageId,
          sessionId: input.sessionId
        }
      }
    );

    const lastMessage = result.messages[result.messages.length - 1] as BaseMessage;
    const answer = extractTextContent(lastMessage.content);

    if (!answer) {
      throw new AppError("AGENT_MAX_ITERATIONS", "Agent 达到最大迭代次数，仍未得到最终答案", 422);
    }

    return { answer };
  }

  private async observeLlmCall<T>(
    input: AgentExecutionInput,
    iteration: number,
    mode: AgentLlmCallObservation["mode"],
    operation: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    let status: AgentLlmCallObservation["status"] = "succeeded";
    let errorCode: string | undefined;

    try {
      return await operation();
    } catch (error) {
      status = "failed";
      errorCode = toObservationErrorCode(error, "PROVIDER_ERROR");
      throw error;
    } finally {
      this.observability.recordLlmCall({
        sessionId: input.sessionId,
        messageId: input.messageId,
        iteration,
        provider: "openai-compatible",
        model: this.getModelName(),
        mode,
        status,
        durationMs: Math.max(0, Date.now() - startedAt),
        errorCode
      });
    }
  }

  private getModelName(): string {
    const model = this.options.model as {
      model?: unknown;
      modelName?: unknown;
      lc_kwargs?: { model?: unknown; modelName?: unknown };
    };
    const candidate = model.model ?? model.modelName ?? model.lc_kwargs?.model ?? model.lc_kwargs?.modelName;
    return typeof candidate === "string" && candidate.trim() ? candidate : "unknown";
  }
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
