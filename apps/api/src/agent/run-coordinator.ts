import { AppError } from "../errors/app-error.js";
import type { AgentService } from "./agent-service.js";
import { AgentContextBuilder } from "./context-builder.js";
import type { AgentErrorDetail, AgentMessage, AgentRunInput } from "./types.js";
import type { AgentRunEventListener, AgentRunStore } from "./run-store.js";

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

export class AgentRunCoordinator {
  private readonly runningRuns = new Map<string, AbortController>();

  constructor(
    private readonly agentService: AgentService,
    private readonly store: AgentRunStore,
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
      runs: this.store.getRunsBySession(sessionId)
    };
  }

  startRun(input: AgentRunInput & { sessionId?: string }) {
    const session = input.sessionId ? this.getSession(input.sessionId).session : this.store.createSession(input.input.slice(0, 32));
    const history = this.buildConversationHistory(session.id);
    const run = this.store.createRun({
      sessionId: session.id,
      input: input.input,
      maxIterations: input.maxIterations
    });
    const controller = new AbortController();

    this.runningRuns.set(run.id, controller);
    void this.executeRun(run.id, { ...input, history, signal: controller.signal });

    return { session, run };
  }

  cancelRun(runId: string) {
    const run = this.ensureRun(runId);

    if (run.status !== "running") {
      return { run };
    }

    this.runningRuns.get(runId)?.abort();
    this.store.appendEvent(runId, {
      type: "agent_state",
      iteration: 0,
      state: "done",
      label: "已中断"
    });
    this.store.appendEvent(runId, {
      type: "cancelled",
      reason: "用户中断"
    });
    const cancelledRun = this.store.cancelRun(runId) ?? run;
    this.runningRuns.delete(runId);

    return { run: cancelledRun };
  }

  getRun(runId: string) {
    const run = this.store.getRun(runId);

    if (!run) {
      throw new AppError("VALIDATION_ERROR", `未找到运行记录：${runId}`, 404);
    }

    return {
      run,
      events: this.store.getEvents(runId)
    };
  }

  getEvents(runId: string, after = 0) {
    this.ensureRun(runId);
    return this.store.getEvents(runId, after);
  }

  subscribe(runId: string, listener: AgentRunEventListener) {
    this.ensureRun(runId);
    return this.store.subscribe(runId, listener);
  }

  private async executeRun(runId: string, input: AgentRunInput) {
    try {
      const result = await this.agentService.run({
        input: input.input,
        history: input.history,
        maxIterations: input.maxIterations,
        signal: input.signal,
        onEvent: (event) => {
          this.store.appendEvent(runId, event);
        }
      });

      if (this.store.getRun(runId)?.status !== "running") {
        return;
      }

      this.store.completeRun(runId, result);
    } catch (error) {
      if (isAbortError(error) || this.store.getRun(runId)?.status === "cancelled") {
        return;
      }

      const detail = toErrorDetail(error);
      this.store.appendEvent(runId, {
        type: "error",
        code: detail.code,
        message: detail.message
      });
      this.store.failRun(runId, detail);
    } finally {
      this.runningRuns.delete(runId);
    }
  }

  private ensureRun(runId: string) {
    const run = this.store.getRun(runId);

    if (!run) {
      throw new AppError("VALIDATION_ERROR", `未找到运行记录：${runId}`, 404);
    }

    return run;
  }

  private buildConversationHistory(sessionId: string): AgentMessage[] {
    // Coordinator 只关心“什么时候要历史”，不关心“历史怎么裁剪”。
    // 裁剪策略集中在 ContextBuilder，后续加摘要、token 预算或资源引用时不会继续撑大这里。
    return this.contextBuilder.buildConversationHistory(this.store.getRunsBySession(sessionId));
  }
}
