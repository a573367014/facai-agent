import { AppError } from "../errors/app-error.js";
import type { AgentSummaryService } from "./agent-summary-service.js";
import type { AgentService } from "./agent-service.js";
import { AgentContextBuilder } from "./context-builder.js";
import {
  createTextPart,
  ensureAppendableTextPart,
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
import {
  PassthroughToolResourceStorage,
  type StoredToolResource,
  type ToolResourceStorage,
  type ToolResourceType
} from "./tool-resource-storage.js";
import type { AgentErrorDetail, AgentMessage, AgentExecutionInput, AgentStreamEvent, JsonObject, ToolCall } from "./types.js";
import type {
  AgentEventListener,
  AgentMessagePage,
  AgentMessageRecord,
  AgentProcessStepRecord,
  AgentResourceRecord,
  AgentRunRecord,
  AgentSessionPageInfo,
  AgentStore,
  AgentToolCallRecord,
  StoredAgentEvent
} from "./agent-store.js";
import type { AgentRunJobPayload, AgentRunQueue } from "./agent-run-queue.js";
import type { AgentEventBus } from "./agent-event-bus.js";
import type { AgentCancellationStore } from "./agent-cancellation-store.js";
import type { AgentRunLock } from "./agent-run-lock.js";

const DEFAULT_SESSION_MESSAGE_LIMIT = 30;
const DEFAULT_SESSION_PAGE_LIMIT = 30;
const MAX_SESSION_MESSAGE_LIMIT = 100;
const MAX_SESSION_PAGE_LIMIT = 100;
const IMAGE_OUTPUT_TOOL_NAMES = new Set(["generate_image", "edit_image"]);
const VIDEO_OUTPUT_TOOL_NAMES = new Set(["generate_video"]);

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

interface VideoRequestSlot {
  outputIndex: number;
  prompt?: string;
  frames?: number;
  aspectRatio?: string;
}

interface ExtractedVideoResult {
  url: string;
  prompt?: string;
  index: number;
  metadata: JsonObject;
}

type AgentMessagePageWithResources = AgentMessagePage & {
  resources: AgentResourceRecord[];
  processSteps: AgentProcessStepRecord[];
};

interface RunningDraftSnapshot {
  message: AgentMessageRecord;
  version?: number;
}

interface DraftPartsUpdate {
  parts: MessagePart[];
  version?: number;
}

export interface StaleRunningCleanupResult {
  runs: number;
  messages: number;
  toolCalls: number;
  resources: number;
  processSteps: number;
}

export interface AgentMessageCoordinatorOptions {
  runQueue?: AgentRunQueue;
  eventBus?: AgentEventBus;
  cancellationStore?: AgentCancellationStore;
  runLock?: AgentRunLock;
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
  private readonly runningRuns = new Map<string, AbortController>();
  private readonly runningRunExecutions = new Map<string, Promise<void>>();

  constructor(
    private readonly agentService: AgentService,
    private readonly store: AgentStore,
    private readonly contextBuilder = new AgentContextBuilder(),
    private readonly summaryService?: AgentSummaryService,
    private readonly runningStateStore: RunningMessageStateStore = new InMemoryRunningMessageStateStore(),
    private readonly resourceStorage: ToolResourceStorage = new PassthroughToolResourceStorage(),
    private readonly options: AgentMessageCoordinatorOptions = {}
  ) {}

  createSession(title?: string) {
    return this.store.createSession(title);
  }

  listSessions(options: { after?: string; limit?: number } = {}) {
    const limit = this.normalizeSessionLimit(options.limit);
    const sessionsWithOverflow = this.store.listSessions({
      after: options.after,
      limit: limit + 1
    });
    const hasMore = sessionsWithOverflow.length > limit;
    const sessions = hasMore ? sessionsWithOverflow.slice(0, limit) : sessionsWithOverflow;

    return {
      sessions,
      pageInfo: this.createSessionPageInfo(sessions, hasMore, limit)
    };
  }

  async cleanupStaleRunningExecutions(reason = "服务重启后清理遗留运行"): Promise<StaleRunningCleanupResult> {
    const detail: AgentErrorDetail = {
      code: "RUN_INTERRUPTED",
      message: reason
    };
    const result = this.createEmptyCleanupResult();

    for (const run of this.getAllRunningRuns()) {
      if (this.runningRuns.has(run.id)) {
        continue;
      }

      const runResult = await this.failInterruptedRun(run, detail);
      this.addCleanupResult(result, runResult);
    }

    return result;
  }

  async shutdown(reason = "服务关闭") {
    const runIds = [...this.runningRuns.keys()];

    for (const runId of runIds) {
      await this.cancelRun(runId, reason);
    }

    await Promise.allSettled([
      ...runIds.map((runId) => this.runningRunExecutions.get(runId)).filter((execution): execution is Promise<void> => Boolean(execution))
    ]);
  }

  async deleteSession(sessionId: string) {
    const session = this.store.getSession(sessionId);

    if (!session) {
      throw new AppError("VALIDATION_ERROR", `未找到会话：${sessionId}`, 404);
    }

    for (const run of this.getSessionRunningRuns(sessionId)) {
      await this.cancelRun(run.id);
    }

    this.store.deleteSession(sessionId);
    return { session };
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
      processSteps: this.getProcessStepsForMessages(messagePage.messages),
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

  async startRun(input: AgentExecutionInput & { sessionId?: string }) {
    // startRun 是 API 请求的边界：这里只创建“可恢复的任务外壳”，不在请求线程里长时间跑模型。
    // SQLite 先落 user message / run，前端马上拿到 runId；Worker 后面会用这些 id 重新读取最新状态。
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
    this.appendRunEvent(run.id, { type: "session.message.created", message: userMessage }, userMessage.id);

    if (this.options.runQueue) {
      // queue 模式下 assistant message 也提前创建出来。这样 SSE 建连时可以立刻返回
      // message.snapshot；生成中的 parts 则先进 runningStateStore，完成后才写回 SQLite message。
      const assistantMessage = this.store.createMessage({
        sessionId: session.id,
        role: "assistant",
        status: "running",
        parts: [],
        maxIterations: input.maxIterations
      });
      await this.initRunningMessageState(assistantMessage, run.id);
      const queuedRun =
        this.store.updateRun(run.id, {
          phase: "answering",
          assistantMessageId: assistantMessage.id
        }) ?? run;

      this.appendRunEvent(run.id, { type: "session.message.created", message: assistantMessage }, assistantMessage.id);
      // BullMQ job payload 只传 id。真正的 parts、summary、上下文都从 SQLite 现读，
      // 这样可以避免队列里缓存一份已经过期的对话状态。
      await this.options.runQueue.enqueueRun({
        runId: queuedRun.id,
        sessionId: session.id,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id
      });
      this.runningRuns.delete(run.id);

      return {
        run: queuedRun,
        session,
        userMessage
      };
    }

    // 这条分支只用于测试或显式注入无 queue 的场景；产品路径会通过上面的 runQueue 交给 Worker。
    const execution = this.executeRun(run.id, {
      ...input,
      input: userText,
      parts: userParts,
      sessionId: session.id,
      signal: controller.signal
    }).finally(() => {
      this.runningRunExecutions.delete(run.id);
    });

    this.runningRunExecutions.set(run.id, execution);
    void execution;

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
    const replayToolCalls = this.getReplayableMediaToolCalls(sourceAssistantMessage);

    this.runningRuns.set(run.id, controller);
    const execution = this.executeRun(
      run.id,
      {
        input: userText,
        parts: userMessage.parts,
        maxIterations: sourceAssistantMessage.maxIterations,
        replayToolCalls: replayToolCalls.length ? replayToolCalls : undefined,
        sessionId: session.id,
        signal: controller.signal
      },
      {
        history,
        skipSummaryRefresh: true
      }
    ).finally(() => {
      this.runningRunExecutions.delete(run.id);
    });

    this.runningRunExecutions.set(run.id, execution);
    void execution;

    return {
      run,
      session,
      userMessage
    };
  }

  async cancelRun(runId: string, reason = "用户中断") {
    const run = this.ensureRun(runId);

    if (run.status !== "running") {
      return { run };
    }

    // cancelRun 同时处理两件事：
    // 1. 写 Redis cancel key，让其他进程的 Worker 能看到取消；
    // 2. abort 当前进程里的 controller，让同进程执行也能尽快停止。
    await this.options.cancellationStore?.cancelRun(runId);
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
        this.appendRunEvent(runId, { type: "session.message.updated", message: cancelledSystemMessage }, cancelledSystemMessage.id);
      }
    }

    if (run.assistantMessageId) {
      const assistantMessage = this.store.getMessage(run.assistantMessageId);

      if (assistantMessage?.status === "running") {
        const draftMessage = await this.withRunningDraft(assistantMessage);
        this.completeRunningProcessSteps(assistantMessage.id, runId, "cancelled");
        this.appendRunEvent(
          runId,
          {
            type: "agent_state",
            iteration: 0,
            state: "done",
            label: "已中断"
          },
          assistantMessage.id
        );
        const cancelledAssistantMessage =
          this.store.updateMessage(assistantMessage.id, {
            status: "cancelled",
            parts: draftMessage.parts,
            completedAt: timestamp
          }) ?? assistantMessage;
        this.appendRunEvent(
          runId,
          { type: "session.message.updated", message: cancelledAssistantMessage },
          cancelledAssistantMessage.id
        );
        await this.runningStateStore.remove(assistantMessage.id);
      }
    }

    this.appendRunEvent(runId, { type: "cancelled", reason }, run.assistantMessageId ?? run.systemMessageId);
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

  async executeQueuedRun(payload: AgentRunJobPayload) {
    // Worker 的入口。这里不能信任 BullMQ job 一定只投递一次，所以先看 SQLite run 状态，
    // 再抢 Redis run lock。SQLite 状态机是最终防线，Redis lock 是降低重复执行概率。
    const run = this.ensureRun(payload.runId);

    if (run.status !== "running") {
      return this.getRun(run.id);
    }

    if (await this.options.cancellationStore?.isRunCancelled(run.id)) {
      await this.cancelRun(run.id);
      return this.getRun(run.id);
    }

    const lockLease = await this.options.runLock?.acquire(run.id);

    if (this.options.runLock && !lockLease) {
      // 另一个 Worker 已经拿到锁时直接跳过。队列可以重投，但同一时刻只应该有一个执行者。
      return this.getRun(run.id);
    }

    const userMessage = this.ensureMessage(run.userMessageId);
    const assistantMessageId = run.assistantMessageId ?? payload.assistantMessageId;
    const assistantMessage = this.ensureAssistantMessage(assistantMessageId);
    const controller = new AbortController();

    try {
      this.runningRuns.set(run.id, controller);
      await this.executeRun(
        run.id,
        {
          input: partsToLlmText(userMessage.parts),
          parts: userMessage.parts,
          maxIterations: assistantMessage.maxIterations,
          sessionId: run.sessionId,
          signal: controller.signal
        },
        {
          assistantMessageId
        }
      );
    } finally {
      // lock 带 TTL 是崩溃兜底，正常路径仍要主动释放，减少下一次重试等待时间。
      await lockLease?.release();
    }

    return this.getRun(run.id);
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
      events: uniqueStoredEvents([...messageEvents, ...runEvents])
    };
  }

  getRunEvents(runId: string, after = 0) {
    this.ensureRun(runId);
    return this.store.getRunEvents(runId, after);
  }

  async subscribeRun(runId: string, listener: AgentEventListener) {
    this.ensureRun(runId);
    // 本进程 store.subscribeRun 能接到当前 API 进程写入的事件；
    // eventBus.subscribeRun 能接到 Worker 进程通过 Redis Pub/Sub 发布的事件。
    // SSE 同时订阅两边，才兼容测试、单进程和多进程部署。
    const unsubscribeStore = this.store.subscribeRun(runId, listener);
    const unsubscribeEventBus = await this.options.eventBus?.subscribeRun(runId, listener);

    return async () => {
      unsubscribeStore();
      await unsubscribeEventBus?.();
    };
  }

  private createRunExecutionGuard(runId: string, signal?: AbortSignal) {
    let lastCheckedAt = 0;

    return {
      ensureActive: async (options: { force?: boolean } = {}) => {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        const nowMs = Date.now();
        if (!options.force && nowMs - lastCheckedAt < 500) {
          return;
        }

        lastCheckedAt = nowMs;
        const run = this.store.getRun(runId);

        if (!run || run.status !== "running") {
          throw new DOMException("Aborted", "AbortError");
        }

        if (await this.options.cancellationStore?.isRunCancelled(runId)) {
          await this.cancelRun(runId);
          throw new DOMException("Aborted", "AbortError");
        }
      }
    };
  }

  getMessage(messageId: string) {
    const message = this.ensureAssistantMessage(messageId);

    return {
      message,
      resources: this.getResourcesForMessages([message]),
      processSteps: this.getProcessStepsForMessages([message]),
      events: this.store.getEvents(messageId)
    };
  }

  async getMessageSnapshot(messageId: string) {
    const { message, version } = await this.getRunningDraftSnapshot(this.ensureAssistantMessage(messageId));

    return {
      message,
      resources: this.getResourcesForMessages([message]),
      processSteps: this.getProcessStepsForMessages([message]),
      events: this.store.getEvents(messageId),
      version
    };
  }

  private async executeRun(
    runId: string,
    input: AgentExecutionInput,
    options: { history?: AgentMessage[]; skipSummaryRefresh?: boolean; assistantMessageId?: string } = {}
  ) {
    // executeRun 是真正的执行循环：Worker 会走这里，regenerate 的本地执行也走这里。
    // 这里的设计重点是把高频运行态和最终数据分开：
    // - answer_delta / running parts 写 runningStateStore，通常是 Redis；
    // - 工具、资源、最终回答、终态事件写 SQLite；
    // - 写入的 run event 再通过 eventBus 推给 API SSE。
    const runGuard = this.createRunExecutionGuard(runId, input.signal);
    let assistantMessage: AgentMessageRecord | undefined;
    let finalAnswerEvent: Extract<AgentStreamEvent, { type: "final_answer" }> | undefined;

    try {
      if (!input.sessionId || !input.signal || !input.parts?.length) {
        throw new AppError("VALIDATION_ERROR", "run 缺少必要的执行上下文", 400);
      }

      const run = this.ensureRun(runId);
      const userMessageId = run.userMessageId;
      await runGuard.ensureActive({ force: true });

      if (!options.skipSummaryRefresh) {
        // 压缩发生在回答前，并挂在当前 run 上。它可以产生 system message 和 summary events，
        // 但不会走旧的“message 完成后静默摘要”路径。
        await this.refreshSessionSummaryBeforeAnswer(runId, input.sessionId, userMessageId, input.signal);
      }

      await runGuard.ensureActive({ force: true });

      const history = options.history ?? this.buildConversationHistoryBefore(input.sessionId, userMessageId);

      assistantMessage = options.assistantMessageId
        ? this.ensureAssistantMessage(options.assistantMessageId)
        : this.store.createMessage({
            sessionId: input.sessionId,
            role: "assistant",
            status: "running",
            parts: [],
            maxIterations: input.maxIterations
          });

      if (assistantMessage.sessionId !== input.sessionId) {
        throw new AppError("VALIDATION_ERROR", "run 和 assistant message 不属于同一个会话", 400);
      }

      await this.ensureRunningState(assistantMessage, runId);
      this.store.updateRun(runId, {
        phase: "answering",
        assistantMessageId: assistantMessage.id
      });

      if (!options.assistantMessageId) {
        this.appendRunEvent(runId, { type: "session.message.created", message: assistantMessage }, assistantMessage.id);
      }

      const result = await this.agentService.run({
        input: input.input,
        history,
        replayToolCalls: input.replayToolCalls,
        maxIterations: input.maxIterations,
        messageId: assistantMessage.id,
        sessionId: input.sessionId,
        signal: input.signal,
        onEvent: async (event) => {
          // delta 很频繁，检查取消时做节流；关键事件仍强制检查，避免取消后继续落库工具结果。
          await runGuard.ensureActive({ force: event.type !== "answer_delta" });

          if (event.type === "final_answer") {
            finalAnswerEvent = event;
            return;
          }

          await this.handleExecutionEvent(assistantMessage!.id, event, runId);
          await runGuard.ensureActive({ force: false });
        }
      });

      await runGuard.ensureActive({ force: true });

      // 最终答案才写回 SQLite message。这样 SQLite 保存的是可审计的稳定结果，
      // Redis draft 只承担生成过程中的临时状态。
      const finalParts = await this.setAssistantTextAndEmitUpdate(assistantMessage.id, result.answer, runId);
      this.completeRunningProcessSteps(assistantMessage.id, runId, "succeeded");
      this.appendRunEvent(runId, finalAnswerEvent ?? { type: "final_answer", answer: result.answer }, assistantMessage.id);
      const completedAssistantMessage =
        this.store.updateMessage(assistantMessage.id, {
          status: "completed",
          parts: finalParts,
          completedAt: now()
        }) ?? assistantMessage;
      this.appendRunEvent(
        runId,
        { type: "session.message.updated", message: completedAssistantMessage },
        completedAssistantMessage.id
      );
      this.appendRunEvent(runId, { type: "run_completed", messageId: assistantMessage.id }, assistantMessage.id);
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

      this.appendRunEvent(
        runId,
        {
          type: "error",
          code: detail.code,
          message: detail.message
        },
        messageId
      );

      if (messageId) {
        this.completeRunningProcessSteps(messageId, runId, "failed");
        const failedMessage =
          this.store.updateMessage(messageId, {
            status: "failed",
            parts: await this.withAssistantText(messageId, "本轮运行失败。"),
            error: detail,
            completedAt: now()
          }) ?? this.store.getMessage(messageId);

        if (failedMessage) {
          this.appendRunEvent(runId, { type: "session.message.updated", message: failedMessage }, messageId);
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
        // 不论成功、失败还是被取消，run 结束后都清理 draft；最终可恢复状态应来自 SQLite。
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

    // running message 在 SQLite 里只保存“空壳/最终态”，生成中的 parts 在 Redis draft。
    // SSE 建连和详情查询需要合并这两层，前端才能在刷新后看到当前已经生成的内容。
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

  private ensureAssistantMessage(messageId: string) {
    const message = this.ensureMessage(messageId);

    if (message.role !== "assistant") {
      throw new AppError("VALIDATION_ERROR", `未找到助手消息：${messageId}`, 404);
    }

    return message;
  }

  private findInputUserMessageForAssistant(assistantMessage: AgentMessageRecord): AgentMessageRecord | undefined {
    const linkedRun = [...this.store.getRunsByMessageId(assistantMessage.id)]
      .reverse()
      .find((run) => run.assistantMessageId === assistantMessage.id);
    const linkedUserMessage = linkedRun ? this.store.getMessage(linkedRun.userMessageId) : undefined;

    if (linkedUserMessage?.role === "user") {
      return linkedUserMessage;
    }

    const sessionMessages = this.store.getMessagesBySession(assistantMessage.sessionId);
    const assistantIndex = sessionMessages.findIndex((message) => message.id === assistantMessage.id);

    if (assistantIndex <= 0) {
      return undefined;
    }

    return [...sessionMessages.slice(0, assistantIndex)].reverse().find((message) => message.role === "user");
  }

  private getReplayableMediaToolCalls(assistantMessage: AgentMessageRecord): ToolCall[] {
    return this.store
      .getToolCallsBySession(assistantMessage.sessionId)
      .filter((toolCall) => toolCall.messageId === assistantMessage.id && isMediaOutputToolName(toolCall.toolName))
      .sort((leftToolCall, rightToolCall) => {
        const iterationOrder = leftToolCall.iteration - rightToolCall.iteration;
        return iterationOrder || leftToolCall.startedAt.localeCompare(rightToolCall.startedAt);
      })
      .map((toolCall) => ({
        id: toolCall.toolCallId ?? toolCall.id,
        name: toolCall.toolName,
        arguments: toolCall.arguments
      }));
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
          mime: "image/png",
          name: slot.prompt,
          width: slot.width,
          height: slot.height,
          generation: compactJsonObject({
            prompt: slot.prompt
          })
        }, runId);
      }
    } else if (event.type === "tool_start" && isVideoOutputToolName(event.toolName) && event.toolCallId) {
      const toolCall = this.ensureToolCallRecord(messageId, event, runId, "running");
      const videoSlot = extractVideoRequestSlot(event.arguments);
      const resource = this.upsertImageResource(messageId, {
        type: "video",
        status: "pending",
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: videoSlot.outputIndex,
        mime: "video/mp4",
        metadata: buildVideoMetadata({
          prompt: videoSlot.prompt,
          frames: videoSlot.frames,
          aspectRatio: videoSlot.aspectRatio
        })
      }, runId);

      await this.upsertImagePart(messageId, {
        state: "pending",
        resourceId: resource.id,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: videoSlot.outputIndex,
        mime: "video/mp4",
        name: videoSlot.prompt,
        generation: compactJsonObject({
          prompt: videoSlot.prompt
        })
      }, runId);
    } else if (event.type === "tool_start" && event.toolCallId) {
      this.ensureToolCallRecord(messageId, event, runId, "running");
    }

    if (isImageToolResultWithId(event)) {
      await this.upsertImageResultParts(messageId, event, runId);
    } else if (isVideoToolResultWithId(event)) {
      await this.upsertVideoResultParts(messageId, event, runId);
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
    } else if (event.type === "tool_error" && isVideoOutputToolName(event.toolName) && event.toolCallId) {
      const toolCall = this.ensureToolCallRecord(messageId, event, runId, "running");
      const resource = this.upsertImageResource(messageId, {
        type: "video",
        status: "failed",
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: 0,
        mime: "video/mp4",
        metadata: compactJsonObject({
          prompt: toOptionalString(toolCall?.arguments.prompt),
          frames: toOptionalNumber(toolCall?.arguments.frames),
          aspectRatio: toOptionalString(toolCall?.arguments.aspectRatio),
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
        mime: "video/mp4",
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

    this.projectProcessStep(messageId, event, runId);
    this.appendEvent(messageId, event, runId);
  }

  private projectProcessStep(messageId: string, event: AgentStreamEvent, runId?: string) {
    if (event.type === "agent_state" && event.state === "thinking") {
      if (!this.findProcessStep(messageId, (step) => step.kind === "thinking" && step.metadata?.phase === "thinking")) {
        this.createProcessStep(messageId, runId, {
          kind: "thinking",
          title: "正在理解需求",
          summary: event.label,
          status: "running",
          metadata: { phase: "thinking", iteration: event.iteration }
        });
      }
      return;
    }

    if (event.type === "llm_response") {
      const thinkingStep = this.findProcessStep(messageId, (step) => step.kind === "thinking" && step.metadata?.phase === "thinking");

      if (thinkingStep?.status === "running") {
        const toolCallCount = event.toolCalls?.length ?? 0;
        this.updateProcessStep(messageId, thinkingStep.id, runId, {
          title: toolCallCount > 0 ? "已理解需求" : "已生成回答",
          summary: toolCallCount > 0 ? `需要执行 ${toolCallCount} 项任务` : "回答已生成",
          status: "succeeded",
          metadata: compactJsonObject({
            ...thinkingStep.metadata,
            toolCallCount
          })
        });
      }
      return;
    }

    if (event.type === "agent_state" && event.state === "answering") {
      const hasToolStep = Boolean(this.findProcessStep(messageId, (step) => step.kind === "tool"));

      if (!hasToolStep) {
        return;
      }

      if (!this.findProcessStep(messageId, (step) => step.kind === "summary" && step.metadata?.phase === "answering")) {
        this.createProcessStep(messageId, runId, {
          kind: "summary",
          title: "正在整理回答",
          summary: "整合执行结果",
          status: "running",
          metadata: { phase: "answering", iteration: event.iteration }
        });
      }
      return;
    }

    if (event.type === "tool_start") {
      const toolCall = event.toolCallId ? this.store.getToolCallByMessageToolCall(messageId, event.toolCallId) : undefined;
      const existingStep = event.toolCallId
        ? this.findProcessStep(messageId, (step) => step.kind === "tool" && step.toolCallId === event.toolCallId)
        : undefined;
      const summary = getPrimaryToolArgumentSummary(event.arguments);
      const labels = getToolProcessLabels(event.toolName);
      const metadata = compactJsonObject({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        ...event.arguments
      });

      if (existingStep) {
        this.updateProcessStep(messageId, existingStep.id, runId, {
          toolCallRowId: toolCall?.id,
          toolCallId: event.toolCallId,
          title: labels.running,
          summary,
          status: "running",
          metadata
        });
        return;
      }

      this.createProcessStep(messageId, runId, {
        kind: "tool",
        toolCallRowId: toolCall?.id,
        toolCallId: event.toolCallId,
        title: labels.running,
        summary,
        status: "running",
        metadata
      });
      return;
    }

    if (event.type === "tool_result" && event.toolCallId) {
      const toolCall = this.store.getToolCallByMessageToolCall(messageId, event.toolCallId);
      const existingStep = this.findProcessStep(messageId, (step) => step.kind === "tool" && step.toolCallId === event.toolCallId);
      const labels = getToolProcessLabels(event.toolName);

      if (existingStep) {
        this.updateProcessStep(messageId, existingStep.id, runId, {
          toolCallRowId: toolCall?.id,
          title: labels.succeeded,
          summary: event.durationMs !== undefined ? `耗时 ${formatDuration(event.durationMs)}` : existingStep.summary,
          status: "succeeded",
          metadata: compactJsonObject({
            ...existingStep.metadata,
            durationMs: event.durationMs,
            result: summarizeToolResult(event.result)
          })
        });
      }
      return;
    }

    if (event.type === "tool_error" && event.toolCallId) {
      const toolCall = this.store.getToolCallByMessageToolCall(messageId, event.toolCallId);
      const existingStep = this.findProcessStep(messageId, (step) => step.kind === "tool" && step.toolCallId === event.toolCallId);
      const labels = getToolProcessLabels(event.toolName);

      if (existingStep) {
        this.updateProcessStep(messageId, existingStep.id, runId, {
          toolCallRowId: toolCall?.id,
          title: labels.failed,
          summary: event.error.message,
          status: "failed",
          metadata: compactJsonObject({
            ...existingStep.metadata,
            durationMs: event.durationMs,
            error: event.error
          })
        });
      }
      return;
    }

    if (event.type === "error") {
      this.completeRunningProcessSteps(messageId, runId, "failed");
      return;
    }

    if (event.type === "cancelled") {
      this.completeRunningProcessSteps(messageId, runId, "cancelled");
    }
  }

  private createProcessStep(
    messageId: string,
    runId: string | undefined,
    input: {
      kind: AgentProcessStepRecord["kind"];
      toolCallRowId?: string;
      toolCallId?: string;
      title: string;
      summary?: string;
      status: AgentProcessStepRecord["status"];
      metadata?: JsonObject;
    }
  ): AgentProcessStepRecord | undefined {
    const message = this.store.getMessage(messageId);

    if (!message) {
      return undefined;
    }

    const step = this.store.createProcessStep({
      sessionId: message.sessionId,
      runId,
      messageId,
      toolCallRowId: input.toolCallRowId,
      toolCallId: input.toolCallId,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      status: input.status,
      orderIndex: this.getNextProcessStepOrderIndex(messageId),
      metadata: input.metadata
    });
    this.appendEvent(messageId, { type: "process.step.created", step }, runId);
    return step;
  }

  private updateProcessStep(
    messageId: string,
    stepId: string,
    runId: string | undefined,
    input: {
      toolCallRowId?: string;
      toolCallId?: string;
      title?: string;
      summary?: string;
      status?: AgentProcessStepRecord["status"];
      metadata?: JsonObject;
    }
  ): AgentProcessStepRecord | undefined {
    const step = this.store.updateProcessStep(stepId, input);

    if (!step) {
      return undefined;
    }

    this.appendEvent(messageId, { type: "process.step.updated", step }, runId);
    return step;
  }

  private completeRunningProcessSteps(messageId: string, runId: string | undefined, status: AgentProcessStepRecord["status"]) {
    for (const step of this.store.getProcessStepsByMessages([messageId])) {
      if (step.status !== "running") {
        continue;
      }

      this.updateProcessStep(messageId, step.id, runId, {
        ...getProcessStepCompletionPatch(step, status),
        status
      });
    }
  }

  private findProcessStep(messageId: string, predicate: (step: AgentProcessStepRecord) => boolean): AgentProcessStepRecord | undefined {
    return this.store.getProcessStepsByMessages([messageId]).find(predicate);
  }

  private getNextProcessStepOrderIndex(messageId: string) {
    const steps = this.store.getProcessStepsByMessages([messageId]);
    const maxOrderIndex = Math.max(-1, ...steps.map((step) => step.orderIndex));
    return maxOrderIndex + 1;
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
    const { parts: ensuredParts, partIndex } = ensureAppendableTextPart(parts);

    return ensuredParts.map((part, index) => (index === partIndex && part.type === "text" ? { ...part, value } : part));
  }

  private async setAssistantTextAndEmitUpdate(messageId: string, value: string, runId?: string): Promise<MessagePart[]> {
    const { parts, partIndex } = ensureAppendableTextPart(await this.getDraftParts(messageId, runId));
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
        name: asset.prompt,
        width: asset.width,
        height: asset.height,
        generation: compactJsonObject({
          prompt: asset.prompt,
          provider: asset.metadata.provider
        }),
        error: asset.error
          ? {
              code: "IMAGE_GENERATION_FAILED",
              message: asset.error
            }
          : undefined
      }, runId);
    }

    for (const asset of assets) {
      const storedAsset = await this.storeToolResource(messageId, runId, {
        type: "image",
        url: asset.url,
        mime: asset.mimeType ?? "image/png",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: asset.index ?? 0,
        prompt: asset.prompt,
        width: asset.width,
        height: asset.height,
        generation: compactJsonObject({
          prompt: asset.prompt,
          provider: asset.metadata.provider
        }),
        metadata: buildImageMetadata({
          prompt: asset.prompt,
          width: asset.width,
          height: asset.height,
          sourceImageUrl: toOptionalString(asset.metadata.sourceImageUrl),
          outputIndex: asset.index ?? 0,
          includeOutputIndex: (asset.index ?? 0) > 0,
          provider: asset.metadata.provider
        })
      });

      if (!storedAsset) {
        continue;
      }

      const resource = this.upsertImageResource(messageId, {
        status: "succeeded",
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: asset.index ?? 0,
        mime: storedAsset.mime ?? asset.mimeType ?? "image/png",
        url: storedAsset.url,
        name: storedAsset.name,
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
        mime: storedAsset.mime ?? asset.mimeType ?? "image/png",
        url: storedAsset.url,
        name: asset.prompt,
        width: asset.width,
        height: asset.height,
        generation: compactJsonObject({
          prompt: asset.prompt,
          provider: asset.metadata.provider
        })
      }, runId);
    }
  }

  private async upsertVideoResultParts(
    messageId: string,
    event: Extract<AgentStreamEvent, { type: "tool_result" }> & { toolName: string; toolCallId: string },
    runId?: string
  ) {
    const toolCall = this.ensureToolCallRecord(messageId, event, runId, "running");
    const assets = extractVideoAssets(event.result, 0);

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

    for (const asset of assets) {
      const storedAsset = await this.storeToolResource(messageId, runId, {
        type: "video",
        url: asset.url,
        mime: "video/mp4",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: asset.index,
        prompt: asset.prompt,
        generation: compactJsonObject({
          prompt: asset.prompt,
          provider: asset.metadata.provider
        }),
        metadata: buildVideoMetadata({
          prompt: asset.prompt,
          frames: toOptionalNumber(asset.metadata.frames),
          aspectRatio: toOptionalString(asset.metadata.aspectRatio),
          provider: asset.metadata.provider,
          taskId: asset.metadata.taskId
        })
      });

      if (!storedAsset) {
        continue;
      }

      const resource = this.upsertImageResource(messageId, {
        type: "video",
        status: "succeeded",
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: asset.index,
        mime: storedAsset.mime ?? "video/mp4",
        url: storedAsset.url,
        name: storedAsset.name,
        metadata: buildVideoMetadata({
          prompt: asset.prompt,
          frames: toOptionalNumber(asset.metadata.frames),
          aspectRatio: toOptionalString(asset.metadata.aspectRatio),
          provider: asset.metadata.provider,
          taskId: asset.metadata.taskId
        })
      }, runId);

      await this.upsertImagePart(messageId, {
        state: "succeeded",
        resourceId: resource.id,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: asset.index,
        mime: storedAsset.mime ?? "video/mp4",
        url: storedAsset.url,
        name: asset.prompt,
        generation: compactJsonObject({
          prompt: asset.prompt,
          provider: asset.metadata.provider
        })
      }, runId);
    }
  }

  private async storeToolResource(
    messageId: string,
    runId: string | undefined,
    input: {
      type: ToolResourceType;
      url: string;
      mime?: string;
      toolName: string;
      toolCallId: string;
      toolCallRowId?: string;
      outputIndex: number;
      prompt?: string;
      width?: number;
      height?: number;
      generation?: JsonObject;
      metadata: JsonObject;
    }
  ): Promise<StoredToolResource | undefined> {
    try {
      return await this.resourceStorage.storeRemoteResource({
        url: input.url,
        type: input.type,
        mime: input.mime
      });
    } catch (error) {
      const detail = toErrorDetail(error);
      const mime = input.mime ?? (input.type === "video" ? "video/mp4" : "image/png");
      const resource = this.upsertImageResource(messageId, {
        type: input.type,
        status: "failed",
        toolCallId: input.toolCallId,
        toolCallRowId: input.toolCallRowId,
        outputIndex: input.outputIndex,
        mime,
        width: input.width,
        height: input.height,
        metadata: compactJsonObject({
          ...input.metadata,
          error: {
            code: detail.code,
            message: `资源转储失败：${detail.message}`
          }
        })
      }, runId);

      await this.upsertImagePart(messageId, {
        state: "failed",
        resourceId: resource.id,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        toolCallRowId: input.toolCallRowId,
        outputIndex: input.outputIndex,
        mime,
        name: input.prompt,
        width: input.width,
        height: input.height,
        generation: input.generation,
        error: {
          code: detail.code,
          message: `资源转储失败：${detail.message}`
        }
      }, runId);

      return undefined;
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
      type?: "image" | "video";
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

    const resourceType = input.type ?? "image";
    const existingResource = this.findImageResource(messageId, input.toolCallId, input.outputIndex, resourceType);

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

    const reusableFailedResource =
      resourceType === "image" ? this.findReusableFailedImageResource(messageId, input.metadata) : undefined;

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
      type: resourceType,
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

  private findImageResource(
    messageId: string,
    toolCallId: string,
    outputIndex: number,
    resourceType = "image"
  ): AgentResourceRecord | undefined {
    const resources = this.store
      .getResourcesByMessages([messageId])
      .filter((resource) => resource.type === resourceType && resource.toolCallId === toolCallId);
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
    if (!runId) {
      throw new Error("执行事件必须关联 run");
    }

    this.appendRunEvent(runId, event, messageId);
  }

  private appendRunEvent(runId: string, event: AgentStreamEvent, messageId?: string): StoredAgentEvent | undefined {
    // 持久化事件先写 SQLite，保证刷新和断线重连有短期回放；随后再发布到 Redis Pub/Sub 做实时推送。
    const storedEvent = this.store.appendRunEvent(runId, event, messageId);

    if (storedEvent) {
      this.publishStoredEvent(storedEvent);
    }

    return storedEvent;
  }

  private publishTransientEvent(messageId: string, event: AgentStreamEvent, runId?: string) {
    if (!runId) {
      throw new Error("临时执行事件必须关联 run");
    }

    // transient event 不进入 SQLite，只通过本进程订阅和 Redis Pub/Sub 推给在线 SSE。
    // 典型例子是 message.part.delta：它太高频，完整 draft 已经在 Redis running state 里。
    const storedEvent = this.store.publishTransientRunEvent(runId, event, messageId);

    if (storedEvent) {
      this.publishStoredEvent(storedEvent);
    }
  }

  private publishStoredEvent(event: StoredAgentEvent) {
    if (event.runId) {
      void this.options.eventBus?.publishRunEvent(event.runId, event);
    }
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
    this.appendRunEvent(runId, { type: "session.message.created", message: systemMessage }, systemMessage.id);
    this.appendRunEvent(
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
      this.appendRunEvent(
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
      this.appendRunEvent(
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
      this.appendRunEvent(
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
      this.appendRunEvent(runId, { type: "session.message.updated", message: failedSystemMessage }, failedSystemMessage.id);
    }
  }

  private getRecentMessagePage(sessionId: string, messageLimit?: number): AgentMessagePage {
    const limit = this.normalizeMessageLimit(messageLimit);
    return this.trimOldestOverflow(this.store.getRecentMessagesBySession(sessionId, limit + 1), limit);
  }

  private withResources(messagePage: AgentMessagePage): AgentMessagePageWithResources {
    return {
      ...messagePage,
      resources: this.getResourcesForMessages(messagePage.messages),
      processSteps: this.getProcessStepsForMessages(messagePage.messages)
    };
  }

  private getResourcesForMessages(messages: AgentMessageRecord[]): AgentResourceRecord[] {
    return this.store.getResourcesByMessages(messages.map((message) => message.id));
  }

  private getProcessStepsForMessages(messages: AgentMessageRecord[]): AgentProcessStepRecord[] {
    return this.store.getProcessStepsByMessages(messages.map((message) => message.id));
  }

  private trimOldestOverflow(messages: AgentMessageRecord[], limit: number): AgentMessagePage {
    const hasMore = messages.length > limit;
    const pageMessages = hasMore ? messages.slice(1) : messages;

    return {
      messages: pageMessages,
      pageInfo: {
        hasMore,
        ...(hasMore ? { nextCursor: pageMessages[0]?.id } : {}),
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

  private normalizeSessionLimit(sessionLimit?: number): number {
    if (sessionLimit === undefined || !Number.isFinite(sessionLimit)) {
      return DEFAULT_SESSION_PAGE_LIMIT;
    }

    return Math.min(MAX_SESSION_PAGE_LIMIT, Math.max(1, Math.floor(sessionLimit)));
  }

  private createSessionPageInfo(
    sessions: Array<{ id: string }>,
    hasMore: boolean,
    limit: number
  ): AgentSessionPageInfo {
    return {
      hasMore,
      ...(hasMore ? { nextCursor: sessions.at(-1)?.id } : {}),
      limit
    };
  }

  private async failInterruptedRun(run: AgentRunRecord, detail: AgentErrorDetail): Promise<StaleRunningCleanupResult> {
    const result = this.createEmptyCleanupResult();
    const messageIds = [run.systemMessageId, run.assistantMessageId].filter((messageId): messageId is string => Boolean(messageId));

    for (const messageId of messageIds) {
      const message = this.store.getMessage(messageId);

      if (message?.status !== "running") {
        continue;
      }

      const messageResult = await this.failInterruptedMessage(message, run.id, detail);
      this.addCleanupResult(result, messageResult);
    }

    this.appendRunEvent(
      run.id,
      {
        type: "error",
        code: detail.code,
        message: detail.message
      },
      run.assistantMessageId ?? run.systemMessageId
    );
    this.store.updateRun(run.id, {
      status: "failed",
      phase: "failed",
      error: detail,
      completedAt: now()
    });
    result.runs += 1;
    return result;
  }

  private async failInterruptedMessage(
    message: AgentMessageRecord,
    runId: string,
    detail: AgentErrorDetail
  ): Promise<StaleRunningCleanupResult> {
    const result = this.createEmptyCleanupResult();
    const runningSteps = this.store
      .getProcessStepsByMessages([message.id])
      .filter((step) => step.status === "running" && step.runId === runId);

    this.completeRunningProcessSteps(message.id, runId, "failed");
    result.processSteps += runningSteps.length;
    result.toolCalls += this.failInterruptedToolCalls(message, runId, detail);
    result.resources += this.failInterruptedResources(message, detail);

    const failedMessage =
      this.store.updateMessage(message.id, {
        status: "failed",
        parts: [createTextPart("本轮运行因服务重启中断，请重新生成。")],
        error: detail,
        completedAt: now()
      }) ?? message;

    this.appendRunEvent(runId, { type: "session.message.updated", message: failedMessage }, message.id);

    await this.runningStateStore.remove(message.id);
    result.messages += 1;
    return result;
  }

  private failInterruptedToolCalls(message: AgentMessageRecord, runId: string, detail: AgentErrorDetail): number {
    const toolCalls = this.store
      .getToolCallsBySession(message.sessionId)
      .filter(
        (toolCall) =>
          toolCall.messageId === message.id &&
          toolCall.runId === runId &&
          (toolCall.status === "pending" || toolCall.status === "running")
      );

    for (const toolCall of toolCalls) {
      this.store.updateToolCall(toolCall.id, {
        status: "failed",
        error: detail,
        completedAt: now()
      });
    }

    return toolCalls.length;
  }

  private failInterruptedResources(message: AgentMessageRecord, detail: AgentErrorDetail): number {
    const resources = this.store
      .getResourcesByMessages([message.id])
      .filter((resource) => resource.status === "pending");

    for (const resource of resources) {
      this.store.updateResource(resource.id, {
        status: "failed",
        metadata: compactJsonObject({
          ...(resource.metadata ?? {}),
          error: detail
        })
      });
    }

    return resources.length;
  }

  private getAllRunningRuns(): AgentRunRecord[] {
    const runsById = new Map<string, AgentRunRecord>();

    for (const session of this.store.listSessions()) {
      for (const message of this.store.getMessagesBySession(session.id)) {
        for (const run of this.store.getRunsByMessageId(message.id)) {
          if (run.status === "running") {
            runsById.set(run.id, run);
          }
        }
      }
    }

    return [...runsById.values()];
  }

  private createEmptyCleanupResult(): StaleRunningCleanupResult {
    return {
      runs: 0,
      messages: 0,
      toolCalls: 0,
      resources: 0,
      processSteps: 0
    };
  }

  private addCleanupResult(target: StaleRunningCleanupResult, source: StaleRunningCleanupResult) {
    target.runs += source.runs;
    target.messages += source.messages;
    target.toolCalls += source.toolCalls;
    target.resources += source.resources;
    target.processSteps += source.processSteps;
  }

  private getSessionRunningRuns(sessionId: string): AgentRunRecord[] {
    const runsById = new Map<string, AgentRunRecord>();

    for (const message of this.store.getMessagesBySession(sessionId)) {
      for (const run of this.store.getRunsByMessageId(message.id)) {
        if (run.status === "running") {
          runsById.set(run.id, run);
        }
      }
    }

    return [...runsById.values()];
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

function getToolProcessLabels(toolName: string) {
  switch (toolName) {
    case "generate_image":
      return {
        running: "正在生成图片",
        succeeded: "图片已生成",
        failed: "图片生成失败"
      };
    case "edit_image":
      return {
        running: "正在编辑图片",
        succeeded: "图片已编辑",
        failed: "图片编辑失败"
      };
    case "generate_video":
      return {
        running: "正在生成视频",
        succeeded: "视频已生成",
        failed: "视频生成失败"
      };
    case "web_search":
      return {
        running: "正在查找资料",
        succeeded: "资料已查找",
        failed: "资料查找失败"
      };
    case "current_time":
      return {
        running: "正在查询时间",
        succeeded: "时间已查询",
        failed: "时间查询失败"
      };
    case "calculator":
      return {
        running: "正在计算",
        succeeded: "计算完成",
        failed: "计算失败"
      };
    default:
      return {
        running: "正在执行任务",
        succeeded: "任务已完成",
        failed: "任务失败"
      };
  }
}

function getProcessStepCompletionPatch(
  step: AgentProcessStepRecord,
  status: AgentProcessStepRecord["status"]
): Pick<Parameters<AgentStore["updateProcessStep"]>[1], "title" | "summary"> {
  if (step.metadata?.phase === "answering") {
    if (status === "succeeded") {
      return { title: "已整理回答", summary: "回答已生成" };
    }

    if (status === "failed") {
      return { title: "整理回答失败" };
    }

    if (status === "cancelled") {
      return { title: "已中断整理回答" };
    }
  }

  return {};
}

function getPrimaryToolArgumentSummary(argumentsValue: JsonObject = {}): string | undefined {
  const candidates = ["query", "prompt", "expression", "url"];

  for (const key of candidates) {
    const value = argumentsValue[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function formatDuration(durationMs: number) {
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }

  return `${durationMs}ms`;
}

function summarizeToolResult(result: unknown): JsonObject {
  if (!isRecord(result)) {
    return { type: typeof result };
  }

  const imageUrls = toStringArray(result.imageUrls);
  const videoUrls = toStringArray(result.videoUrls);
  const items = Array.isArray(result.items) ? result.items : undefined;

  return compactJsonObject({
    outputCount: imageUrls.length || videoUrls.length || items?.length,
    provider: result.provider,
    resultType: result.type
  });
}

function isImageOutputToolName(toolName: string): boolean {
  return IMAGE_OUTPUT_TOOL_NAMES.has(toolName);
}

function isVideoOutputToolName(toolName: string): boolean {
  return VIDEO_OUTPUT_TOOL_NAMES.has(toolName);
}

function isMediaOutputToolName(toolName: string): boolean {
  return isImageOutputToolName(toolName) || isVideoOutputToolName(toolName);
}

function isImageToolResultWithId(
  event: AgentStreamEvent
): event is Extract<AgentStreamEvent, { type: "tool_result" }> & { toolName: string; toolCallId: string } {
  return event.type === "tool_result" && isImageOutputToolName(event.toolName) && typeof event.toolCallId === "string";
}

function isVideoToolResultWithId(
  event: AgentStreamEvent
): event is Extract<AgentStreamEvent, { type: "tool_result" }> & { toolName: string; toolCallId: string } {
  return event.type === "tool_result" && isVideoOutputToolName(event.toolName) && typeof event.toolCallId === "string";
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

function uniqueStoredEvents(events: StoredAgentEvent[]): StoredAgentEvent[] {
  return sortStoredEvents([...new Map(events.map((event) => [event.id, event])).values()]);
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

function extractVideoRequestSlot(argumentsJson: JsonObject): VideoRequestSlot {
  return {
    outputIndex: 0,
    prompt: toOptionalString(argumentsJson.prompt),
    frames: toOptionalNumber(argumentsJson.frames),
    aspectRatio: toOptionalString(argumentsJson.aspectRatio)
  };
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

function buildVideoMetadata(input: {
  prompt?: string;
  frames?: number;
  aspectRatio?: string;
  provider?: unknown;
  taskId?: unknown;
  error?: unknown;
}): JsonObject {
  return compactJsonObject({
    prompt: input.prompt,
    frames: input.frames,
    aspectRatio: input.aspectRatio,
    provider: input.provider,
    taskId: input.taskId,
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

function extractVideoAssets(result: unknown, startIndex: number): ExtractedVideoResult[] {
  if (!isRecord(result)) {
    return [];
  }

  let nextIndex = startIndex;

  return toStringArray(result.videoUrls).map((url) => {
    const index = nextIndex;
    nextIndex += 1;

    return {
      url,
      prompt: toOptionalString(result.prompt),
      index,
      metadata: compactJsonObject({
        provider: result.provider,
        frames: result.frames,
        aspectRatio: result.aspectRatio,
        seed: result.seed,
        taskId: result.taskId
      })
    };
  });
}
