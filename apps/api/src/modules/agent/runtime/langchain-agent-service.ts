/**
 * LangChain Agent 服务：核心 Agent 执行引擎。
 *
 * 本文件是整个 Agent 系统的"大脑"，负责编排"模型思考 → 工具执行 → 结果回灌 →
 * 再思考"的循环（即 ReAct 模式）。它基于 LangGraph 构建一个状态图（StateGraph），
 * 图中有三个节点：
 * - agent（callModel）：调用 LLM，拿到模型回复（可能是文字，也可能是工具调用）；
 * - tools（governedTools）：执行模型选中的工具，把结果写回消息列表；
 * - summarize_resource：当资源生成类工具部分失败时，专门让模型生成一段简短总结。
 *
 * 图的流转逻辑：
 *   __start__ → agent → (有工具调用?) → tools → (需要资源总结?) → summarize_resource → END
 *                        ↓ (无工具调用)                                    ↓ (不需要)
 *                       END                                              agent → ...
 *
 * 核心设计决策：
 * 1. 用 LangGraph 而非手写 while 循环——图引擎自带状态管理、条件路由、
 *    recursionLimit 防爆，比手写循环更健壮；
 * 2. 流式输出贯穿全程——模型 token、工具进度都通过 onEvent 实时推给前端；
 * 3. 迭代上限 + 最终轮强制收口——防止模型陷入"无限调工具"死循环；
 * 4. 可观测性内建——每次 LLM 调用都通过 OpenTelemetry trace 和 observability 记录。
 *
 * 边界说明：本文件不负责消息持久化、不负责 HTTP 传输、不负责权限认证——
 * 那些由上层 coordinator 和 routes 负责。它只接收 AgentExecutionInput，
 * 执行推理循环，返回 AgentExecutionResult（最终答案）。
 */
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
} from "../types.js";
import { SYSTEM_INSTRUCTIONS } from "../instructions.js";
import { AppError, type AppErrorCode } from "../../../shared/errors/app-error.js";
import {
  getAgentObservability,
  toObservationErrorCode,
  type AgentObservability,
  type AgentLlmCallObservation
} from "../../../platform/observability/agent-observability.js";
import type { ToolExecutor } from "../../tools/executor.js";
import { ToolAccessPolicy } from "../../tools/access-policy.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { AgentState, type AgentStateType, type ToolNodeEvents } from "./governed-tool-node.js";
import { toBindingsTools } from "./tools-bridge.js";

const tracer = trace.getTracer("langchain-agent-service");

/**
 * 需要触发"资源失败总结"的工具名集合。
 *
 * 这些工具的共同特点：生成图片/视频/文档等"资源"，可能部分成功部分失败。
 * 当它们部分失败时，直接把原始结果丢回模型，模型容易输出冗长的失败分析
 * 或尝试自动重试，体验不好。所以专门走 summarize_resource 节点，让模型
 * 生成一段简短的总结。
 */
const RESOURCE_SUMMARY_TOOL_NAMES = new Set(["generate_image", "edit_image", "generate_video", "generate_document"]);

/**
 * 资源失败总结的系统指令。
 *
 * 刻意限制输出格式（最多 2 句、不要表格/标题/分点），是因为这段总结
 * 是给终端用户看的，冗长的技术分析反而不如一句"3 张成功 2 张失败，
 * 建议调整提示词重试"来得有用。同时禁止再次调工具和输出 base64，
 * 防止模型在总结阶段又触发新的工具循环。
 */
const RESOURCE_FAILURE_SUMMARY_INSTRUCTION = [
  "请基于上面的资源生成工具结果给出最终回复。",
  "回复必须简短直接，最多 2 句；不要表格、不要标题、不要分点或长篇原因分析。",
  "只说明成功/失败数量和最关键失败原因；必要时用一句话提示调整提示词或稍后重试。",
  "不要再次调用工具，不要自动重试，不要输出资源链接、下载链接、任务 ID 或 base64 内容。"
].join("\n");

/**
 * 达到迭代上限时注入的收口指令。
 *
 * 当模型已经用完所有工具调用机会还在试图调工具时，这条指令会被追加到
 * 消息末尾，强制模型"放弃调工具，用已有信息直接回答"。
 * 不这么做的话，模型可能在最后一轮仍然只输出 tool_calls 而没有文字答案，
 * 导致用户拿不到任何回复。
 */
const MAX_ITERATIONS_REACHED_PROMPT = [
  "已达到工具调用次数上限，不能再调用工具。",
  "请根据已有信息和工具结果，直接给出最终回答。"
].join("\n");

/**
 * 把内部 AgentMessage 翻译成 LangChain 的 BaseMessage。
 *
 * 与 provider-shim.ts 中的 toLangChainMessage 逻辑相同，这里保留一份
 * 是因为 AgentService 直接操作 LangGraph 状态（需要 BaseMessage），
 * 而 provider-shim 是另一条独立路径。两处保持一致即可。
 */
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

/**
 * 从 LangChain 消息内容中提取纯文本。
 *
 * 模型流式返回的 chunk.content 可能是 string 或多模态块数组，
 * 这里统一拍平成纯文本字符串，用于拼接最终答案和推送 answer_delta 事件。
 */
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

/**
 * 判断某个资源生成工具的结果是否需要触发"失败总结"。
 *
 * 只有同时满足三个条件才返回 true：
 * 1. 工具名在 RESOURCE_SUMMARY_TOOL_NAMES 里（是资源生成类工具）；
 * 2. 结果是对象（不是数组/null），能取到 status 字段；
 * 3. status 是 partial_failed 或 failed，且 failed 数量 > 0。
 *
 * 这么严格是因为：全成功的不需要总结，全失败的会走错误分支直接抛异常，
 * 只有"部分失败"这种中间态才需要让模型生成一段简短总结给用户。
 */
function shouldSummarizeResourceFailure(toolName: string, data: unknown): boolean {
  if (!RESOURCE_SUMMARY_TOOL_NAMES.has(toolName) || typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return (
    (record.status === "partial_failed" || record.status === "failed") &&
    typeof record.failed === "number" &&
    record.failed > 0
  );
}

/**
 * Agent 服务的构造配置。
 *
 * - model：已创建好的 ChatOpenAI 实例（由 model-factory 产出）；
 * - toolRegistry/toolExecutor：工具的"注册"和"执行"两个关注点分开注入；
 * - toolAccessPolicy：可选的权限策略，缺省时 allowAll（全部放行）；
 * - defaultMaxIterations：默认最大工具调用轮数，防止无限循环；
 * - observability：可选的可观测性记录器，缺省时用全局默认实现。
 */
export interface LangChainAgentServiceOptions {
  model: ChatOpenAI;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  toolAccessPolicy?: ToolAccessPolicy;
  defaultMaxIterations: number;
  observability?: AgentObservability;
}

/**
 * LangChain Agent 执行引擎。
 *
 * 核心入口是 run() 方法：接收 AgentExecutionInput，构建 LangGraph 状态图，
 * 执行"模型思考 → 工具执行 → 回灌结果 → 再思考"的循环，最终返回答案。
 * 全程通过 onEvent 回调流式推送过程事件（token、工具进度等）。
 */
export class LangChainAgentService {
  private readonly toolAccessPolicy: ToolAccessPolicy;
  private readonly observability: AgentObservability;

  constructor(private readonly options: LangChainAgentServiceOptions) {
    this.toolAccessPolicy = options.toolAccessPolicy ?? ToolAccessPolicy.allowAll();
    this.observability = options.observability ?? getAgentObservability();
  }

  /**
   * Agent 执行入口：启动一次完整的推理循环。
   *
   * 用 OpenTelemetry span 包裹整个执行过程，记录 session/message 关联信息
   * 和最终结果状态。异常会被记录到 span 后重新抛出，保证可观测性不吞错。
   */
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

  /**
   * 构建 LangGraph 状态图并执行推理循环。
   *
   * 这是整个 Agent 的核心编排逻辑。方法内部定义了三个图节点函数
   *（callModel / governedTools / summarizeResource），然后用 StateGraph
   * 把它们连成一张有向图，最后 invoke 执行。
   *
   * 为什么节点函数定义在方法内部而非类方法：因为它们需要闭包捕获
   * input、emit、currentIteration 等运行时上下文，而每次 run 的这些
   * 上下文都不同。定义在内部可以自然闭包，不需要额外的参数传递。
   */
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

    /**
     * 图节点：调用 LLM（带 OpenTelemetry span 包裹）。
     *
     * 这层只是给 callModelInner 加了 trace span，记录当前迭代轮数，
     * 真正的逻辑在 callModelInner 里。拆开是为了让可观测性代码不干扰
     * 业务逻辑的可读性。
     */
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

    /**
     * 图节点核心逻辑：调用 LLM 并处理响应。
     *
     * 关键分支：
     * 1. 重放模式（iteration===0 且有 replayToolCalls）：跳过 LLM 调用，
     *    直接构造一个带 tool_calls 的 AIMessage。用于调试/复现历史运行，
     *    避免真实再调一次模型（省 token、保证可复现）。
     * 2. 最终轮（isFinalIteration）：切换到不带工具的裸模型，并追加
     *    MAX_ITERATIONS_REACHED_PROMPT，强制模型输出文字答案而非工具调用。
     * 3. 正常轮：用绑定了工具的 boundModel 流式调用，边收 token 边推
     *    answer_delta 事件，同时累积工具调用分片。
     *
     * 响应处理：如果模型没有工具调用，说明该输出最终答案了——校验有内容
     * 后发 final_answer 事件并结束；如果有工具调用，发 tool_call_ready
     * 事件，把 AIMessage 写回状态，等图引擎路由到 tools 节点。
     */
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

    /**
     * 图节点：受治理的工具执行。
     *
     * 从上一条 AIMessage 中取出模型发起的 tool_calls，逐个执行，
     * 把结果以 ToolMessage 形式写回消息列表。
     *
     * 治理逻辑（这是"governed"的核心）：
     * 1. 每个工具调用前后都通过 toolEvents 上报事件，前端能实时看到进度；
     * 2. 工具失败时区分"可恢复"和"不可恢复"：
     *    - 不可恢复（如权限拒绝、系统级错误）：直接抛异常终止整个 Agent；
     *    - 可恢复（如单个图片生成失败）：把错误信息作为 ToolMessage 写回，
     *      让模型在下一轮看到失败原因并决定怎么处理（通常是总结或换方案）。
     * 3. 资源类工具部分失败时，设置 needsResourceSummary=true，
     *    让图引擎路由到 summarize_resource 节点而非回到 agent 节点。
     *
     * 注意：currentIteration 只在这里自增（不在 callModel 里），
     * 因为一轮迭代 = 一次模型调用 + 一次工具执行，工具执行完才算一轮结束。
     */
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
      let shouldSummarizeResource = false;

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
        shouldSummarizeResource ||= shouldSummarizeResourceFailure(toolCall.name, execution.data);

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

      if (shouldSummarizeResource) {
        await emit({ type: "iteration_end", iteration: currentIteration, outcome: "tool_calls" });
        return { messages: toolMessages, needsResourceSummary: true };
      }

      await emit({ type: "iteration_end", iteration: currentIteration, outcome: "tool_calls" });
      currentIteration += 1;
      return { messages: toolMessages, needsResourceSummary: false };
    }

    /**
     * 条件路由：agent 节点执行完后，决定下一步去哪。
     *
     * 三种情况：
     * - 迭代已达上限 → END（防止无限循环）；
     * - 模型没有工具调用 → END（说明已经给出最终答案）；
     * - 有工具调用 → "tools"（去执行工具）。
     *
     * 这是 LangGraph 的 addConditionalEdges 用的路由函数，返回值对应
     * 条件边映射表里的 key。
     */
    function shouldContinue(state: AgentStateType): "tools" | typeof END {
      if (state.iteration >= maxIterations) {
        return END;
      }
      const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
      const toolCalls = lastMessage?.tool_calls ?? [];
      if (toolCalls.length === 0) return END;
      return "tools";
    }

    /**
     * 图节点：资源失败总结。
     *
     * 当资源生成类工具部分失败时，不走正常的 agent 回合，而是专门
     * 让模型生成一段简短总结。这里用裸模型（summaryModel，不绑工具），
     * 并追加 RESOURCE_FAILURE_SUMMARY_INSTRUCTION 指令，确保模型只输出
     * 简短文字总结，不会再触发工具调用。
     *
     * 为什么不直接回到 agent 节点：因为回到 agent 会带上工具绑定，
     * 模型可能又去调工具或输出冗长分析，而这里需要的是"收口"——
     * 用最简短的话告诉用户结果，然后结束。
     */
    async function summarizeResource(state: AgentStateType, config: RunnableConfig): Promise<Partial<AgentStateType>> {
      const signal = config.signal as AbortSignal | undefined;
      const messagesWithInstruction = [
        ...state.messages,
        new HumanMessage({ content: RESOURCE_FAILURE_SUMMARY_INSTRUCTION })
      ];
      const iteration = currentIteration;
      await emit({ type: "iteration_start", iteration });
      await emit({ type: "agent_state", iteration, state: "thinking", label: "生成资源总结" });
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

    /**
     * 构建 LangGraph 状态图。
     *
     * 图结构：
     *   __start__ → agent
     *   agent → (shouldContinue) → tools | END
     *   tools → (needsResourceSummary?) → summarize_resource | agent
     *   summarize_resource → END
     *
     * tools 节点后的条件边是关键：如果本轮有资源工具部分失败，
     * 走 summarize_resource 收口；否则回到 agent 继续下一轮推理。
     */
    const graph = new StateGraph(AgentState)
      .addNode("agent", callModel)
      .addNode("tools", governedTools)
      .addNode("summarize_resource", summarizeResource)
      .addEdge("__start__", "agent")
      .addConditionalEdges("agent", shouldContinue, {
        tools: "tools",
        [END]: END
      })
      .addConditionalEdges("tools", (state: AgentStateType) => {
        return state.needsResourceSummary ? "summarize_resource" : "agent";
      }, {
        agent: "agent",
        summarize_resource: "summarize_resource"
      })
      .addEdge("summarize_resource", END)
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

  /**
   * 包裹一次 LLM 调用，记录可观测性指标。
   *
   * 无论 LLM 调用成功还是失败，都会在 finally 里记录这次调用的
   * session/message 关联、迭代轮数、模式（tool_bound/final/summary）、
   * 状态（succeeded/failed）、耗时和错误码。
   *
   * 用 finally 而非 try-catch-then-record：确保即使 operation 抛异常，
   * 指标也不会丢失。异常会被重新抛出，不影响上层错误处理。
   */
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

  /**
   * 从 ChatOpenAI 实例上尽力提取模型名称。
   *
   * LangChain 的 ChatOpenAI 可能把模型名存在 model、modelName 或
   * lc_kwargs.model 等多个位置（不同版本字段名不一致），这里逐一尝试。
   * 提取不到就返回 "unknown"，保证可观测性记录不会因为取不到名字而报错。
   */
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

/**
 * 检查取消信号是否已触发，是则抛 AbortError。
 *
 * 在每个图节点入口处调用，确保用户取消后能尽快中断执行，
 * 而不是继续跑完一轮 LLM 调用再发现被取消了（浪费 token 和时间）。
 */
function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
