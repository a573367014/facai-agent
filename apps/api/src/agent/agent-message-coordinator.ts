import { AppError } from "../errors/app-error.js";
import type { AgentService } from "./agent-service.js";
import { AgentContextBuilder } from "./context-builder.js";
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
    const session = input.sessionId ? this.getSession(input.sessionId).session : this.store.createSession(input.input.slice(0, 32));
    const history = this.buildConversationHistory(session.id);
    const userMessage = this.store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      content: input.input
    });
    const assistantMessage = this.store.createMessage({
      sessionId: session.id,
      role: "assistant",
      status: "running",
      content: "",
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
        content: "",
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
          this.store.appendEvent(messageId, event);
        }
      });

      if (this.store.getMessage(messageId)?.status !== "running") {
        return;
      }

      const completedMessage = this.store.updateMessage(messageId, {
        status: "completed",
        content: result.answer,
        steps: result.steps,
        completedAt: now()
      });

      if (completedMessage) {
        this.persistGeneratedAssets({
          sessionId: completedMessage.sessionId,
          messageId
        });
      }
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
        content: "本轮运行失败。",
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

  private persistGeneratedAssets(input: { sessionId: string; messageId: string }) {
    const toolResultEvents = this.store
      .getEvents(input.messageId)
      .map((event) => event.event)
      .filter(isGeneratedImageToolResult);
    let assetIndex = 0;

    for (const event of toolResultEvents) {
      for (const asset of extractImageAssets(event.result, assetIndex)) {
        this.store.createAsset({
          sessionId: input.sessionId,
          messageId: input.messageId,
          toolCallId: event.toolCallId,
          ...asset
        });
        assetIndex += 1;
      }
    }
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

function isGeneratedImageToolResult(
  event: AgentStreamEvent
): event is Extract<AgentStreamEvent, { type: "tool_result" }> & { toolName: "generate_image" } {
  return event.type === "tool_result" && event.toolName === "generate_image";
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
