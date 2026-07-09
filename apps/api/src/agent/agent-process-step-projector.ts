import type { AgentStreamEvent } from "./types.js";
import type { AgentProcessStepRecord, AgentStore } from "./agent-store.js";
import type { JsonObject } from "../tools/types.js";
import {
  compactJsonObject,
  getProcessStepCompletionPatch,
  summarizeToolResult
} from "./agent-message-projection-utils.js";

type AppendExecutionEvent = (messageId: string, event: AgentStreamEvent, runId?: string) => Promise<void> | void;

// AgentProcessStepProjector 把底层流式事件转换成“用户能看懂的任务进度”。
// AgentService 发的是 iteration/llm/tool 的技术事件；前端聊天区更需要稳定的步骤：
// 理解需求 -> 调用工具 -> 整理回答。这个类就是两种视图之间的翻译层。
export class AgentProcessStepProjector {
  constructor(
    private readonly store: AgentStore,
    private readonly appendEvent: AppendExecutionEvent
  ) {}

  async project(messageId: string, event: AgentStreamEvent, runId?: string) {
    // thinking 状态只创建一次。后续如果模型继续发 thinking，只更新事件流本身，
    // 不重复创建“正在理解需求”步骤，避免前端进度列表刷出多条同类步骤。
    if (event.type === "agent_state" && event.state === "thinking") {
      if (!(await this.findProcessStep(messageId, (step) => step.kind === "thinking" && step.metadata?.phase === "thinking"))) {
        await this.createProcessStep(messageId, runId, {
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
      // llm_response 是“第一阶段思考结束”的信号：
      // 如果有 toolCalls，表示接下来要执行工具；没有 toolCalls，表示模型已经给出最终回答。
      const thinkingStep = await this.findProcessStep(messageId, (step) => step.kind === "thinking" && step.metadata?.phase === "thinking");

      if (thinkingStep?.status === "running") {
        const toolCallCount = event.toolCalls?.filter((toolCall) => !isHiddenProcessTool(toolCall.name)).length ?? 0;
        await this.updateProcessStep(messageId, thinkingStep.id, runId, {
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
      // 只有真正执行过工具，才需要展示“整理回答”步骤。
      // 纯文本回答没有工具结果要整合，额外步骤会显得啰嗦。
      const hasToolStep = Boolean(await this.findProcessStep(messageId, (step) => step.kind === "tool"));

      if (!hasToolStep) {
        return;
      }

      if (!(await this.findProcessStep(messageId, (step) => step.kind === "summary" && step.metadata?.phase === "answering"))) {
        await this.createProcessStep(messageId, runId, {
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
      if (isHiddenProcessTool(event.toolName)) {
        return;
      }

      // tool_start 对应一条工具进度步骤。
      // 如果同一个 toolCallId 已经有步骤，说明这是重放/补偿事件，更新已有步骤即可。
      const toolCall = event.toolCallId ? await this.store.getToolCallByMessageToolCall(messageId, event.toolCallId) : undefined;
      const existingStep = event.toolCallId
        ? await this.findProcessStep(messageId, (step) => step.kind === "tool" && step.toolCallId === event.toolCallId)
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
        await this.updateProcessStep(messageId, existingStep.id, runId, {
          toolCallRowId: toolCall?.id,
          toolCallId: event.toolCallId,
          title: labels.running,
          summary,
          status: "running",
          metadata
        });
        return;
      }

      await this.createProcessStep(messageId, runId, {
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
      if (isHiddenProcessTool(event.toolName)) {
        return;
      }

      // 工具成功后不把完整 result 塞进 step summary，只记录摘要到 metadata。
      // 完整结果由 tool_call/resource/message part 保存，前端需要时从那些结构展示。
      const toolCall = await this.store.getToolCallByMessageToolCall(messageId, event.toolCallId);
      const existingStep = await this.findProcessStep(messageId, (step) => step.kind === "tool" && step.toolCallId === event.toolCallId);
      const labels = getToolProcessLabels(event.toolName);

      if (existingStep) {
        await this.updateProcessStep(messageId, existingStep.id, runId, {
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
      if (isHiddenProcessTool(event.toolName)) {
        return;
      }

      const toolCall = await this.store.getToolCallByMessageToolCall(messageId, event.toolCallId);
      const existingStep = await this.findProcessStep(messageId, (step) => step.kind === "tool" && step.toolCallId === event.toolCallId);
      const labels = getToolProcessLabels(event.toolName);

      if (existingStep) {
        await this.updateProcessStep(messageId, existingStep.id, runId, {
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
      await this.completeRunning(messageId, runId, "failed");
      return;
    }

    if (event.type === "cancelled") {
      await this.completeRunning(messageId, runId, "cancelled");
    }
  }

  async completeRunning(messageId: string, runId: string | undefined, status: AgentProcessStepRecord["status"]) {
    // run 成功、失败、取消时，所有仍在 running 的步骤都要收尾。
    // 否则前端会出现消息已经结束，但进度条里还有“正在...”的悬挂状态。
    for (const step of await this.store.getProcessStepsByMessages([messageId])) {
      if (step.status !== "running") {
        continue;
      }

      await this.updateProcessStep(messageId, step.id, runId, {
        ...getProcessStepCompletionPatch(step, status),
        status
      });
    }
  }

  private async createProcessStep(
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
  ): Promise<AgentProcessStepRecord | undefined> {
    const message = await this.store.getMessage(messageId);

    if (!message) {
      return undefined;
    }

    // orderIndex 由当前 message 已有步骤推导，保证前端按创建顺序稳定展示。
    const step = await this.store.createProcessStep({
      sessionId: message.sessionId,
      runId,
      messageId,
      toolCallRowId: input.toolCallRowId,
      toolCallId: input.toolCallId,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      status: input.status,
      orderIndex: await this.getNextProcessStepOrderIndex(messageId),
      metadata: input.metadata
    });
    this.appendEvent(messageId, { type: "process.step.created", step }, runId);
    return step;
  }

  private async updateProcessStep(
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
  ): Promise<AgentProcessStepRecord | undefined> {
    const step = await this.store.updateProcessStep(stepId, input);

    if (!step) {
      return undefined;
    }

    await this.appendEvent(messageId, { type: "process.step.updated", step }, runId);
    return step;
  }

  private async findProcessStep(messageId: string, predicate: (step: AgentProcessStepRecord) => boolean): Promise<AgentProcessStepRecord | undefined> {
    return (await this.store.getProcessStepsByMessages([messageId])).find(predicate);
  }

  private async getNextProcessStepOrderIndex(messageId: string) {
    const steps = await this.store.getProcessStepsByMessages([messageId]);
    const maxOrderIndex = Math.max(-1, ...steps.map((step) => step.orderIndex));
    return maxOrderIndex + 1;
  }
}

function isHiddenProcessTool(toolName: string) {
  return toolName === "knowledge_search";
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
    case "generate_document":
      return {
        running: "正在生成文档",
        succeeded: "文档已生成",
        failed: "文档生成失败"
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
