import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import type { ToolDefinition } from "../agent/types.js";
import type { AgentMessage } from "../agent/types.js";
import { AppError } from "../errors/app-error.js";
import type { LlmDeltaHandler, LlmProvider, LlmProviderRequest, LlmProviderResponse } from "../providers/types.js";

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

export class LangChainProviderShim implements LlmProvider {
  constructor(private readonly options: LangChainProviderOptions) {}

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
