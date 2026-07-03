import { createTextPart } from "./message-parts.js";
import type { AgentErrorDetail, AgentStreamEvent } from "./types.js";
import type { AgentMessageRecord, AgentRunRecord, AgentStore } from "./agent-store.js";
import type { AgentRunningDraftManager } from "./agent-running-draft-manager.js";
import type { AgentProcessStepProjector } from "./agent-process-step-projector.js";
import { compactJsonObject } from "./agent-message-projection-utils.js";

export interface StaleRunningCleanupResult {
  runs: number;
  messages: number;
  toolCalls: number;
  resources: number;
  processSteps: number;
}

type AppendRunEvent = (runId: string, event: AgentStreamEvent, messageId?: string) => void;

// AgentRunCleanupService 处理“运行到一半服务没了”的补偿。
// Redis 只保存运行中草稿/锁这类短期状态，进程重启后可能丢失；
// SQLite 里却还会留下 status=running 的 run/message/tool/resource。
// 这个类启动时把这些悬挂记录统一标成 failed，并追加可回放事件，让前端和审计视角都闭环。
export class AgentRunCleanupService {
  constructor(
    private readonly store: AgentStore,
    private readonly draftManager: AgentRunningDraftManager,
    private readonly processStepProjector: AgentProcessStepProjector,
    private readonly appendRunEvent: AppendRunEvent
  ) {}

  async cleanupStaleRunningExecutions(
    activeRunIds: ReadonlySet<string>,
    reason = "服务重启后清理遗留运行"
  ): Promise<StaleRunningCleanupResult> {
    // activeRunIds 是当前进程内还握着 AbortController 的 run。
    // 不在这里面的 running run，基本就是上个进程遗留下来的，需要补偿成失败态。
    const detail: AgentErrorDetail = {
      code: "RUN_INTERRUPTED",
      message: reason
    };
    const result = this.createEmptyCleanupResult();

    for (const run of await this.getAllRunningRuns()) {
      if (activeRunIds.has(run.id)) {
        continue;
      }

      const runResult = await this.failInterruptedRun(run, detail);
      this.addCleanupResult(result, runResult);
    }

    return result;
  }

  async getSessionRunningRuns(sessionId: string): Promise<AgentRunRecord[]> {
    // 删除会话前先找出仍在 running 的 run，让 coordinator 走正常 cancel 流程。
    // 这里按 runId 去重，是因为同一个 run 可能同时挂在 system/assistant message 上。
    const runsById = new Map<string, AgentRunRecord>();

    for (const message of await this.store.getMessagesBySession(sessionId)) {
      for (const run of await this.store.getRunsByMessageId(message.id)) {
        if (run.status === "running") {
          runsById.set(run.id, run);
        }
      }
    }

    return [...runsById.values()];
  }

  private async failInterruptedRun(run: AgentRunRecord, detail: AgentErrorDetail): Promise<StaleRunningCleanupResult> {
    const result = this.createEmptyCleanupResult();
    const messageIds = [run.systemMessageId, run.assistantMessageId].filter((messageId): messageId is string => Boolean(messageId));

    // 一个 run 可能经历压缩(system message)和正式回答(assistant message)两个阶段。
    // 哪个 message 还在 running，就把哪个 message 也一起收尾，避免只改 run 留下半截消息。
    for (const messageId of messageIds) {
      const message = await this.store.getMessage(messageId);

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
    // run 是最外层状态，最后更新它；这样前面 message/tool/resource 的失败事件已经都写好了。
    await this.store.updateRun(run.id, {
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
    const runningSteps = (await this.store.getProcessStepsByMessages([message.id]))
      .filter((step) => step.status === "running" && step.runId === runId);

    // process step/tool/resource/message 四类记录都要同步失败：
    // 否则审计时会看到 run failed，但工具或资源还显示 pending/running。
    this.processStepProjector.completeRunning(message.id, runId, "failed");
    result.processSteps += runningSteps.length;
    result.toolCalls += await this.failInterruptedToolCalls(message, runId, detail);
    result.resources += await this.failInterruptedResources(message, detail);

    const failedMessage =
      await this.store.updateMessage(message.id, {
        status: "failed",
        // interrupted message 不保留 Redis 草稿内容，给用户一个明确可读的重试提示。
        parts: [createTextPart("本轮运行因服务重启中断，请重新生成。")],
        error: detail,
        completedAt: now()
      }) ?? message;

    this.appendRunEvent(runId, { type: "session.message.updated", message: failedMessage }, message.id);

    try {
      // Redis 草稿只服务运行中状态。message 已经失败后要清掉，避免下次查询又合并出旧草稿。
      // 如果 Redis 本身不可用，SQLite 失败态已经写完，草稿清理就保持 best effort。
      await this.draftManager.remove(message.id);
    } catch {
      // 清理失败不再继续抛出。
    }
    result.messages += 1;
    return result;
  }

  private async failInterruptedToolCalls(message: AgentMessageRecord, runId: string, detail: AgentErrorDetail): Promise<number> {
    // 只处理当前 run 当前 message 下的 pending/running tool_call。
    // 历史成功/失败的工具调用不能被这次补偿误伤。
    const toolCalls = (await this.store.getToolCallsBySession(message.sessionId)).filter(
      (toolCall) =>
        toolCall.messageId === message.id &&
        toolCall.runId === runId &&
        (toolCall.status === "pending" || toolCall.status === "running")
    );

    for (const toolCall of toolCalls) {
      await this.store.updateToolCall(toolCall.id, {
        status: "failed",
        error: detail,
        completedAt: now()
      });
    }

    return toolCalls.length;
  }

  private async failInterruptedResources(message: AgentMessageRecord, detail: AgentErrorDetail): Promise<number> {
    // pending resource 多半对应“图片/视频还在生成中”的占位。
    // 服务重启后无法继续追踪第三方任务，就把占位标成 failed，前端会显示失败态。
    const resources = (await this.store.getResourcesByMessages([message.id]))
      .filter((resource) => resource.status === "pending");

    for (const resource of resources) {
      await this.store.updateResource(resource.id, {
        status: "failed",
        metadata: compactJsonObject({
          ...(resource.metadata ?? {}),
          error: detail
        })
      });
    }

    return resources.length;
  }

  private async getAllRunningRuns(): Promise<AgentRunRecord[]> {
    // store 目前没有直接的 listRuns 查询，所以从 session -> message -> run 扫描。
    // 这个方法只在启动清理时调用，频率很低，可读性比额外接口更重要。
    const runsById = new Map<string, AgentRunRecord>();

    for (const session of await this.store.listSessions()) {
      for (const message of await this.store.getMessagesBySession(session.id)) {
        for (const run of await this.store.getRunsByMessageId(message.id)) {
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
}

function now() {
  return new Date().toISOString();
}
