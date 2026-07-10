/**
 * 供应商适配层：把 LangChain 的 ChatOpenAI 统一到 LlmProvider 接口。
 *
 * 本文件是"LLM 供应商无关化"的关键适配层。Agent 执行引擎只依赖
 * LlmProvider 抽象接口（见 providers/types.ts），不直接耦合 LangChain
 * 的 ChatOpenAI 类型。这样做的好处是：未来要接入 Anthropic、Gemini 等
 * 其他供应商时，只需再写一个实现 LlmProvider 的 shim，Agent 引擎本身
 * 不用改。
 *
 * 核心职责：
 * 1. 把内部 AgentMessage 翻译成 LangChain 的 BaseMessage 体系；
 * 2. 把内部 ToolDefinition 翻译成 OpenAI-compatible 的 tools payload；
 * 3. 把 LangChain 返回的 AIMessage（含 tool_calls）翻译回 LlmProviderResponse；
 * 4. 处理流式响应中"工具调用分片跨 chunk 累积"的复杂逻辑。
 *
 * 边界说明：本文件不做权限治理、不做迭代控制、不做事件溯源——
 * 它只负责"协议翻译"，是纯无状态的适配器。
 */
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import type { ToolDefinition } from "../types.js";
import type { AgentMessage } from "../types.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { LlmDeltaHandler, LlmProvider, LlmProviderRequest, LlmProviderResponse } from "../providers/types.js";

/**
 * 把内部 AgentMessage 翻译成 LangChain 的 BaseMessage。
 *
 * 四种角色一一映射：system→SystemMessage、user→HumanMessage、
 * assistant→AIMessage（可携带 tool_calls）、tool→ToolMessage。
 *
 * 为什么需要这层翻译：LangChain 内部只认自己的消息类型，而 Agent 引擎
 * 全程用 AgentMessage（更精简、不依赖第三方库）。如果不做这层翻译，
 * Agent 的类型定义会被 LangChain 绑死，失去供应商无关性。
 */
function toLangChainMessage(message: AgentMessage): BaseMessage {
  switch (message.role) {
    case "system":
      return new SystemMessage({ content: message.content });

    case "user":
      return new HumanMessage({ content: message.content });

    case "assistant": {
      const toolCalls = message.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.arguments
      }));

      return new AIMessage({
        content: message.content ?? "",
        tool_calls: toolCalls
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
 * LangChain 的 content 可能是 string，也可能是多模态块数组
 * （如 [{ type: "text", text: "..." }, { type: "image_url", ... }]）。
 * 这里只抽取文本部分拼接成字符串，非文本块（图片等）被丢弃。
 *
 * 为什么不直接用 content：因为多模态场景下 content 不是 string，
 * 直接当字符串用会导致 LLM 回复内容丢失或类型错误。
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
 * 把内部 ToolDefinition 转成 OpenAI-compatible 的 tools payload 格式。
 *
 * OpenAI tools API 要求 { type: "function", function: { name, description, parameters } }
 * 这种嵌套结构，而内部 ToolDefinition 是扁平的。这里做结构适配。
 */
function toBindingsTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

/**
 * 从 AIMessage 中提取工具调用列表，转成内部 ToolCall 格式。
 *
 * LangChain 用 tool_calls（带下划线，OpenAI 原始字段名），内部用 toolCalls（驼峰）。
 * 字段名和 args→arguments 的映射都在这里完成。
 */
function extractToolCalls(aiMessage: AIMessage): LlmProviderResponse["toolCalls"] {
  const rawToolCalls = aiMessage.tool_calls;

  if (!rawToolCalls || rawToolCalls.length === 0) {
    return undefined;
  }

  return rawToolCalls.map((toolCall) => ({
    id: toolCall.id ?? "",
    name: toolCall.name ?? "",
    arguments: (toolCall.args ?? {}) as Record<string, unknown>
  }));
}

/**
 * 把 LangChain 的 AIMessage 翻译回内部 LlmProviderResponse。
 *
 * 关键校验：如果既没有文本内容也没有工具调用，说明模型返回了无效响应，
 * 直接抛 PROVIDER_BAD_RESPONSE（502），而不是返回空对象让上层困惑。
 * 这么做是为了 fail-fast——无效响应越早暴露，越容易定位问题。
 */
function toProviderResponse(aiMessage: AIMessage): LlmProviderResponse {
  const content = extractTextContent(aiMessage.content) || undefined;
  const toolCalls = extractToolCalls(aiMessage);

  if (!content && !toolCalls?.length) {
    throw new AppError("PROVIDER_BAD_RESPONSE", "模型响应缺少最终回答或工具调用", 502);
  }

  return { content, toolCalls };
}

export interface LangChainProviderOptions {
  model: ChatOpenAI;
}

/**
 * LangChain 供应商适配器，实现 LlmProvider 接口。
 *
 * 它把一个已创建好的 ChatOpenAI 实例包装成统一的 complete/completeStream
 * 两个方法。Agent 引擎只调这两个方法，不需要知道底层是 LangChain 还是
 * 别的 SDK。
 */
export class LangChainProviderShim implements LlmProvider {
  constructor(private readonly options: LangChainProviderOptions) {}

  /**
   * 非流式补全：一次性调用模型并返回完整响应。
   *
   * 当有工具时，先 bindTools 把工具绑定到模型上再 invoke；
   * 没有工具时直接用裸模型，避免给模型发送空的 tools 数组导致行为异常。
   */
  async complete(request: LlmProviderRequest): Promise<LlmProviderResponse> {
    const messages = request.messages.map(toLangChainMessage);
    const model = request.tools.length
      ? this.options.model.bindTools(toBindingsTools(request.tools))
      : this.options.model;

    const result = await model.invoke(messages, { signal: request.signal });

    if (!(result instanceof AIMessage)) {
      throw new AppError("PROVIDER_BAD_RESPONSE", "模型返回了非 AIMessage", 502);
    }

    return toProviderResponse(result);
  }

  /**
   * 流式补全：边接收 token 边通过 onDelta 回调推给上层，最终汇总成完整响应。
   *
   * 这是整个适配层最复杂的方法，难点在于"工具调用分片累积"：
   * 流式响应里，一次工具调用会被拆成多个 chunk，每个 chunk 只带部分信息
   * （第一个 chunk 带 id 和 name，后续 chunk 只带 args 片段）。
   * 必须用 toolCallMap 按 index 累积拼接，最后统一 JSON.parse 才能得到
   * 完整的工具调用参数。如果不做累积，直接用最后一个 chunk 的 args，
   * 会得到截断的 JSON，导致工具调用失败。
   *
   * 同样做了 fail-fast 校验：流结束后如果既无文本也无工具调用，抛 502。
   */
  async completeStream(request: LlmProviderRequest, onDelta: LlmDeltaHandler): Promise<LlmProviderResponse> {
    const messages = request.messages.map(toLangChainMessage);
    const model = request.tools.length
      ? this.options.model.bindTools(toBindingsTools(request.tools))
      : this.options.model;

    const contentParts: string[] = [];
    const toolCallMap = new Map<number, { id?: string; name?: string; args: string }>();

    const stream = await model.stream(messages, { signal: request.signal });

    for await (const chunk of stream) {
      const text = extractTextContent(chunk.content);
      if (text) {
        contentParts.push(text);
        await onDelta(text);
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

    const parsedToolCalls = [...toolCallMap.values()].map((tc) => {
      let args: Record<string, unknown> = {};
      if (tc.args) {
        try { args = JSON.parse(tc.args) as Record<string, unknown>; } catch { args = {}; }
      }
      return { id: tc.id ?? "", name: tc.name ?? "", arguments: args };
    }).filter((tc) => tc.name);

    const content = contentParts.join("") || undefined;
    const toolCalls = parsedToolCalls.length ? parsedToolCalls : undefined;

    if (!content && !toolCalls?.length) {
      throw new AppError("PROVIDER_BAD_RESPONSE", "模型流式响应缺少最终回答或工具调用", 502);
    }

    return { content, toolCalls };
  }
}
