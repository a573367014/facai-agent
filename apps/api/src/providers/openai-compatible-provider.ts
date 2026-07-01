import type { AgentMessage } from "../agent/types.js";
import { AppError } from "../errors/app-error.js";
import type { LlmDeltaHandler, LlmProvider, LlmProviderRequest, LlmProviderResponse } from "./types.js";

export interface OpenAiCompatibleProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function toProviderMessage(message: AgentMessage): Record<string, unknown> {
  // 项目内部的 AgentMessage 是“框架无关”的格式。
  // 到这里才翻译成 OpenAI compatible API 需要的 role/tool_calls/tool_call_id 字段。
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content ?? null,
      tool_calls: message.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments)
        }
      }))
    };
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content
    };
  }

  return message;
}

function parseToolArguments(rawArguments: string, toolName: string): Record<string, unknown> {
  try {
    // 模型返回的 tool arguments 是字符串形式的 JSON。
    // 后续 ToolExecutor 还会用 zod 再校验一遍；这里先保证 provider 层拿到的是对象。
    const parsed = JSON.parse(rawArguments || "{}") as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool arguments must be an object");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "不是合法 JSON";
    throw new AppError("PROVIDER_BAD_RESPONSE", `工具 ${toolName} 的参数不是合法 JSON：${detail}`, 502);
  }
}

function toToolDefinitions(request: LlmProviderRequest) {
  return request.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

function toChatCompletionPayload(model: string, request: LlmProviderRequest, stream = false): Record<string, unknown> {
  return {
    model,
    messages: request.messages.map(toProviderMessage),
    tools: toToolDefinitions(request),
    stream
  };
}

interface StreamToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly options: OpenAiCompatibleProviderOptions) {}

  private buildRequestBody(request: LlmProviderRequest, stream = false): string {
    return JSON.stringify(toChatCompletionPayload(this.options.model, request, stream));
  }

  async complete(request: LlmProviderRequest): Promise<LlmProviderResponse> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`
      },
      signal: request.signal,
      body: this.buildRequestBody(request)
    });

    if (!response.ok) {
      throw new AppError("PROVIDER_ERROR", `模型服务请求失败：${response.status}`, 502);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        };
      }>;
    };

    const message = payload.choices?.[0]?.message;

    if (!message) {
      throw new AppError("PROVIDER_ERROR", "模型服务没有返回消息", 502);
    }

    const toolCalls = message.tool_calls?.map((toolCall) => {
      const name = toolCall.function?.name;

      if (!toolCall.id || !name) {
        throw new AppError("PROVIDER_BAD_RESPONSE", "模型返回了无效的工具调用", 502);
      }

      return {
        id: toolCall.id,
        name,
        arguments: parseToolArguments(toolCall.function?.arguments ?? "{}", name)
      };
    });

    const content = message.content ?? undefined;

    if (!content && !toolCalls?.length) {
      throw new AppError("PROVIDER_BAD_RESPONSE", "模型响应缺少最终回答或工具调用", 502);
    }

    return { content, toolCalls };
  }

  async completeStream(request: LlmProviderRequest, onDelta: LlmDeltaHandler): Promise<LlmProviderResponse> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`
      },
      signal: request.signal,
      body: this.buildRequestBody(request, true)
    });

    if (!response.ok) {
      throw new AppError("PROVIDER_ERROR", `模型服务请求失败：${response.status}`, 502);
    }

    if (!response.body) {
      throw new AppError("PROVIDER_ERROR", "模型服务没有返回流式响应体", 502);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const contentParts: string[] = [];
    const toolCalls = new Map<number, StreamToolCallAccumulator>();
    let buffer = "";

    const handleBlock = async (block: string) => {
      // OpenAI compatible 的 stream 是 SSE：一个事件块里可能有多行 data。
      // 网络 chunk 不保证正好按事件边界到达，所以外层用 buffer 拼块，这里只处理完整 block。
      const dataLines = block
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"));

      for (const dataLine of dataLines) {
        const data = dataLine.slice("data:".length).trim();

        if (!data || data === "[DONE]") {
          continue;
        }

        const chunk = JSON.parse(data) as StreamChunk;
        const delta = chunk.choices?.[0]?.delta;

        if (!delta) {
          continue;
        }

        if (delta.content) {
          contentParts.push(delta.content);
          await onDelta(delta.content);
        }

        for (const toolCallDelta of delta.tool_calls ?? []) {
          const index = toolCallDelta.index ?? 0;
          const current = toolCalls.get(index) ?? { arguments: "" };
          // 流式 tool call 的 arguments 常常被拆成很多小片段。
          // 不能每个片段单独 JSON.parse，必须按 index 累积完整字符串后再统一解析。
          current.id = toolCallDelta.id ?? current.id;
          current.name = toolCallDelta.function?.name ?? current.name;
          current.arguments += toolCallDelta.function?.arguments ?? "";
          toolCalls.set(index, current);
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      // 最后一段可能只是半个 SSE block，先留下来等下一次 reader.read() 补齐。
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        await handleBlock(block);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      await handleBlock(buffer);
    }

    const parsedToolCalls = [...toolCalls.entries()]
      .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
      .map(([, toolCall]) => {
        if (!toolCall.id || !toolCall.name) {
          throw new AppError("PROVIDER_BAD_RESPONSE", "模型返回了无效的工具调用", 502);
        }

        return {
          id: toolCall.id,
          name: toolCall.name,
          arguments: parseToolArguments(toolCall.arguments || "{}", toolCall.name)
        };
      });

    const content = contentParts.join("") || undefined;
    const result: LlmProviderResponse = {
      content,
      toolCalls: parsedToolCalls.length ? parsedToolCalls : undefined
    };

    if (!result.content && !result.toolCalls?.length) {
      throw new AppError("PROVIDER_BAD_RESPONSE", "模型响应缺少最终回答或工具调用", 502);
    }

    return result;
  }
}
