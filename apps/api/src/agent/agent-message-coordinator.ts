import { AppError } from "../errors/app-error.js";
import type { AgentService } from "./agent-service.js";
import { AgentContextBuilder } from "./context-builder.js";
import {
  appendTextDelta,
  createTextPart,
  partsToLegacyContent,
  upsertGeneratedImageParts,
  type GeneratedImagePartInput,
  type MessagePart
} from "./message-parts.js";
import type { AgentErrorDetail, AgentMessage, AgentExecutionInput, AgentStreamEvent, JsonObject } from "./types.js";
import type { AgentAssetRecord, AgentEventListener, AgentMessageRecord, AgentStore } from "./agent-store.js";

type MessageWithAssets = AgentMessageRecord & { assets: AgentAssetRecord[] };

function toErrorDetail(error: unknown): AgentErrorDetail {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }

  return {
    code: "PROVIDER_ERROR",
    message: error instanceof Error ? error.message : "发生未知错误"
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function now() {
  return new Date().toISOString();
}

export class AgentMessageCoordinator {
  private readonly runningMessages = new Map<string, AbortController>();

  constructor(
    private readonly agentService: AgentService,
    private readonly store: AgentStore,
    private readonly contextBuilder = new AgentContextBuilder()
  ) {}

  createSession(title?: string) {
    return this.store.createSession(title);
  }

  listSessions() {
    return {
      sessions: this.store.listSessions()
    };
  }

  getSession(sessionId: string) {
    const session = this.store.getSession(sessionId);

    if (!session) {
      throw new AppError("VALIDATION_ERROR", `未找到会话：${sessionId}`, 404);
    }

    return {
      session,
      messages: this.attachAssetsToMessages(sessionId)
    };
  }

  startMessage(input: AgentExecutionInput & { sessionId?: string }) {
    const userParts = input.parts?.length ? input.parts : [createTextPart(input.input)];
    const userText = partsToLegacyContent(userParts);
    const session = input.sessionId ? this.getSession(input.sessionId).session : this.store.createSession(userText.slice(0, 32));
    const history = this.buildConversationHistory(session.id);
    const userMessage = this.store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: userParts
    });
    const assistantMessage = this.store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      parts: [createTextPart("")],
      maxIterations: input.maxIterations
    });
    const controller = new AbortController();

    this.runningMessages.set(assistantMessage.id, controller);
    void this.executeMessage(assistantMessage.id, {
      ...input,
      sessionId: session.id,
      messageId: assistantMessage.id,
      history,
      signal: controller.signal
    });

    return {
      session,
      userMessage: this.attachAssetsToMessage(userMessage),
      assistantMessage: this.attachAssetsToMessage(assistantMessage)
    };
  }

  cancelMessage(messageId: string) {
    const message = this.ensureAssistantMessage(messageId);

    if (message.status !== "running") {
      return { message: this.attachAssetsToMessage(message) };
    }

    this.runningMessages.get(messageId)?.abort();
    this.store.appendEvent(messageId, {
      type: "agent_state",
      iteration: 0,
      state: "done",
      label: "已中断"
    });
    this.store.appendEvent(messageId, {
      type: "cancelled",
      reason: "用户中断"
    });
      const cancelledMessage =
        this.store.updateMessage(messageId, {
          status: "cancelled",
          parts: message.parts,
          completedAt: now()
        }) ?? message;
    this.runningMessages.delete(messageId);

    return { message: this.attachAssetsToMessage(cancelledMessage) };
  }

  getMessage(messageId: string) {
    const message = this.ensureAssistantMessage(messageId);

    return {
      message: this.attachAssetsToMessage(message),
      events: this.store.getEvents(messageId)
    };
  }

  getEvents(messageId: string, after = 0) {
    this.ensureAssistantMessage(messageId);
    return this.store.getEvents(messageId, after);
  }

  subscribe(messageId: string, listener: AgentEventListener) {
    this.ensureAssistantMessage(messageId);
    return this.store.subscribe(messageId, listener);
  }

  private async executeMessage(messageId: string, input: AgentExecutionInput) {
    try {
      const result = await this.agentService.run({
        input: input.input,
        history: input.history,
        maxIterations: input.maxIterations,
        messageId: input.messageId,
        sessionId: input.sessionId,
        signal: input.signal,
        onEvent: (event) => {
          this.handleExecutionEvent(messageId, event);
        }
      });

      if (this.store.getMessage(messageId)?.status !== "running") {
        return;
      }

      this.store.updateMessage(messageId, {
        status: "completed",
        parts: this.withAssistantText(messageId, result.answer),
        steps: result.steps,
        completedAt: now()
      });
    } catch (error) {
      if (isAbortError(error) || this.store.getMessage(messageId)?.status === "cancelled") {
        return;
      }

      const detail = toErrorDetail(error);
      this.store.appendEvent(messageId, {
        type: "error",
        code: detail.code,
        message: detail.message
      });
      this.store.updateMessage(messageId, {
        status: "failed",
        parts: this.withAssistantText(messageId, "本轮运行失败。"),
        error: detail,
        completedAt: now()
      });
    } finally {
      this.runningMessages.delete(messageId);
    }
  }

  private ensureAssistantMessage(messageId: string) {
    const message = this.store.getMessage(messageId);

    if (!message || message.role !== "assistant") {
      throw new AppError("VALIDATION_ERROR", `未找到助手消息：${messageId}`, 404);
    }

    return message;
  }

  private handleExecutionEvent(messageId: string, event: AgentStreamEvent) {
    if (event.type === "answer_delta") {
      this.appendAssistantTextDelta(messageId, event.delta);
      this.store.appendEvent(messageId, event);
      return;
    }

    if (event.type === "tool_start" && event.toolName === "generate_image" && event.toolCallId) {
      this.upsertImagePart(messageId, {
        state: "pending",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        outputIndex: 0,
        mime: "image/png",
        generation: { prompt: toOptionalString(event.arguments.prompt) }
      });
    }

    if (event.type === "tool_result" && event.toolName === "generate_image" && event.toolCallId) {
      this.upsertImageResultParts(messageId, event);
    }

    if (event.type === "tool_error" && event.toolName === "generate_image" && event.toolCallId) {
      this.upsertImagePart(messageId, {
        state: "failed",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        outputIndex: 0,
        mime: "image/png",
        error: {
          code: event.error.code,
          message: event.error.message
        }
      });
    }

    this.store.appendEvent(messageId, event);
  }

  private appendAssistantTextDelta(messageId: string, delta: string) {
    const message = this.store.getMessage(messageId);

    if (!message) {
      return;
    }

    const { parts, partIndex } = ensureTextPart(message.parts);
    const nextParts = appendTextDelta(parts, partIndex, delta);
    this.store.updateMessageParts(messageId, nextParts);
    this.store.appendEvent(messageId, {
      type: "message.part.delta",
      messageId,
      partIndex,
      delta
    });
  }

  private withAssistantText(messageId: string, value: string): MessagePart[] {
    const message = this.store.getMessage(messageId);
    const { parts, partIndex } = ensureTextPart(message?.parts ?? []);

    return parts.map((part, index) => (index === partIndex && part.type === "text" ? { ...part, value } : part));
  }

  private upsertImageResultParts(
    messageId: string,
    event: Extract<AgentStreamEvent, { type: "tool_result" }> & { toolName: "generate_image"; toolCallId: string }
  ) {
    for (const asset of extractImageAssets(event.result, 0)) {
      this.upsertImagePart(messageId, {
        state: "succeeded",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        outputIndex: asset.index ?? 0,
        mime: asset.mimeType ?? "image/png",
        url: asset.url,
        width: asset.width,
        height: asset.height,
        generation: {
          prompt: asset.prompt,
          provider: toOptionalString(asset.metadata?.provider)
        }
      });
    }
  }

  private upsertImagePart(messageId: string, input: GeneratedImagePartInput) {
    const message = this.store.getMessage(messageId);

    if (!message) {
      return;
    }

    const existingIndex = findToolPartIndex(message.parts, input.toolCallId, input.outputIndex);
    const nextParts = upsertGeneratedImageParts(message.parts, input);
    const partIndex = findToolPartIndex(nextParts, input.toolCallId, input.outputIndex);
    const updatedMessage = this.store.updateMessageParts(messageId, nextParts);
    const part = updatedMessage?.parts[partIndex] ?? nextParts[partIndex];

    if (!part || partIndex < 0) {
      return;
    }

    this.store.appendEvent(messageId, {
      type: existingIndex === -1 ? "message.part.created" : "message.part.updated",
      messageId,
      partIndex,
      part
    });
  }

  private buildConversationHistory(sessionId: string): AgentMessage[] {
    return this.contextBuilder.buildConversationHistory(this.store.getMessagesBySession(sessionId));
  }

  private attachAssetsToMessages(sessionId: string): MessageWithAssets[] {
    const assetsByMessageId = this.groupAssetsByMessageId(sessionId);

    return this.store.getMessagesBySession(sessionId).map((message) => ({
      ...message,
      assets: assetsByMessageId.get(message.id) ?? []
    }));
  }

  private attachAssetsToMessage(message: AgentMessageRecord): MessageWithAssets {
    const assetsByMessageId = this.groupAssetsByMessageId(message.sessionId);

    return {
      ...message,
      assets: assetsByMessageId.get(message.id) ?? []
    };
  }

  private groupAssetsByMessageId(sessionId: string) {
    const assetsByMessageId = new Map<string, AgentAssetRecord[]>();

    for (const asset of this.store.getAssetsBySession(sessionId)) {
      if (!asset.messageId) {
        continue;
      }

      const messageAssets = assetsByMessageId.get(asset.messageId) ?? [];
      messageAssets.push(asset);
      assetsByMessageId.set(asset.messageId, messageAssets);
    }

    return assetsByMessageId;
  }

}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function compactJsonObject(value: Record<string, unknown>): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as JsonObject;
}

function ensureTextPart(parts: MessagePart[]): { parts: MessagePart[]; partIndex: number } {
  const partIndex = parts.findIndex((part) => part.type === "text");

  if (partIndex !== -1) {
    return { parts, partIndex };
  }

  return { parts: [createTextPart(""), ...parts], partIndex: 0 };
}

function findToolPartIndex(parts: MessagePart[], toolCallId: string, outputIndex?: number) {
  return parts.findIndex(
    (part) =>
      part.type === "media" &&
      part.extra?.tool?.toolCallId === toolCallId &&
      part.extra.tool.outputIndex === outputIndex
  );
}

function extractImageAssets(result: unknown, startIndex: number) {
  if (!isRecord(result)) {
    return [];
  }

  const resultPrompt = toOptionalString(result.prompt);
  const batchItems = Array.isArray(result.items) ? result.items.filter(isRecord) : [];
  let nextIndex = startIndex;

  if (batchItems.length > 0) {
    return batchItems.flatMap((item) => {
      const itemPrompt = toOptionalString(item.prompt) ?? resultPrompt;
      const itemUrls = toStringArray(item.imageUrls);

      return itemUrls.map((url) => {
        const index = nextIndex;
        nextIndex += 1;

        return {
          type: "image" as const,
          url,
          width: toOptionalNumber(item.width),
          height: toOptionalNumber(item.height),
          prompt: itemPrompt,
          index,
          metadata: compactJsonObject({
            provider: result.provider,
            size: result.size,
            itemIndex: item.index,
            itemStatus: item.status,
            seed: item.seed,
            taskId: item.taskId
          })
        };
      });
    });
  }

  return toStringArray(result.imageUrls).map((url) => {
    const index = nextIndex;
    nextIndex += 1;

    return {
      type: "image" as const,
      url,
      prompt: resultPrompt,
      index,
      metadata: compactJsonObject({
        provider: result.provider,
        size: result.size,
        revisedPrompts: result.revisedPrompts
      })
    };
  });
}
