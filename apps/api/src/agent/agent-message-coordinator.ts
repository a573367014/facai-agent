import { AppError } from "../errors/app-error.js";
import type { AgentSummaryService } from "./agent-summary-service.js";
import type { AgentService } from "./agent-service.js";
import { AgentContextBuilder } from "./context-builder.js";
import {
  createTextPart,
  partsToLlmText,
  upsertGeneratedImageParts,
  type GeneratedImagePartInput,
  type MessagePart
} from "./message-parts.js";
import {
  InMemoryRunningMessageStateStore,
  type RunningMessageState,
  type RunningMessageStateStore
} from "./running-message-state-store.js";
import type { AgentErrorDetail, AgentMessage, AgentExecutionInput, AgentStreamEvent, JsonObject } from "./types.js";
import type {
  AgentEventListener,
  AgentMessagePage,
  AgentMessageRecord,
  AgentResourceRecord,
  AgentRunRecord,
  AgentStore,
  AgentToolCallRecord,
  StoredAgentEvent
} from "./agent-store.js";

const DEFAULT_SESSION_MESSAGE_LIMIT = 30;
const MAX_SESSION_MESSAGE_LIMIT = 100;
const IMAGE_OUTPUT_TOOL_NAMES = new Set(["generate_image", "edit_image"]);

interface ExtractedImageResult {
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
  prompt?: string;
  index: number;
  metadata: JsonObject;
}

interface FailedImageResult {
  width?: number;
  height?: number;
  prompt?: string;
  index: number;
  error?: string;
  metadata: JsonObject;
}

interface ImageRequestSlot {
  outputIndex: number;
  prompt?: string;
  width?: number;
  height?: number;
  sourceImageUrl?: string;
  isBatch: boolean;
}

type AgentMessagePageWithResources = AgentMessagePage & {
  resources: AgentResourceRecord[];
};

interface RunningDraftSnapshot {
  message: AgentMessageRecord;
  version?: number;
}

interface DraftPartsUpdate {
  parts: MessagePart[];
  version?: number;
}

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
  private readonly runningRuns = new Map<string, AbortController>();

  constructor(
    private readonly agentService: AgentService,
    private readonly store: AgentStore,
    private readonly contextBuilder = new AgentContextBuilder(),
    private readonly summaryService?: AgentSummaryService,
    private readonly runningStateStore: RunningMessageStateStore = new InMemoryRunningMessageStateStore()
  ) {}

  createSession(title?: string) {
    return this.store.createSession(title);
  }

  listSessions() {
    return {
      sessions: this.store.listSessions()
    };
  }

  getSession(sessionId: string, options: { messageLimit?: number } = {}) {
    const session = this.store.getSession(sessionId);

    if (!session) {
      throw new AppError("VALIDATION_ERROR", `未找到会话：${sessionId}`, 404);
    }

    const messagePage = this.getRecentMessagePage(sessionId, options.messageLimit);

    return {
      session,
      messages: messagePage.messages,
      resources: this.getResourcesForMessages(messagePage.messages),
      pageInfo: messagePage.pageInfo,
      summary: this.store.getSessionSummary(sessionId)
    };
  }

  getSessionMessages(sessionId: string, options: { before?: string; messageLimit?: number } = {}): AgentMessagePageWithResources {
    const session = this.store.getSession(sessionId);

    if (!session) {
      throw new AppError("VALIDATION_ERROR", `未找到会话：${sessionId}`, 404);
    }

    if (!options.before) {
      return this.withResources(this.getRecentMessagePage(sessionId, options.messageLimit));
    }

    return this.withResources(
      this.trimOldestOverflow(
        this.store.getMessagesBefore(sessionId, options.before, this.normalizeMessageLimit(options.messageLimit) + 1),
        this.normalizeMessageLimit(options.messageLimit)
      )
    );
  }

  async startMessage(input: AgentExecutionInput & { sessionId?: string }) {
    const userParts = input.parts?.length ? input.parts : [createTextPart(input.input)];
    const userText = partsToLlmText(userParts);
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

    await this.initRunningMessageState(assistantMessage);
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
      userMessage,
      assistantMessage
    };
  }

  startRun(input: AgentExecutionInput & { sessionId?: string }) {
    const userParts = input.parts?.length ? input.parts : [createTextPart(input.input)];
    const userText = partsToLlmText(userParts);
    const session = input.sessionId ? this.getSession(input.sessionId).session : this.store.createSession(userText.slice(0, 32));
    const userMessage = this.store.createMessage({
      sessionId: session.id,
      role: "user",
      status: "completed",
      parts: userParts
    });
    const run = this.store.createRun({
      sessionId: session.id,
      userMessageId: userMessage.id,
      status: "running",
      phase: "compressing"
    });
    const controller = new AbortController();

    this.runningRuns.set(run.id, controller);
    this.store.appendRunEvent(run.id, { type: "session.message.created", message: userMessage }, userMessage.id);
    void this.executeRun(run.id, {
      ...input,
      input: userText,
      parts: userParts,
      sessionId: session.id,
      signal: controller.signal
    });

    return {
      run,
      session,
      userMessage
    };
  }

  async regenerateMessage(messageId: string) {
    const sourceAssistantMessage = this.ensureAssistantMessage(messageId);

    if (sourceAssistantMessage.status === "running") {
      throw new AppError("VALIDATION_ERROR", "运行中的回答不能重新生成，请先停止当前生成", 400);
    }

    const userMessage = this.findInputUserMessageForAssistant(sourceAssistantMessage);

    if (!userMessage) {
      throw new AppError("VALIDATION_ERROR", "未找到这条回答对应的用户输入，无法重新生成", 404);
    }

    const session = this.getSession(sourceAssistantMessage.sessionId).session;
    const userText = partsToLlmText(userMessage.parts);
    const run = this.store.createRun({
      sessionId: session.id,
      userMessageId: userMessage.id,
      status: "running",
      phase: "answering"
    });
    const controller = new AbortController();
    const history = this.buildConversationHistoryBefore(session.id, userMessage.id);

    this.runningRuns.set(run.id, controller);
    void this.executeRun(
      run.id,
      {
        input: userText,
        parts: userMessage.parts,
        maxIterations: sourceAssistantMessage.maxIterations,
        sessionId: session.id,
        signal: controller.signal
      },
      {
        history,
        skipSummaryRefresh: true
      }
    );

    return {
      run,
      session,
      userMessage
    };
  }

  async cancelRun(runId: string) {
    const run = this.ensureRun(runId);

    if (run.status !== "running") {
      return { run };
    }

    this.runningRuns.get(runId)?.abort();
    const timestamp = now();

    if (run.systemMessageId) {
      const systemMessage = this.store.getMessage(run.systemMessageId);

      if (systemMessage?.status === "running") {
        const cancelledSystemMessage =
          this.store.updateMessage(systemMessage.id, {
            status: "cancelled",
            parts: [createTextPart("上下文压缩已中断")],
            completedAt: timestamp
          }) ?? systemMessage;
        this.store.appendRunEvent(runId, { type: "session.message.updated", message: cancelledSystemMessage }, cancelledSystemMessage.id);
      }
    }

    if (run.assistantMessageId) {
      const assistantMessage = this.store.getMessage(run.assistantMessageId);

      if (assistantMessage?.status === "running") {
        const draftMessage = await this.withRunningDraft(assistantMessage);
        this.store.appendRunEvent(runId, {
          type: "agent_state",
          iteration: 0,
          state: "done",
          label: "已中断"
        }, assistantMessage.id);
        const cancelledAssistantMessage =
          this.store.updateMessage(assistantMessage.id, {
            status: "cancelled",
            parts: draftMessage.parts,
            completedAt: timestamp
          }) ?? assistantMessage;
        this.store.appendRunEvent(
          runId,
          { type: "session.message.updated", message: cancelledAssistantMessage },
          cancelledAssistantMessage.id
        );
        await this.runningStateStore.remove(assistantMessage.id);
      }
    }

    this.store.appendRunEvent(runId, { type: "cancelled", reason: "用户中断" }, run.assistantMessageId ?? run.systemMessageId);
    const cancelledRun =
      this.store.updateRun(runId, {
        status: "cancelled",
        phase: "cancelled",
        completedAt: timestamp
      }) ?? run;
    this.runningRuns.delete(runId);

    return { run: cancelledRun };
  }

  getRun(runId: string) {
    const run = this.ensureRun(runId);

    return {
      run,
      events: this.store.getRunEvents(runId)
    };
  }

  getMessageDebugEvents(messageId: string) {
    const message = this.ensureMessage(messageId);
    const messageEvents = this.store.getEvents(messageId);
    const runs = this.store.getRunsByMessageId(messageId);
    const runEvents = runs.flatMap((run) => this.store.getRunEvents(run.id));

    return {
      message,
      runs,
      messageEvents,
      runEvents,
      events: sortStoredEvents([...messageEvents, ...runEvents])
    };
  }

  getRunEvents(runId: string, after = 0) {
    this.ensureRun(runId);
    return this.store.getRunEvents(runId, after);
  }

  subscribeRun(runId: string, listener: AgentEventListener) {
    this.ensureRun(runId);
    return this.store.subscribeRun(runId, listener);
  }

  async cancelMessage(messageId: string) {
    const message = this.ensureAssistantMessage(messageId);

    if (message.status !== "running") {
      return { message };
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
    const draftMessage = await this.withRunningDraft(message);
    const cancelledMessage =
      this.store.updateMessage(messageId, {
        status: "cancelled",
        parts: draftMessage.parts,
        completedAt: now()
      }) ?? message;
    this.runningMessages.delete(messageId);
    await this.runningStateStore.remove(messageId);

    return { message: cancelledMessage };
  }

  getMessage(messageId: string) {
    const message = this.ensureAssistantMessage(messageId);

    return {
      message,
      resources: this.getResourcesForMessages([message]),
      events: this.store.getEvents(messageId)
    };
  }

  async getMessageSnapshot(messageId: string) {
    const { message, version } = await this.getRunningDraftSnapshot(this.ensureAssistantMessage(messageId));

    return {
      message,
      resources: this.getResourcesForMessages([message]),
      events: this.store.getEvents(messageId),
      version
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

  private async executeRun(
    runId: string,
    input: AgentExecutionInput,
    options: { history?: AgentMessage[]; skipSummaryRefresh?: boolean } = {}
  ) {
    let assistantMessage: AgentMessageRecord | undefined;
    let finalAnswerEvent: Extract<AgentStreamEvent, { type: "final_answer" }> | undefined;

    try {
      if (!input.sessionId || !input.signal || !input.parts?.length) {
        throw new AppError("VALIDATION_ERROR", "run 缺少必要的执行上下文", 400);
      }

      const run = this.ensureRun(runId);
      const userMessageId = run.userMessageId;

      if (!options.skipSummaryRefresh) {
        await this.refreshSessionSummaryBeforeAnswer(runId, input.sessionId, userMessageId, input.signal);
      }

      if (input.signal.aborted || this.store.getRun(runId)?.status !== "running") {
        return;
      }

      const history = options.history ?? this.buildConversationHistoryBefore(input.sessionId, userMessageId);

      assistantMessage = this.store.createMessage({
        sessionId: input.sessionId,
        role: "assistant",
        status: "running",
        parts: [createTextPart("")],
        maxIterations: input.maxIterations
      });
      await this.initRunningMessageState(assistantMessage, runId);
      this.store.updateRun(runId, {
        phase: "answering",
        assistantMessageId: assistantMessage.id
      });
      this.store.appendRunEvent(runId, { type: "session.message.created", message: assistantMessage }, assistantMessage.id);

      const result = await this.agentService.run({
        input: input.input,
        history,
        maxIterations: input.maxIterations,
        messageId: assistantMessage.id,
        sessionId: input.sessionId,
        signal: input.signal,
        onEvent: async (event) => {
          if (event.type === "final_answer") {
            finalAnswerEvent = event;
            return;
          }

          await this.handleExecutionEvent(assistantMessage!.id, event, runId);
        }
      });

      if (this.store.getMessage(assistantMessage.id)?.status !== "running" || this.store.getRun(runId)?.status !== "running") {
        return;
      }

      const finalParts = await this.setAssistantTextAndEmitUpdate(assistantMessage.id, result.answer, runId);
      this.store.appendRunEvent(runId, finalAnswerEvent ?? { type: "final_answer", answer: result.answer }, assistantMessage.id);
      const completedAssistantMessage =
        this.store.updateMessage(assistantMessage.id, {
          status: "completed",
          parts: finalParts,
          completedAt: now()
        }) ?? assistantMessage;
      this.store.appendRunEvent(
        runId,
        { type: "session.message.updated", message: completedAssistantMessage },
        completedAssistantMessage.id
      );
      this.store.appendRunEvent(runId, { type: "run_completed", messageId: assistantMessage.id }, assistantMessage.id);
      this.store.updateRun(runId, {
        status: "completed",
        phase: "completed",
        completedAt: now()
      });
    } catch (error) {
      if (isAbortError(error) || this.store.getRun(runId)?.status === "cancelled") {
        return;
      }

      const detail = toErrorDetail(error);
      const messageId = assistantMessage?.id;

      this.store.appendRunEvent(
        runId,
        {
          type: "error",
          code: detail.code,
          message: detail.message
        },
        messageId
      );

      if (messageId) {
        const failedMessage =
          this.store.updateMessage(messageId, {
            status: "failed",
            parts: await this.withAssistantText(messageId, "本轮运行失败。"),
            error: detail,
            completedAt: now()
          }) ?? this.store.getMessage(messageId);

        if (failedMessage) {
          this.store.appendRunEvent(runId, { type: "session.message.updated", message: failedMessage }, messageId);
        }
      }

      this.store.updateRun(runId, {
        status: "failed",
        phase: "failed",
        error: detail,
        completedAt: now()
      });
    } finally {
      this.runningRuns.delete(runId);
      if (assistantMessage) {
        await this.runningStateStore.remove(assistantMessage.id);
      }
    }
  }

  private async initRunningMessageState(message: AgentMessageRecord, runId?: string): Promise<RunningMessageState> {
    return this.runningStateStore.init({
      messageId: message.id,
      sessionId: message.sessionId,
      runId,
      parts: message.parts
    });
  }

  private async withRunningDraft(message: AgentMessageRecord): Promise<AgentMessageRecord> {
    return (await this.getRunningDraftSnapshot(message)).message;
  }

  private async getRunningDraftSnapshot(message: AgentMessageRecord): Promise<RunningDraftSnapshot> {
    if (message.status !== "running") {
      return { message };
    }

    const state = await this.runningStateStore.get(message.id);

    if (!state) {
      return { message };
    }

    return {
      message: {
        ...message,
        parts: state.parts,
        updatedAt: state.updatedAt
      },
      version: state.version
    };
  }

  private async ensureRunningState(message: AgentMessageRecord, runId?: string): Promise<RunningMessageState | undefined> {
    if (message.status !== "running") {
      return undefined;
    }

    const state = await this.runningStateStore.get(message.id);

    if (state) {
      return state;
    }

    return this.initRunningMessageState(message, runId);
  }

  private async getDraftParts(messageId: string, runId?: string): Promise<MessagePart[]> {
    const message = this.store.getMessage(messageId);

    if (!message) {
      return [];
    }

    const state = await this.ensureRunningState(message, runId);
    return state?.parts ?? message.parts;
  }

  private async setDraftParts(messageId: string, parts: MessagePart[], runId?: string): Promise<DraftPartsUpdate> {
    const message = this.store.getMessage(messageId);

    if (!message) {
      return { parts };
    }

    if (message.status === "running") {
      await this.ensureRunningState(message, runId);
      const state = await this.runningStateStore.setParts(messageId, parts);
      return {
        parts: state?.parts ?? parts,
        version: state?.version
      };
    }

    return {
      parts: this.store.updateMessageParts(messageId, parts)?.parts ?? parts
    };
  }

  private async executeMessage(messageId: string, input: AgentExecutionInput) {
    let finalAnswerEvent: Extract<AgentStreamEvent, { type: "final_answer" }> | undefined;

    try {
      const result = await this.agentService.run({
        input: input.input,
        history: input.history,
        maxIterations: input.maxIterations,
        messageId: input.messageId,
        sessionId: input.sessionId,
        signal: input.signal,
        onEvent: async (event) => {
          if (event.type === "final_answer") {
            finalAnswerEvent = event;
            return;
          }

          await this.handleExecutionEvent(messageId, event);
        }
      });

      if (this.store.getMessage(messageId)?.status !== "running") {
        return;
      }

      const finalParts = await this.setAssistantTextAndEmitUpdate(messageId, result.answer);
      this.store.appendEvent(messageId, finalAnswerEvent ?? { type: "final_answer", answer: result.answer });
      this.store.updateMessage(messageId, {
        status: "completed",
        parts: finalParts,
        completedAt: now()
      });
      await this.refreshSessionSummary(input.sessionId);
      this.store.appendEvent(messageId, { type: "run_completed", messageId });
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
        parts: await this.withAssistantText(messageId, "本轮运行失败。"),
        error: detail,
        completedAt: now()
      });
    } finally {
      this.runningMessages.delete(messageId);
      await this.runningStateStore.remove(messageId);
    }
  }

  private ensureAssistantMessage(messageId: string) {
    const message = this.ensureMessage(messageId);

    if (message.role !== "assistant") {
      throw new AppError("VALIDATION_ERROR", `未找到助手消息：${messageId}`, 404);
    }

    return message;
  }

  private findInputUserMessageForAssistant(assistantMessage: AgentMessageRecord): AgentMessageRecord | undefined {
    const sessionMessages = this.store.getMessagesBySession(assistantMessage.sessionId);
    const assistantIndex = sessionMessages.findIndex((message) => message.id === assistantMessage.id);

    if (assistantIndex <= 0) {
      return undefined;
    }

    return [...sessionMessages.slice(0, assistantIndex)].reverse().find((message) => message.role === "user");
  }

  private ensureMessage(messageId: string) {
    const message = this.store.getMessage(messageId);

    if (!message) {
      throw new AppError("VALIDATION_ERROR", `未找到消息：${messageId}`, 404);
    }

    return message;
  }

  private ensureRun(runId: string): AgentRunRecord {
    const run = this.store.getRun(runId);

    if (!run) {
      throw new AppError("VALIDATION_ERROR", `未找到运行：${runId}`, 404);
    }

    return run;
  }

  private async handleExecutionEvent(messageId: string, event: AgentStreamEvent, runId?: string) {
    if (event.type === "answer_delta") {
      await this.appendAssistantTextDelta(messageId, event.delta, runId);
      return;
    }

    if (event.type === "tool_call_ready") {
      this.ensureToolCallRecord(messageId, event, runId, "pending");
    }

    if (event.type === "tool_start" && isImageOutputToolName(event.toolName) && event.toolCallId) {
      const toolCall = this.ensureToolCallRecord(messageId, event, runId, "running");
      const imageSlots = extractImageRequestSlots(event.arguments);

      for (const slot of imageSlots) {
        const resource = this.upsertImageResource(messageId, {
          status: "pending",
          toolCallId: event.toolCallId,
          toolCallRowId: toolCall?.id,
          outputIndex: slot.outputIndex,
          mime: "image/png",
          metadata: buildImageMetadata({
            prompt: slot.prompt,
            width: slot.width,
            height: slot.height,
            sourceImageUrl: slot.sourceImageUrl,
            outputIndex: slot.outputIndex,
            includeOutputIndex: slot.isBatch
          })
        }, runId);

        await this.upsertImagePart(messageId, {
          state: "pending",
          resourceId: resource.id,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          toolCallRowId: toolCall?.id,
          outputIndex: slot.outputIndex,
          mime: "image/png"
        }, runId);
      }
    } else if (event.type === "tool_start" && event.toolCallId) {
      this.ensureToolCallRecord(messageId, event, runId, "running");
    }

    if (isImageToolResultWithId(event)) {
      await this.upsertImageResultParts(messageId, event, runId);
    } else if (event.type === "tool_result" && event.toolCallId) {
      const toolCall = this.ensureToolCallRecord(messageId, event, runId, "running");
      if (toolCall) {
        this.store.updateToolCall(toolCall.id, {
          status: "succeeded",
          durationMs: event.durationMs,
          resultSummary: summarizeToolResult(event.result)
        });
      }
    }

    if (event.type === "tool_error" && isImageOutputToolName(event.toolName) && event.toolCallId) {
      const toolCall = this.ensureToolCallRecord(messageId, event, runId, "running");
      const resource = this.upsertImageResource(messageId, {
        status: "failed",
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: 0,
        mime: "image/png",
        metadata: compactJsonObject({
          prompt: toOptionalString(toolCall?.arguments.prompt),
          sourceImageUrl: toOptionalString(toolCall?.arguments.imageUrl),
          error: {
            code: event.error.code,
            message: event.error.message
          }
        })
      }, runId);

      if (toolCall) {
        this.store.updateToolCall(toolCall.id, {
          status: "failed",
          durationMs: event.durationMs,
          error: {
            code: event.error.code,
            message: event.error.message
          }
        });
      }

      await this.upsertImagePart(messageId, {
        state: "failed",
        resourceId: resource.id,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: 0,
        mime: "image/png",
        error: {
          code: event.error.code,
          message: event.error.message
        }
      }, runId);
    } else if (event.type === "tool_error" && event.toolCallId) {
      const toolCall = this.ensureToolCallRecord(messageId, event, runId, "running");
      if (toolCall) {
        this.store.updateToolCall(toolCall.id, {
          status: "failed",
          durationMs: event.durationMs,
          error: {
            code: event.error.code,
            message: event.error.message
          }
        });
      }
    }

    this.appendEvent(messageId, event, runId);
  }

  private ensureToolCallRecord(
    messageId: string,
    event: {
      iteration: number;
      toolCallId?: string;
      toolName: string;
      arguments?: JsonObject;
    },
    runId: string | undefined,
    status: AgentToolCallRecord["status"]
  ): AgentToolCallRecord | undefined {
    if (!event.toolCallId) {
      return undefined;
    }

    const existingToolCall = this.store.getToolCallByMessageToolCall(messageId, event.toolCallId);

    if (existingToolCall) {
      return this.store.updateToolCall(existingToolCall.id, { status }) ?? existingToolCall;
    }

    const message = this.store.getMessage(messageId);

    if (!message) {
      return undefined;
    }

    return this.store.createToolCall({
      sessionId: message.sessionId,
      runId,
      messageId,
      iteration: event.iteration,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      arguments: event.arguments ?? {},
      status
    });
  }

  private async appendAssistantTextDelta(messageId: string, delta: string, runId?: string) {
    const message = this.store.getMessage(messageId);

    if (!message) {
      return;
    }

    await this.ensureRunningState(message, runId);
    const result = await this.runningStateStore.appendTextDelta(messageId, delta);

    if (!result) {
      return;
    }

    this.publishTransientEvent(messageId, {
      type: "message.part.delta",
      messageId,
      partIndex: result.partIndex,
      delta,
      version: result.state.version
    }, runId);
  }

  private async withAssistantText(messageId: string, value: string): Promise<MessagePart[]> {
    const parts = await this.getDraftParts(messageId);
    const { parts: ensuredParts, partIndex } = ensureTextPart(parts);

    return ensuredParts.map((part, index) => (index === partIndex && part.type === "text" ? { ...part, value } : part));
  }

  private async setAssistantTextAndEmitUpdate(messageId: string, value: string, runId?: string): Promise<MessagePart[]> {
    const { parts, partIndex } = ensureTextPart(await this.getDraftParts(messageId, runId));
    const nextParts = parts.map((part, index) => (index === partIndex && part.type === "text" ? { ...part, value } : part));
    const { parts: updatedParts, version } = await this.setDraftParts(messageId, nextParts, runId);
    const part = updatedParts[partIndex] ?? nextParts[partIndex];

    if (part) {
      this.appendEvent(messageId, {
        type: "message.part.updated",
        messageId,
        partIndex,
        part,
        version
      }, runId);
    }

    return updatedParts;
  }

  private async upsertImageResultParts(
    messageId: string,
    event: Extract<AgentStreamEvent, { type: "tool_result" }> & { toolName: string; toolCallId: string },
    runId?: string
  ) {
    const toolCall = this.ensureToolCallRecord(messageId, event, runId, "running");
    const assets = extractImageAssets(event.result, 0);
    const failedAssets = extractFailedImageAssets(event.result, 0);

    if (toolCall) {
      this.store.updateToolCall(toolCall.id, {
        status: "succeeded",
        durationMs: event.durationMs,
        resultSummary: compactJsonObject({
          outputCount: assets.length,
          provider: isRecord(event.result) ? event.result.provider : undefined
        })
      });
    }

    for (const asset of failedAssets) {
      const resource = this.upsertImageResource(messageId, {
        status: "failed",
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: asset.index,
        mime: "image/png",
        width: asset.width,
        height: asset.height,
        metadata: buildImageMetadata({
          prompt: asset.prompt,
          width: asset.width,
          height: asset.height,
          sourceImageUrl: toOptionalString(asset.metadata.sourceImageUrl),
          outputIndex: asset.index,
          includeOutputIndex: asset.index > 0,
          provider: asset.metadata.provider,
          error: asset.error
        })
      }, runId);

      await this.upsertImagePart(messageId, {
        state: "failed",
        resourceId: resource.id,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: asset.index,
        mime: "image/png",
        width: asset.width,
        height: asset.height,
        error: asset.error
          ? {
              code: "IMAGE_GENERATION_FAILED",
              message: asset.error
            }
          : undefined
      }, runId);
    }

    for (const asset of assets) {
      const resource = this.upsertImageResource(messageId, {
        status: "succeeded",
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: asset.index ?? 0,
        mime: asset.mimeType ?? "image/png",
        url: asset.url,
        width: asset.width,
        height: asset.height,
        metadata: buildImageMetadata({
          prompt: asset.prompt,
          width: asset.width,
          height: asset.height,
          sourceImageUrl: toOptionalString(asset.metadata.sourceImageUrl),
          outputIndex: asset.index ?? 0,
          includeOutputIndex: (asset.index ?? 0) > 0,
          provider: asset.metadata.provider
        })
      }, runId);

      await this.upsertImagePart(messageId, {
        state: "succeeded",
        resourceId: resource.id,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: asset.index ?? 0,
        mime: asset.mimeType ?? "image/png"
      }, runId);
    }
  }

  private async upsertImagePart(messageId: string, input: GeneratedImagePartInput, runId?: string) {
    const message = this.store.getMessage(messageId);

    if (!message) {
      return;
    }

    const currentParts = await this.getDraftParts(messageId, runId);
    const existingIndex = findGeneratedImagePartIndex(currentParts, input);
    const nextParts = upsertGeneratedImageParts(currentParts, input);
    const partIndex = findGeneratedImagePartIndex(nextParts, input);
    const { parts: updatedParts, version } = await this.setDraftParts(messageId, nextParts, runId);
    const part = updatedParts[partIndex] ?? nextParts[partIndex];

    if (!part || partIndex < 0) {
      return;
    }

    this.appendEvent(messageId, {
      type: existingIndex === -1 ? "message.part.created" : "message.part.updated",
      messageId,
      partIndex,
      part,
      version
    }, runId);
  }

  private upsertImageResource(
    messageId: string,
    input: {
      status: AgentResourceRecord["status"];
      toolCallId: string;
      toolCallRowId?: string;
      outputIndex: number;
      mime?: string;
      url?: string;
      name?: string;
      width?: number;
      height?: number;
      metadata?: JsonObject;
    },
    runId?: string
  ): AgentResourceRecord {
    const message = this.store.getMessage(messageId);

    if (!message) {
      throw new AppError("VALIDATION_ERROR", `未找到助手消息：${messageId}`, 404);
    }

    const existingResource = this.findImageResource(messageId, input.toolCallId, input.outputIndex);

    if (existingResource) {
      const resource =
        this.store.updateResource(existingResource.id, {
          toolCallId: input.toolCallId,
          toolCallRowId: input.toolCallRowId,
          mime: input.mime,
          url: input.url,
          name: input.name,
          status: input.status,
          width: input.width,
          height: input.height,
          metadata: input.metadata ?? existingResource.metadata
        }) ?? existingResource;
      this.appendEvent(messageId, { type: "resource.updated", resource }, runId);
      return resource;
    }

    const reusableFailedResource = this.findReusableFailedImageResource(messageId, input.metadata);

    if (reusableFailedResource) {
      const resource =
        this.store.updateResource(reusableFailedResource.id, {
          toolCallId: input.toolCallId,
          toolCallRowId: input.toolCallRowId,
          mime: input.mime,
          url: input.url,
          name: input.name,
          status: input.status,
          width: input.width,
          height: input.height,
          metadata: input.metadata ?? reusableFailedResource.metadata
        }) ?? reusableFailedResource;
      this.appendEvent(messageId, { type: "resource.updated", resource }, runId);
      return resource;
    }

    const resource = this.store.createResource({
      sessionId: message.sessionId,
      messageId,
      toolCallId: input.toolCallId,
      toolCallRowId: input.toolCallRowId,
      type: "image",
      mime: input.mime,
      url: input.url,
      name: input.name,
      status: input.status,
      width: input.width,
      height: input.height,
      metadata: input.metadata
    });
    this.appendEvent(messageId, { type: "resource.created", resource }, runId);
    return resource;
  }

  private findImageResource(messageId: string, toolCallId: string, outputIndex: number): AgentResourceRecord | undefined {
    const resources = this.store
      .getResourcesByMessages([messageId])
      .filter((resource) => resource.type === "image" && resource.toolCallId === toolCallId);
    const resourceWithOutputIndex = resources.find(
      (resource) => toOptionalNumber(resource.metadata?.outputIndex) === outputIndex
    );

    if (resourceWithOutputIndex) {
      return resourceWithOutputIndex;
    }

    if (outputIndex === 0) {
      return resources.find((resource) => toOptionalNumber(resource.metadata?.outputIndex) === undefined);
    }

    return undefined;
  }

  private findReusableFailedImageResource(messageId: string, metadata?: JsonObject): AgentResourceRecord | undefined {
    const prompt = toOptionalString(metadata?.prompt);
    const sourceImageUrl = toOptionalString(metadata?.sourceImageUrl);

    if (!prompt) {
      return undefined;
    }

    return this.store
      .getResourcesByMessages([messageId])
      .find(
        (resource) =>
          resource.type === "image" &&
          resource.status === "failed" &&
          !resource.url &&
          toOptionalString(resource.metadata?.prompt) === prompt &&
          (!sourceImageUrl || toOptionalString(resource.metadata?.sourceImageUrl) === sourceImageUrl)
      );
  }

  private appendEvent(messageId: string, event: AgentStreamEvent, runId?: string) {
    if (runId) {
      this.store.appendRunEvent(runId, event, messageId);
      return;
    }

    this.store.appendEvent(messageId, event);
  }

  private publishTransientEvent(messageId: string, event: AgentStreamEvent, runId?: string) {
    if (runId) {
      this.store.publishTransientRunEvent(runId, event, messageId);
      return;
    }

    this.store.publishTransientEvent(messageId, event);
  }

  private buildConversationHistory(sessionId: string): AgentMessage[] {
    const summary = this.store.getSessionSummary(sessionId);
    const messageLimit = this.contextBuilder.getHistoryMessageLimit();
    const messages =
      messageLimit === 0
        ? []
        : summary
          ? this.store.getRecentContextMessagesAfter(sessionId, summary.coveredMessageId, messageLimit)
          : this.store.getRecentContextMessagesBySession(sessionId, messageLimit);

    return this.contextBuilder.buildConversationHistory(messages, summary);
  }

  private buildConversationHistoryBefore(sessionId: string, beforeMessageId: string): AgentMessage[] {
    const summary = this.store.getSessionSummaryBeforeMessage(sessionId, beforeMessageId);
    const messageLimit = this.contextBuilder.getHistoryMessageLimit();
    const messages =
      messageLimit === 0
        ? []
        : this.store.getRecentContextMessagesBefore(sessionId, beforeMessageId, summary?.coveredMessageId, messageLimit);

    return this.contextBuilder.buildConversationHistory(messages, summary);
  }

  private async refreshSessionSummaryBeforeAnswer(
    runId: string,
    sessionId: string,
    beforeMessageId: string,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.summaryService) {
      return;
    }

    const previousSummary = this.store.getSessionSummary(sessionId);
    const uncoveredMessageCount = this.store.countContextMessagesBefore(sessionId, beforeMessageId, previousSummary?.coveredMessageId);
    const refreshPlan = this.summaryService.planRefresh(uncoveredMessageCount);

    if (!refreshPlan) {
      return;
    }

    const uncoveredMessages = this.store.getContextMessagesBefore(
      sessionId,
      beforeMessageId,
      previousSummary?.coveredMessageId
    );

    // 条数只说明上下文开始变长；短数字、连续取消这类低信息量内容不值得打断本轮回答去压缩。
    if (!uncoveredMessages.length || !this.summaryService.hasEnoughRefreshContent(uncoveredMessages)) {
      return;
    }

    const messagesToSummarize = uncoveredMessages.slice(0, refreshPlan.messagesToSummarizeLimit);

    if (!messagesToSummarize.length) {
      return;
    }

    const systemMessage = this.store.createMessage({
      sessionId,
      role: "system",
      status: "running",
      parts: [createTextPart("上下文自动压缩中...")]
    });
    const startedAt = Date.now();

    this.store.updateRun(runId, {
      phase: "compressing",
      systemMessageId: systemMessage.id
    });
    this.store.appendRunEvent(runId, { type: "session.message.created", message: systemMessage }, systemMessage.id);
    this.store.appendRunEvent(
      runId,
      {
        type: "summary_start",
        sessionId,
        messageId: systemMessage.id,
        uncoveredMessageCount,
        summarizedMessageCount: messagesToSummarize.length
      },
      systemMessage.id
    );

    try {
      const nextSummary = await this.summaryService.summarizeSessionMessages({
        sessionId,
        messagesToSummarize,
        previousSummary,
        signal
      });

      if (signal.aborted || this.store.getRun(runId)?.status !== "running") {
        throw new DOMException("Aborted", "AbortError");
      }

      if (!nextSummary) {
        return;
      }

      this.store.upsertSessionSummary({
        sessionId,
        summary: nextSummary.summary,
        coveredMessageId: nextSummary.coveredMessageId,
        schemaVersion: nextSummary.schemaVersion
      });
      const completedSystemMessage =
        this.store.updateMessage(systemMessage.id, {
          status: "completed",
          parts: [createTextPart("上下文已自动压缩")],
          completedAt: now()
        }) ?? systemMessage;
      this.store.appendRunEvent(
        runId,
        {
          type: "summary_completed",
          sessionId,
          messageId: systemMessage.id,
          uncoveredMessageCount,
          summarizedMessageCount: messagesToSummarize.length,
          coveredMessageId: nextSummary.coveredMessageId,
          durationMs: Date.now() - startedAt
        },
        systemMessage.id
      );
      this.store.appendRunEvent(
        runId,
        { type: "session.message.updated", message: completedSystemMessage },
        completedSystemMessage.id
      );
    } catch (error) {
      if (isAbortError(error) || signal.aborted || this.store.getRun(runId)?.status === "cancelled") {
        throw error;
      }

      const detail = toErrorDetail(error);
      const failedSystemMessage =
        this.store.updateMessage(systemMessage.id, {
          status: "failed",
          parts: [createTextPart("上下文压缩失败，已继续本轮回答")],
          error: detail,
          completedAt: now()
        }) ?? systemMessage;
      this.store.appendRunEvent(
        runId,
        {
          type: "summary_failed",
          sessionId,
          messageId: systemMessage.id,
          uncoveredMessageCount,
          summarizedMessageCount: messagesToSummarize.length,
          durationMs: Date.now() - startedAt,
          error: detail
        },
        systemMessage.id
      );
      this.store.appendRunEvent(runId, { type: "session.message.updated", message: failedSystemMessage }, failedSystemMessage.id);
    }
  }

  private async refreshSessionSummary(sessionId: string | undefined): Promise<void> {
    if (!sessionId || !this.summaryService) {
      return;
    }

    const previousSummary = this.store.getSessionSummary(sessionId);
    const uncoveredMessageCount = this.store.countContextMessagesAfter(sessionId, previousSummary?.coveredMessageId);
    const refreshPlan = this.summaryService.planRefresh(uncoveredMessageCount);

    if (!refreshPlan) {
      return;
    }

    const uncoveredMessages = this.store.getContextMessagesAfter(
      sessionId,
      previousSummary?.coveredMessageId
    );

    if (!uncoveredMessages.length || !this.summaryService.hasEnoughRefreshContent(uncoveredMessages)) {
      return;
    }

    const messagesToSummarize = uncoveredMessages.slice(0, refreshPlan.messagesToSummarizeLimit);

    if (!messagesToSummarize.length) {
      return;
    }

    try {
      const nextSummary = await this.summaryService.summarizeSessionMessages({
        sessionId,
        messagesToSummarize,
        previousSummary
      });

      if (!nextSummary) {
        return;
      }

      this.store.upsertSessionSummary({
        sessionId,
        summary: nextSummary.summary,
        coveredMessageId: nextSummary.coveredMessageId,
        schemaVersion: nextSummary.schemaVersion
      });
    } catch (error) {
      // 摘要失败不应该影响本轮已经完成的回答；下一轮仍可使用最近原文上下文。
    }
  }

  private getRecentMessagePage(sessionId: string, messageLimit?: number): AgentMessagePage {
    const limit = this.normalizeMessageLimit(messageLimit);
    return this.trimOldestOverflow(this.store.getRecentMessagesBySession(sessionId, limit + 1), limit);
  }

  private withResources(messagePage: AgentMessagePage): AgentMessagePageWithResources {
    return {
      ...messagePage,
      resources: this.getResourcesForMessages(messagePage.messages)
    };
  }

  private getResourcesForMessages(messages: AgentMessageRecord[]): AgentResourceRecord[] {
    return this.store.getResourcesByMessages(messages.map((message) => message.id));
  }

  private trimOldestOverflow(messages: AgentMessageRecord[], limit: number): AgentMessagePage {
    const hasMore = messages.length > limit;
    const pageMessages = hasMore ? messages.slice(1) : messages;

    return {
      messages: pageMessages,
      pageInfo: {
        hasMore,
        oldestCursor: pageMessages[0]?.id,
        limit
      }
    };
  }

  private normalizeMessageLimit(messageLimit?: number): number {
    if (messageLimit === undefined || !Number.isFinite(messageLimit)) {
      return DEFAULT_SESSION_MESSAGE_LIMIT;
    }

    return Math.min(MAX_SESSION_MESSAGE_LIMIT, Math.max(1, Math.floor(messageLimit)));
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

function summarizeToolResult(result: unknown): JsonObject {
  if (!isRecord(result)) {
    return { type: typeof result };
  }

  const imageUrls = toStringArray(result.imageUrls);
  const items = Array.isArray(result.items) ? result.items : undefined;

  return compactJsonObject({
    outputCount: imageUrls.length || items?.length,
    provider: result.provider,
    resultType: result.type
  });
}

function isImageOutputToolName(toolName: string): boolean {
  return IMAGE_OUTPUT_TOOL_NAMES.has(toolName);
}

function isImageToolResultWithId(
  event: AgentStreamEvent
): event is Extract<AgentStreamEvent, { type: "tool_result" }> & { toolName: string; toolCallId: string } {
  return event.type === "tool_result" && isImageOutputToolName(event.toolName) && typeof event.toolCallId === "string";
}

function ensureTextPart(parts: MessagePart[]): { parts: MessagePart[]; partIndex: number } {
  const partIndex = parts.findIndex((part) => part.type === "text");

  if (partIndex !== -1) {
    return { parts, partIndex };
  }

  return { parts: [createTextPart(""), ...parts], partIndex: 0 };
}

function sortStoredEvents(events: StoredAgentEvent[]): StoredAgentEvent[] {
  return [...events].sort((leftEvent, rightEvent) => {
    const createdAtOrder = leftEvent.createdAt.localeCompare(rightEvent.createdAt);

    if (createdAtOrder !== 0) {
      return createdAtOrder;
    }

    return leftEvent.seq - rightEvent.seq;
  });
}

function extractImageRequestSlots(argumentsJson: JsonObject): ImageRequestSlot[] {
  const items = Array.isArray(argumentsJson.items) ? argumentsJson.items.filter(isRecord) : [];

  if (items.length > 0) {
    return items.map((item, index) => ({
      outputIndex: toOptionalNumber(item.index) ?? index,
      prompt: toOptionalString(item.prompt),
      width: toOptionalNumber(item.width),
      height: toOptionalNumber(item.height),
      sourceImageUrl: toOptionalString(item.imageUrl),
      isBatch: true
    }));
  }

  return [
    {
      outputIndex: 0,
      prompt: toOptionalString(argumentsJson.prompt),
      width: toOptionalNumber(argumentsJson.width),
      height: toOptionalNumber(argumentsJson.height),
      sourceImageUrl: toOptionalString(argumentsJson.imageUrl),
      isBatch: false
    }
  ];
}

function buildImageMetadata(input: {
  prompt?: string;
  width?: number;
  height?: number;
  sourceImageUrl?: string;
  outputIndex: number;
  includeOutputIndex: boolean;
  provider?: unknown;
  error?: string;
}): JsonObject {
  return compactJsonObject({
    prompt: input.prompt,
    width: input.width,
    height: input.height,
    sourceImageUrl: input.sourceImageUrl,
    outputIndex: input.includeOutputIndex ? input.outputIndex : undefined,
    provider: input.provider,
    error: input.error
  });
}

function findGeneratedImagePartIndex(parts: MessagePart[], input: GeneratedImagePartInput) {
  return parts.findIndex(
    (part) =>
      part.type === "media" &&
      (part.extra?.resource?.id === input.resourceId ||
        (part.extra?.tool?.toolCallId === input.toolCallId && part.extra.tool.outputIndex === input.outputIndex))
  );
}

function extractFailedImageAssets(result: unknown, startIndex: number): FailedImageResult[] {
  if (!isRecord(result)) {
    return [];
  }

  const resultPrompt = toOptionalString(result.prompt);
  const resultSourceImageUrl = toOptionalString(result.imageUrl);
  const batchItems = Array.isArray(result.items) ? result.items.filter(isRecord) : [];
  let nextIndex = startIndex;

  return batchItems.flatMap((item) => {
    const itemPrompt = toOptionalString(item.prompt) ?? resultPrompt;
    const itemStatus = toOptionalString(item.status);
    const itemError = toOptionalString(item.error);
    const itemIndex = toOptionalNumber(item.index) ?? nextIndex;

    nextIndex = Math.max(nextIndex + 1, itemIndex + 1);

    if (itemStatus !== "failed" && !itemError) {
      return [];
    }

    return [
      {
        width: toOptionalNumber(item.width),
        height: toOptionalNumber(item.height),
        prompt: itemPrompt,
        index: itemIndex,
        error: itemError,
        metadata: compactJsonObject({
          provider: result.provider,
          sourceImageUrl: toOptionalString(item.imageUrl) ?? resultSourceImageUrl,
          size: result.size,
          itemIndex: item.index,
          itemStatus: item.status,
          seed: item.seed,
          taskId: item.taskId
        })
      }
    ];
  });
}

function extractImageAssets(result: unknown, startIndex: number): ExtractedImageResult[] {
  if (!isRecord(result)) {
    return [];
  }

  const resultPrompt = toOptionalString(result.prompt);
  const resultSourceImageUrl = toOptionalString(result.imageUrl);
  const batchItems = Array.isArray(result.items) ? result.items.filter(isRecord) : [];
  let nextIndex = startIndex;

  if (batchItems.length > 0) {
    return batchItems.flatMap((item) => {
      const itemPrompt = toOptionalString(item.prompt) ?? resultPrompt;
      const itemUrls = toStringArray(item.imageUrls);
      const itemIndex = toOptionalNumber(item.index);

      return itemUrls.map((url) => {
        const index = itemIndex ?? nextIndex;
        nextIndex = Math.max(nextIndex + 1, index + 1);

        return {
          url,
          width: toOptionalNumber(item.width),
          height: toOptionalNumber(item.height),
          prompt: itemPrompt,
          index,
          metadata: compactJsonObject({
            provider: result.provider,
            sourceImageUrl: toOptionalString(item.imageUrl) ?? resultSourceImageUrl,
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
      url,
      prompt: resultPrompt,
      index,
      metadata: compactJsonObject({
        provider: result.provider,
        sourceImageUrl: resultSourceImageUrl,
        size: result.size,
        revisedPrompts: result.revisedPrompts
      })
    };
  });
}
