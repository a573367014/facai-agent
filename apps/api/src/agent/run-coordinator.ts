import { AppError } from "../errors/app-error.js";
import type { AgentService } from "./agent-service.js";
import type { AgentErrorDetail, AgentMessage, AgentRunInput } from "./types.js";
import type { AgentRunEventListener } from "./run-store.js";
import { InMemoryAgentRunStore } from "./run-store.js";

function toErrorDetail(error: unknown): AgentErrorDetail {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }

  return {
    code: "PROVIDER_ERROR",
    message: error instanceof Error ? error.message : "发生未知错误"
  };
}

export class AgentRunCoordinator {
  constructor(
    private readonly agentService: AgentService,
    private readonly store: InMemoryAgentRunStore
  ) {}

  createSession(title?: string) {
    return this.store.createSession(title);
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

    void this.executeRun(run.id, { ...input, history });

    return { session, run };
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
        onEvent: (event) => {
          this.store.appendEvent(runId, event);
        }
      });

      this.store.completeRun(runId, result);
    } catch (error) {
      const detail = toErrorDetail(error);
      this.store.appendEvent(runId, {
        type: "error",
        code: detail.code,
        message: detail.message
      });
      this.store.failRun(runId, detail);
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
    return this.store
      .getRunsBySession(sessionId)
      .filter((run) => run.status === "completed" && run.answer)
      .sort((leftRun, rightRun) => leftRun.createdAt.localeCompare(rightRun.createdAt))
      .flatMap((run): AgentMessage[] => [
        { role: "user", content: run.input },
        { role: "assistant", content: run.answer }
      ]);
  }
}
