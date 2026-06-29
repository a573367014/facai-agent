import type { AgentStreamEvent } from "../api/agent-client";

export type ToolTraceStatus = "pending" | "running" | "success" | "failed";

export interface ToolTrace {
  id: string;
  iteration: number;
  toolName: string;
  status: ToolTraceStatus;
  arguments?: Record<string, unknown>;
  result?: unknown;
  progressEvents?: unknown[];
  error?: {
    code: string;
    message: string;
    recoverable?: boolean;
  };
  durationMs?: number;
}

type ToolEvent = Extract<
  AgentStreamEvent,
  { type: "tool_call_ready" | "tool_start" | "tool_progress" | "tool_result" | "tool_error" }
>;

function isToolEvent(event: AgentStreamEvent): event is ToolEvent {
  return (
    event.type === "tool_call_ready" ||
    event.type === "tool_start" ||
    event.type === "tool_progress" ||
    event.type === "tool_result" ||
    event.type === "tool_error"
  );
}

function getToolTraceId(event: ToolEvent) {
  // 新事件都有 toolCallId，它是最可靠的聚合 key。
  // 旧的持久化事件可能没有 toolCallId，所以用 iteration + toolName 做兜底；
  // 这种兜底无法区分同一轮里同名工具的多次调用，但能保证历史事件至少不会丢展示。
  return event.toolCallId ?? `fallback:${event.iteration}:${event.toolName}`;
}

function getInitialStatus(event: ToolEvent): ToolTraceStatus {
  switch (event.type) {
    case "tool_call_ready":
      return "pending";
    case "tool_start":
    case "tool_progress":
      return "running";
    case "tool_result":
      return "success";
    case "tool_error":
      return "failed";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageToolName(toolName: string) {
  return toolName === "generate_image" || toolName === "edit_image";
}

function toStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isImageBatchItemProgress(progress: unknown): progress is { total?: number; item: Record<string, unknown> } {
  return isRecord(progress) && progress.kind === "image_batch_item" && isRecord(progress.item);
}

function mergeImageBatchProgress(result: unknown, progress: unknown) {
  if (!isImageBatchItemProgress(progress)) {
    return result;
  }

  const currentResult = isRecord(result) ? result : {};
  const existingItems = Array.isArray(currentResult.items)
    ? currentResult.items.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
  const incomingIndex = typeof progress.item.index === "number" ? progress.item.index : existingItems.length;
  const itemsByIndex = new Map<number, Record<string, unknown>>();

  for (const item of existingItems) {
    const index = typeof item.index === "number" ? item.index : itemsByIndex.size;
    itemsByIndex.set(index, item);
  }

  itemsByIndex.set(incomingIndex, progress.item);

  const items = [...itemsByIndex.entries()]
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([, item]) => item);
  const succeededItems = items.filter((item) => item.status === "success");
  const failedItems = items.filter((item) => item.status === "failed");

  // 生图进度事件只是一片片到达的中间态。这里把它们折叠成 ImagePreview 已经能消费的 result 形状，
  // 最终 tool_result 到达后会覆盖这个临时 result，所以不会影响完整结果入库和回放。
  return {
    ...currentResult,
    total: typeof progress.total === "number" ? progress.total : currentResult.total ?? items.length,
    succeeded: succeededItems.length,
    failed: failedItems.length,
    imageUrls: succeededItems.flatMap((item) => toStringArray(item.imageUrls)),
    binaryDataBase64: succeededItems.flatMap((item) => toStringArray(item.binaryDataBase64)),
    items
  };
}

function ensureTrace(traces: Map<string, ToolTrace>, event: ToolEvent) {
  const id = getToolTraceId(event);
  const existingTrace = traces.get(id);

  if (existingTrace) {
    return existingTrace;
  }

  const trace: ToolTrace = {
    id,
    iteration: event.iteration,
    toolName: event.toolName,
    status: getInitialStatus(event)
  };

  traces.set(id, trace);
  return trace;
}

export function buildToolTraces(events: AgentStreamEvent[]): ToolTrace[] {
  const traces = new Map<string, ToolTrace>();

  for (const event of events) {
    if (!isToolEvent(event)) {
      continue;
    }

    const trace = ensureTrace(traces, event);

    switch (event.type) {
      case "tool_call_ready":
        trace.status = trace.status === "pending" ? "pending" : trace.status;
        trace.arguments = event.arguments;
        break;
      case "tool_start":
        trace.status = "running";
        trace.arguments = event.arguments;
        break;
      case "tool_progress":
        trace.status = trace.status === "success" || trace.status === "failed" ? trace.status : "running";
        trace.progressEvents = [...(trace.progressEvents ?? []), event.progress];
        if (isImageToolName(trace.toolName)) {
          trace.result = mergeImageBatchProgress(trace.result, event.progress);
        }
        break;
      case "tool_result":
        trace.status = "success";
        trace.result = event.result;
        trace.durationMs = event.durationMs;
        break;
      case "tool_error":
        trace.status = "failed";
        trace.error = event.error;
        trace.durationMs = event.durationMs;
        break;
    }
  }

  return Array.from(traces.values());
}
