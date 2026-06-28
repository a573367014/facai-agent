import { AppError } from "../errors/app-error.js";
import type { AgentSummaryService } from "./agent-summary-service.js";
import type { AgentService } from "./agent-service.js";
import { AgentContextBuilder } from "./context-builder.js";
import {
  appendTextDelta,
  createTextPart,
  partsToLlmText,
  upsertGeneratedImageParts,
  type GeneratedImagePartInput,
  type MessagePart
} from "./message-parts.js";
import type { AgentErrorDetail, AgentMessage, AgentExecutionInput, AgentStreamEvent, JsonObject } from "./types.js";
import type { AgentEventListener, AgentMessagePage, AgentMessageRecord, AgentRunRecord, AgentStore } from "./agent-store.js";

const DEFAULT_SESSION_MESSAGE_LIMIT = 30;
const MAX_SESSION_MESSAGE_LIMIT = 100;

interface ExtractedImageResult {
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
  prompt?: string;
  index: number;
  metadata: JsonObject;
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
    private readonly summaryService?: AgentSummaryService
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
      pageInfo: messagePage.pageInfo,
      summary: this.store.getSessionSummary(sessionId)
    };
  }

  getSessionMessages(sessionId: string, options: { before?: string; messageLimit?: number } = {}): AgentMessagePage {
    const session = this.store.getSession(sessionId);

    if (!session) {
      throw new AppError("VALIDATION_ERROR", `未找到会话：${sessionId}`, 404);
    }

    if (!options.before) {
      return this.getRecentMessagePage(sessionId, options.messageLimit);
    }

    return this.trimOldestOverflow(
      this.store.getMessagesBefore(sessionId, options.before, this.normalizeMessageLimit(options.messageLimit) + 1),
      this.normalizeMessageLimit(options.messageLimit)
    );
  }

  startMessage(input: AgentExecutionInput & { sessionId?: string }) {
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

  cancelRun(runId: string) {
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
        this.store.appendRunEvent(runId, {
          type: "agent_state",
          iteration: 0,
          state: "done",
          label: "已中断"
        }, assistantMessage.id);
        const cancelledAssistantMessage =
          this.store.updateMessage(assistantMessage.id, {
            status: "cancelled",
            parts: assistantMessage.parts,
            completedAt: timestamp
          }) ?? assistantMessage;
        this.store.appendRunEvent(
          runId,
          { type: "session.message.updated", message: cancelledAssistantMessage },
          cancelledAssistantMessage.id
        );
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

  getRunEvents(runId: string, after = 0) {
    this.ensureRun(runId);
    return this.store.getRunEvents(runId, after);
  }

  subscribeRun(runId: string, listener: AgentEventListener) {
    this.ensureRun(runId);
    return this.store.subscribeRun(runId, listener);
  }

  cancelMessage(messageId: string) {
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
    const cancelledMessage =
      this.store.updateMessage(messageId, {
        status: "cancelled",
        parts: message.parts,
        completedAt: now()
      }) ?? message;
    this.runningMessages.delete(messageId);

    return { message: cancelledMessage };
  }

  getMessage(messageId: string) {
    const message = this.ensureAssistantMessage(messageId);

    return {
      message,
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

  private async executeRun(runId: string, input: AgentExecutionInput) {
    let assistantMessage: AgentMessageRecord | undefined;
    let finalAnswerEvent: Extract<AgentStreamEvent, { type: "final_answer" }> | undefined;

    try {
      if (!input.sessionId || !input.signal || !input.parts?.length) {
        throw new AppError("VALIDATION_ERROR", "run 缺少必要的执行上下文", 400);
      }

      const run = this.ensureRun(runId);
      const userMessageId = run.userMessageId;

      await this.refreshSessionSummaryBeforeAnswer(runId, input.sessionId, userMessageId, input.signal);

      if (input.signal.aborted || this.store.getRun(runId)?.status !== "running") {
        return;
      }

      const history = this.buildConversationHistoryBefore(input.sessionId, userMessageId);

      assistantMessage = this.store.createMessage({
        sessionId: input.sessionId,
        role: "assistant",
        status: "running",
        parts: [createTextPart("")],
        maxIterations: input.maxIterations
      });
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
        onEvent: (event) => {
          if (event.type === "final_answer") {
            finalAnswerEvent = event;
            return;
          }

          this.handleExecutionEvent(assistantMessage!.id, event, runId);
        }
      });

      if (this.store.getMessage(assistantMessage.id)?.status !== "running" || this.store.getRun(runId)?.status !== "running") {
        return;
      }

      this.setAssistantTextAndEmitUpdate(assistantMessage.id, result.answer, runId);
      this.store.appendRunEvent(runId, finalAnswerEvent ?? { type: "final_answer", answer: result.answer }, assistantMessage.id);
      const completedAssistantMessage =
        this.store.updateMessage(assistantMessage.id, {
          status: "completed",
          parts: this.withAssistantText(assistantMessage.id, result.answer),
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
            parts: this.withAssistantText(messageId, "本轮运行失败。"),
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
    }
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
        onEvent: (event) => {
          if (event.type === "final_answer") {
            finalAnswerEvent = event;
            return;
          }

          this.handleExecutionEvent(messageId, event);
        }
      });

      if (this.store.getMessage(messageId)?.status !== "running") {
        return;
      }

      this.setAssistantTextAndEmitUpdate(messageId, result.answer);
      this.store.appendEvent(messageId, finalAnswerEvent ?? { type: "final_answer", answer: result.answer });
      this.store.updateMessage(messageId, {
        status: "completed",
        parts: this.withAssistantText(messageId, result.answer),
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

  private ensureRun(runId: string): AgentRunRecord {
    const run = this.store.getRun(runId);

    if (!run) {
      throw new AppError("VALIDATION_ERROR", `未找到运行：${runId}`, 404);
    }

    return run;
  }

  private handleExecutionEvent(messageId: string, event: AgentStreamEvent, runId?: string) {
    if (event.type === "answer_delta") {
      this.appendAssistantTextDelta(messageId, event.delta, runId);
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
      }, runId);
    }

    if (isGenerateImageToolResultWithId(event)) {
      this.upsertImageResultParts(messageId, event, runId);
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
      }, runId);
    }

    this.appendEvent(messageId, event, runId);
  }

  private appendAssistantTextDelta(messageId: string, delta: string, runId?: string) {
    const message = this.store.getMessage(messageId);

    if (!message) {
      return;
    }

    const { parts, partIndex } = ensureTextPart(message.parts);
    const nextParts = appendTextDelta(parts, partIndex, delta);
    this.store.updateMessageParts(messageId, nextParts);
    this.appendEvent(messageId, {
      type: "message.part.delta",
      messageId,
      partIndex,
      delta
    }, runId);
  }

  private withAssistantText(messageId: string, value: string): MessagePart[] {
    const message = this.store.getMessage(messageId);
    const { parts, partIndex } = ensureTextPart(message?.parts ?? []);

    return parts.map((part, index) => (index === partIndex && part.type === "text" ? { ...part, value } : part));
  }

  private setAssistantTextAndEmitUpdate(messageId: string, value: string, runId?: string): MessagePart[] {
    const message = this.store.getMessage(messageId);

    if (!message) {
      return [];
    }

    const { parts, partIndex } = ensureTextPart(message.parts);
    const nextParts = parts.map((part, index) => (index === partIndex && part.type === "text" ? { ...part, value } : part));
    const updatedMessage = this.store.updateMessageParts(messageId, nextParts);
    const part = updatedMessage?.parts[partIndex] ?? nextParts[partIndex];

    if (part) {
      this.appendEvent(messageId, {
        type: "message.part.updated",
        messageId,
        partIndex,
        part
      }, runId);
    }

    return nextParts;
  }

  private upsertImageResultParts(
    messageId: string,
    event: Extract<AgentStreamEvent, { type: "tool_result" }> & { toolName: "generate_image"; toolCallId: string },
    runId?: string
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
      }, runId);
    }
  }

  private upsertImagePart(messageId: string, input: GeneratedImagePartInput, runId?: string) {
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

    this.appendEvent(messageId, {
      type: existingIndex === -1 ? "message.part.created" : "message.part.updated",
      messageId,
      partIndex,
      part
    }, runId);
  }

  private appendEvent(messageId: string, event: AgentStreamEvent, runId?: string) {
    if (runId) {
      this.store.appendRunEvent(runId, event, messageId);
      return;
    }

    this.store.appendEvent(messageId, event);
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
    const summary = this.store.getSessionSummary(sessionId);
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

function isGenerateImageToolResultWithId(
  event: AgentStreamEvent
): event is Extract<AgentStreamEvent, { type: "tool_result" }> & { toolName: "generate_image"; toolCallId: string } {
  return event.type === "tool_result" && event.toolName === "generate_image" && typeof event.toolCallId === "string";
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

function extractImageAssets(result: unknown, startIndex: number): ExtractedImageResult[] {
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
