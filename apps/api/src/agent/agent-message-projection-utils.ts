import type { AgentStreamEvent } from "./types.js";
import type { GeneratedImagePartInput, MessagePart } from "./message-parts.js";
import type { AgentProcessStepRecord, AgentStore } from "./agent-store.js";
import type { JsonObject } from "../tools/types.js";

// 这个文件只放“无副作用”的投影辅助函数：
// 它不读写 SQLite/Redis，只负责把流式事件里的松散 JSON 转成 coordinator/projector 需要的稳定结构。
// 好处是业务类可以专注编排，解析图片/视频结果、补 metadata 这些细节集中在这里测试和维护。
const IMAGE_OUTPUT_TOOL_NAMES = new Set(["generate_image", "edit_image"]);
const VIDEO_OUTPUT_TOOL_NAMES = new Set(["generate_video"]);

export interface ExtractedImageResult {
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
  prompt?: string;
  index: number;
  metadata: JsonObject;
}

export interface FailedImageResult {
  width?: number;
  height?: number;
  prompt?: string;
  index: number;
  error?: string;
  metadata: JsonObject;
}

export interface ImageRequestSlot {
  outputIndex: number;
  prompt?: string;
  width?: number;
  height?: number;
  sourceImageUrl?: string;
  isBatch: boolean;
}

export interface VideoRequestSlot {
  outputIndex: number;
  prompt?: string;
  frames?: number;
  aspectRatio?: string;
}

export interface ExtractedVideoResult {
  url: string;
  prompt?: string;
  index: number;
  metadata: JsonObject;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function compactJsonObject(value: Record<string, unknown>): JsonObject {
  // metadata 最终会持久化，undefined 字段没有信息量，统一在入库前剔除。
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as JsonObject;
}

export function summarizeToolResult(result: unknown): JsonObject {
  // process step 只需要“可扫读”的摘要，完整结果由 tool_call/resource/message part 保存。
  // 这样前端进度列表不会被大段模型返回污染，也能降低事件回放体积。
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

export function isImageOutputToolName(toolName: string): boolean {
  return IMAGE_OUTPUT_TOOL_NAMES.has(toolName);
}

export function isVideoOutputToolName(toolName: string): boolean {
  return VIDEO_OUTPUT_TOOL_NAMES.has(toolName);
}

export function isMediaOutputToolName(toolName: string): boolean {
  return isImageOutputToolName(toolName) || isVideoOutputToolName(toolName);
}

export function isImageToolResultWithId(
  event: AgentStreamEvent
): event is Extract<AgentStreamEvent, { type: "tool_result" }> & { toolName: string; toolCallId: string } {
  return event.type === "tool_result" && isImageOutputToolName(event.toolName) && typeof event.toolCallId === "string";
}

export function isVideoToolResultWithId(
  event: AgentStreamEvent
): event is Extract<AgentStreamEvent, { type: "tool_result" }> & { toolName: string; toolCallId: string } {
  return event.type === "tool_result" && isVideoOutputToolName(event.toolName) && typeof event.toolCallId === "string";
}

export function getProcessStepCompletionPatch(
  step: AgentProcessStepRecord,
  status: AgentProcessStepRecord["status"]
): Pick<Parameters<AgentStore["updateProcessStep"]>[1], "title" | "summary"> {
  // “整理回答”这类步骤在结束时要换成更自然的文案；
  // 普通工具步骤已经在 tool_result/tool_error 阶段拿到了自己的成功/失败文案。
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

export function extractImageRequestSlots(argumentsJson: JsonObject): ImageRequestSlot[] {
  // generate_image 支持两种入参形态：
  // - 单图：prompt/width/height 在根对象；
  // - 批量：items 里每一项代表一个输出槽位。
  // 这里统一转成 slot，后面就能用同一套 pending resource/message part 逻辑。
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

export function extractVideoRequestSlot(argumentsJson: JsonObject): VideoRequestSlot {
  // 当前视频工具一次只产出一个视频，所以固定 outputIndex=0；
  // 保留 slot 结构是为了和图片 projector 的 pending -> succeeded 生命周期保持一致。
  return {
    outputIndex: 0,
    prompt: toOptionalString(argumentsJson.prompt),
    frames: toOptionalNumber(argumentsJson.frames),
    aspectRatio: toOptionalString(argumentsJson.aspectRatio)
  };
}

export function buildImageMetadata(input: {
  prompt?: string;
  width?: number;
  height?: number;
  sourceImageUrl?: string;
  outputIndex: number;
  includeOutputIndex: boolean;
  provider?: unknown;
  error?: string;
}): JsonObject {
  // resource.metadata 是审计和调试入口：它保留生成参数、来源图、provider、失败原因等上下文。
  // message part 只承担展示，排查问题时主要看 resource/tool_call。
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

export function buildVideoMetadata(input: {
  prompt?: string;
  frames?: number;
  aspectRatio?: string;
  provider?: unknown;
  taskId?: unknown;
  error?: unknown;
}): JsonObject {
  // 视频和图片共用 resource 表，但 metadata 字段不同；
  // 这里把视频专属的 frames/aspectRatio/taskId 收拢在一个地方，避免 projector 里散落拼对象。
  return compactJsonObject({
    prompt: input.prompt,
    frames: input.frames,
    aspectRatio: input.aspectRatio,
    provider: input.provider,
    taskId: input.taskId,
    error: input.error
  });
}

export function findGeneratedImagePartIndex(parts: MessagePart[], input: GeneratedImagePartInput) {
  // 优先用 resourceId 命中，因为它最稳定；还没有 resourceId 时退回 toolCallId + outputIndex。
  // 这保证 pending 占位、成功结果、失败结果会更新同一个 message part，而不是越插越多。
  return parts.findIndex(
    (part) =>
      part.type === "media" &&
      (part.extra?.resource?.id === input.resourceId ||
        (part.extra?.tool?.toolCallId === input.toolCallId && part.extra.tool.outputIndex === input.outputIndex))
  );
}

export function extractFailedImageAssets(result: unknown, startIndex: number): FailedImageResult[] {
  // 批量生图可能返回“部分失败、部分成功”。
  // 失败项没有 URL，但仍要生成 failed resource/message part，用户才能知道哪个槽位失败了。
  if (!isRecord(result)) {
    return [];
  }

  const resultPrompt = toOptionalString(result.prompt);
  const resultSourceImageUrl = toOptionalString(result.imageUrl);
  const batchItems = Array.isArray(result.items) ? result.items.filter(isRecord) : [];
  let nextIndex = startIndex;

  return batchItems.flatMap((item) => {
    // item.index 如果缺失，就用 nextIndex 补一个稳定顺序。
    // 后续 resource/message part 都靠这个 outputIndex 对齐。
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

export function extractImageAssets(result: unknown, startIndex: number): ExtractedImageResult[] {
  // 把 provider 返回的各种图片结果形态统一成 asset 列表。
  // 支持批量 items[].imageUrls，也支持旧的根级 imageUrls，projector 后面只处理统一结构。
  if (!isRecord(result)) {
    return [];
  }

  const resultPrompt = toOptionalString(result.prompt);
  const resultSourceImageUrl = toOptionalString(result.imageUrl);
  const batchItems = Array.isArray(result.items) ? result.items.filter(isRecord) : [];
  let nextIndex = startIndex;

  if (batchItems.length > 0) {
    return batchItems.flatMap((item) => {
      // 同一个 item 也可能返回多张图；如果 provider 没给 index，就按出现顺序补齐。
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

export function extractVideoAssets(result: unknown, startIndex: number): ExtractedVideoResult[] {
  // 视频结果目前是根级 videoUrls。仍然返回数组，是为了兼容一次任务未来产出多个视频的情况。
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
