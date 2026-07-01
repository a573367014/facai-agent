import { AppError } from "../errors/app-error.js";
import type { AgentSummaryService } from "./agent-summary-service.js";
import type { AgentService } from "./agent-service.js";
import { AgentContextBuilder } from "./context-builder.js";
import {
  createTextPart,
  ensureAppendableTextPart,
  partsToLlmText,
  type MessagePart
} from "./message-parts.js";
import {
  InMemoryRunningMessageStateStore,
  type RunningMessageStateStore
} from "./running-message-state-store.js";
import {
  PassthroughToolResourceStorage,
  type ToolResourceStorage
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
import { toRuntimeDependencyAppError } from "../errors/runtime-dependency-error.js";
import { AgentRunningDraftManager } from "./agent-running-draft-manager.js";
import { AgentProcessStepProjector } from "./agent-process-step-projector.js";
import { AgentMediaOutputProjector } from "./agent-media-output-projector.js";
import {
  isMediaOutputToolName,
  summarizeToolResult,
  uniqueStoredEvents
} from "./agent-message-projection-utils.js";
import { AgentRunCleanupService, type StaleRunningCleanupResult } from "./agent-run-cleanup-service.js";

const DEFAULT_SESSION_MESSAGE_LIMIT = 30;
const DEFAULT_SESSION_PAGE_LIMIT = 30;
const MAX_SESSION_MESSAGE_LIMIT = 100;
const MAX_SESSION_PAGE_LIMIT = 100;

type AgentMessagePageWithResources = AgentMessagePage & {
  resources: AgentResourceRecord[];
  processSteps: AgentProcessStepRecord[];
};

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

  const runtimeDependencyError = toRuntimeDependencyAppError(error);

  if (runtimeDependencyError) {
    return { code: runtimeDependencyError.code, message: runtimeDependencyError.message };
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
  private readonly draftManager: AgentRunningDraftManager;
  private readonly processStepProjector: AgentProcessStepProjector;
  private readonly mediaOutputProjector: AgentMediaOutputProjector;
  private readonly cleanupService: AgentRunCleanupService;

  constructor(
    private readonly agentService: AgentService,
    private readonly store: AgentStore,
    private readonly contextBuilder = new AgentContextBuilder(),
    private readonly summaryService?: AgentSummaryService,
    private readonly runningStateStore: RunningMessageStateStore = new InMemoryRunningMessageStateStore(),
    private readonly resourceStorage: ToolResourceStorage = new PassthroughToolResourceStorage(),
    private readonly options: AgentMessageCoordinatorOptions = {}
  ) {
    // coordinator 保留“主流程编排”：建 run、排队、取消、最终落库。
    // 运行中草稿、进度步骤、媒体资源、重启清理分别交给小类，避免这个文件重新膨胀。
    this.draftManager = new AgentRunningDraftManager(this.store, this.runningStateStore);
    this.processStepProjector = new AgentProcessStepProjector(this.store, (messageId, event, runId) => {
      this.appendEvent(messageId, event, runId);
    });
    this.mediaOutputProjector = new AgentMediaOutputProjector({
      store: this.store,
      resourceStorage: this.resourceStorage,
      draftManager: this.draftManager,
      ensureToolCallRecord: (messageId, event, runId, status) => this.ensureToolCallRecord(messageId, event, runId, status),
      appendEvent: (messageId, event, runId) => this.appendEvent(messageId, event, runId)
    });
    // cleanupService 只处理“服务重启/进程退出导致的悬挂运行”。
    // 正常用户取消仍走 cancelRun，避免两套状态收尾逻辑混在一起。
    this.cleanupService = new AgentRunCleanupService(
      this.store,
      this.draftManager,
      this.processStepProjector,
      (runId, event, messageId) => {
        this.appendRunEvent(runId, event, messageId);
      }
    );
  }

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
    return this.cleanupService.cleanupStaleRunningExecutions(new Set(this.runningRuns.keys()), reason);
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

    for (const run of this.cleanupService.getSessionRunningRuns(sessionId)) {
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
      try {
        await this.draftManager.init(assistantMessage, run.id);
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
      } catch (error) {
        const detail = toErrorDetail(error);
        const failedAssistantMessage =
          this.store.updateMessage(assistantMessage.id, {
            status: "failed",
            parts: [createTextPart(detail.message)],
            error: detail,
            completedAt: now()
          }) ?? assistantMessage;

        this.appendRunEvent(run.id, { type: "session.message.created", message: failedAssistantMessage }, assistantMessage.id);
        this.appendRunEvent(
          run.id,
          {
            type: "error",
            code: detail.code,
            message: detail.message
          },
          assistantMessage.id
        );
        this.store.updateRun(run.id, {
          status: "failed",
          phase: "failed",
          assistantMessageId: assistantMessage.id,
          error: detail,
          completedAt: now()
        });
        try {
          // 如果失败发生在 draft init 之后、enqueue 之前，Redis 里可能已经有运行中草稿。
          // 清理失败不能覆盖真正要返回给用户的运行时依赖错误。
          await this.draftManager.remove(assistantMessage.id);
        } catch {
          // 清理失败不再继续抛出。
        }
        this.runningRuns.delete(run.id);

        throw toRuntimeDependencyAppError(error) ?? error;
      }
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
        const draftMessage = await this.draftManager.withDraft(assistantMessage);
        this.processStepProjector.completeRunning(assistantMessage.id, runId, "cancelled");
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
        await this.draftManager.remove(assistantMessage.id);
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
    const { message, version } = await this.draftManager.getSnapshot(this.ensureAssistantMessage(messageId));

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

      await this.draftManager.ensure(assistantMessage, runId);
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
      this.processStepProjector.completeRunning(assistantMessage.id, runId, "succeeded");
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
        this.processStepProjector.completeRunning(messageId, runId, "failed");
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
        await this.draftManager.remove(assistantMessage.id);
      }
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

    if (event.type === "tool_start" && !(await this.mediaOutputProjector.handleToolStart(messageId, event, runId)) && event.toolCallId) {
      this.ensureToolCallRecord(messageId, event, runId, "running");
    }

    if (event.type === "tool_result" && !(await this.mediaOutputProjector.handleToolResult(messageId, event, runId)) && event.toolCallId) {
      const toolCall = this.ensureToolCallRecord(messageId, event, runId, "running");
      if (toolCall) {
        this.store.updateToolCall(toolCall.id, {
          status: "succeeded",
          durationMs: event.durationMs,
          resultSummary: summarizeToolResult(event.result)
        });
      }
    }

    if (event.type === "tool_error" && !(await this.mediaOutputProjector.handleToolError(messageId, event, runId)) && event.toolCallId) {
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

    this.processStepProjector.project(messageId, event, runId);
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
    const result = await this.draftManager.appendTextDelta(messageId, delta, runId);

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
    const parts = await this.draftManager.getParts(messageId);
    const { parts: ensuredParts, partIndex } = ensureAppendableTextPart(parts);

    return ensuredParts.map((part, index) => (index === partIndex && part.type === "text" ? { ...part, value } : part));
  }

  private async setAssistantTextAndEmitUpdate(messageId: string, value: string, runId?: string): Promise<MessagePart[]> {
    const { parts, partIndex } = ensureAppendableTextPart(await this.draftManager.getParts(messageId, runId));
    const nextParts = parts.map((part, index) => (index === partIndex && part.type === "text" ? { ...part, value } : part));
    const { parts: updatedParts, version } = await this.draftManager.setParts(messageId, nextParts, runId);
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
      // Pub/Sub 是实时推送通道，可靠回放已经写在 SQLite run events。
      // Redis 短暂不可用时不能让这个 best-effort 发布变成未处理 Promise rejection。
      void this.options.eventBus?.publishRunEvent(event.runId, event).catch(() => {});
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

}
