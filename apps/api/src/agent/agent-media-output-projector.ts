import { AppError } from "../errors/app-error.js";
import type { AgentErrorDetail, AgentStreamEvent } from "./types.js";
import type {
  AgentResourceRecord,
  AgentStore,
  AgentToolCallRecord
} from "./agent-store.js";
import {
  upsertGeneratedImageParts,
  type GeneratedImagePartInput
} from "./message-parts.js";
import type { ToolResourceStorage, StoredToolResource, ToolResourceType } from "./tool-resource-storage.js";
import type { JsonObject } from "../tools/types.js";
import type { AgentRunningDraftManager } from "./agent-running-draft-manager.js";
import {
  buildImageMetadata,
  buildVideoMetadata,
  compactJsonObject,
  extractFailedImageAssets,
  extractImageAssets,
  extractImageRequestSlots,
  extractVideoAssets,
  extractVideoRequestSlot,
  findGeneratedImagePartIndex,
  isImageOutputToolName,
  isImageToolResultWithId,
  isRecord,
  isVideoOutputToolName,
  isVideoToolResultWithId,
  toOptionalNumber,
  toOptionalString
} from "./agent-message-projection-utils.js";

type AppendExecutionEvent = (messageId: string, event: AgentStreamEvent, runId?: string) => void;

type EnsureToolCallRecord = (
  messageId: string,
  event: {
    iteration: number;
    toolCallId?: string;
    toolName: string;
    arguments?: JsonObject;
  },
  runId: string | undefined,
  status: AgentToolCallRecord["status"]
) => Promise<AgentToolCallRecord | undefined>;

export interface AgentMediaOutputProjectorOptions {
  store: AgentStore;
  resourceStorage: ToolResourceStorage;
  draftManager: AgentRunningDraftManager;
  ensureToolCallRecord: EnsureToolCallRecord;
  appendEvent: AppendExecutionEvent;
}

// AgentMediaOutputProjector 专门处理“会产出媒体资源的工具”，目前是图片和视频。
// 它同时维护三层数据：
// - tool_call：审计工具调用是否成功、耗时、失败原因；
// - resource：长期保存图片/视频 URL、尺寸、状态；
// - message part：让前端聊天正文里出现占位图、成功图、失败提示。
// 这样 coordinator 只关心 run 编排，不需要知道每种媒体结果长什么样。
export class AgentMediaOutputProjector {
  private readonly store: AgentStore;
  private readonly resourceStorage: ToolResourceStorage;
  private readonly draftManager: AgentRunningDraftManager;
  private readonly ensureToolCallRecord: EnsureToolCallRecord;
  private readonly appendEvent: AppendExecutionEvent;

  constructor(options: AgentMediaOutputProjectorOptions) {
    this.store = options.store;
    this.resourceStorage = options.resourceStorage;
    this.draftManager = options.draftManager;
    this.ensureToolCallRecord = options.ensureToolCallRecord;
    this.appendEvent = options.appendEvent;
  }

  async handleToolStart(
    messageId: string,
    event: Extract<AgentStreamEvent, { type: "tool_start" }>,
    runId?: string
  ): Promise<boolean> {
    if (isImageOutputToolName(event.toolName) && event.toolCallId) {
      // tool_start 时先创建 pending resource + pending media part。
      // 用户能立刻看到“图片生成中”的占位，后续 tool_result/tool_error 再更新同一个资源和 part。
      const toolCall = await this.ensureToolCallRecord(messageId, event, runId, "running");
      const imageSlots = extractImageRequestSlots(event.arguments);

      for (const slot of imageSlots) {
        const resource = await this.upsertImageResource(messageId, {
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

        await this.upsertMediaPart(messageId, {
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

      return true;
    }

    if (isVideoOutputToolName(event.toolName) && event.toolCallId) {
      // 视频也按同一套资源模型处理，只是 mime/type 不同。
      // 这样前端 MessagePartRenderer 可以统一渲染 pending/succeeded/failed 生命周期。
      const toolCall = await this.ensureToolCallRecord(messageId, event, runId, "running");
      const videoSlot = extractVideoRequestSlot(event.arguments);
      const resource = await this.upsertImageResource(messageId, {
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

      await this.upsertMediaPart(messageId, {
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

      return true;
    }

    return false;
  }

  async handleToolResult(messageId: string, event: AgentStreamEvent, runId?: string): Promise<boolean> {
    // 返回 true 表示这个事件已经被媒体 projector 消费。
    // coordinator 收到 false 时，会走普通工具结果逻辑。
    if (isImageToolResultWithId(event)) {
      await this.upsertImageResultParts(messageId, event, runId);
      return true;
    }

    if (isVideoToolResultWithId(event)) {
      await this.upsertVideoResultParts(messageId, event, runId);
      return true;
    }

    return false;
  }

  async handleToolError(
    messageId: string,
    event: Extract<AgentStreamEvent, { type: "tool_error" }>,
    runId?: string
  ): Promise<boolean> {
    if (isImageOutputToolName(event.toolName) && event.toolCallId) {
      // 媒体工具失败也要写成 failed resource/part。
      // 这样用户在正文里能看到失败位置，审计侧也能按 resource/tool_call 追失败原因。
      const toolCall = await this.ensureToolCallRecord(messageId, event, runId, "running");
      const resource = await this.upsertImageResource(messageId, {
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
        await this.store.updateToolCall(toolCall.id, {
          status: "failed",
          durationMs: event.durationMs,
          error: {
            code: event.error.code,
            message: event.error.message
          }
        });
      }

      await this.upsertMediaPart(messageId, {
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

      return true;
    }

    if (isVideoOutputToolName(event.toolName) && event.toolCallId) {
      // 视频失败路径和图片一致：tool_call 记录审计结果，resource/part 负责前端展示失败位。
      const toolCall = await this.ensureToolCallRecord(messageId, event, runId, "running");
      const resource = await this.upsertImageResource(messageId, {
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
        await this.store.updateToolCall(toolCall.id, {
          status: "failed",
          durationMs: event.durationMs,
          error: {
            code: event.error.code,
            message: event.error.message
          }
        });
      }

      await this.upsertMediaPart(messageId, {
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

      return true;
    }

    return false;
  }

  private async upsertImageResultParts(
    messageId: string,
    event: Extract<AgentStreamEvent, { type: "tool_result" }> & { toolName: string; toolCallId: string },
    runId?: string
  ) {
    const toolCall = await this.ensureToolCallRecord(messageId, event, runId, "running");
    const assets = extractImageAssets(event.result, 0);
    const failedAssets = extractFailedImageAssets(event.result, 0);

    // 批量生图可能“部分成功”：成功项写 succeeded，失败项写 failed。
    // 这里不因为 failedAssets 存在就让整条 tool_call 失败，因为工具本身已经正常返回了结构化结果。
    if (toolCall) {
      await this.store.updateToolCall(toolCall.id, {
        status: "succeeded",
        durationMs: event.durationMs,
        resultSummary: compactJsonObject({
          outputCount: assets.length,
          provider: isRecord(event.result) ? event.result.provider : undefined
        })
      });
    }

    for (const asset of failedAssets) {
      const resource = await this.upsertImageResource(messageId, {
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

      await this.upsertMediaPart(messageId, {
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
      // resourceStorage 是资源转储层：现在可以是 passthrough，未来可以换成 OSS/CDN。
      // 写 message part 时优先使用转储后的 URL，避免前端绑定第三方临时地址。
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

      const resource = await this.upsertImageResource(messageId, {
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

      await this.upsertMediaPart(messageId, {
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
    const toolCall = await this.ensureToolCallRecord(messageId, event, runId, "running");
    const assets = extractVideoAssets(event.result, 0);

    // 只要工具正常返回结构化结果，tool_call 就算 succeeded；
    // 视频文件保存失败会在 resource/message part 层体现，不反向把模型工具调用判失败。
    if (toolCall) {
      await this.store.updateToolCall(toolCall.id, {
        status: "succeeded",
        durationMs: event.durationMs,
        resultSummary: compactJsonObject({
          outputCount: assets.length,
          provider: isRecord(event.result) ? event.result.provider : undefined
        })
      });
    }

    for (const asset of assets) {
      // 图片和视频都先过 resourceStorage，这样未来切 OSS/CDN 时不会影响聊天消息结构。
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

      const resource = await this.upsertImageResource(messageId, {
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

      await this.upsertMediaPart(messageId, {
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
      // 资源转储失败不是模型失败，也不是工具调用失败。
      // 已生成的远端资源可能存在，但我们无法稳定保存，所以给用户展示“资源保存失败”的 part。
      const detail = toErrorDetail(error);
      const mime = input.mime ?? (input.type === "video" ? "video/mp4" : "image/png");
      const resource = await this.upsertImageResource(messageId, {
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

      await this.upsertMediaPart(messageId, {
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

  private async upsertMediaPart(messageId: string, input: GeneratedImagePartInput, runId?: string) {
    const message = await this.store.getMessage(messageId);

    if (!message) {
      return;
    }

    // message part 写入的是运行中草稿层：token 流、图片占位、图片成功态都先改 Redis/内存草稿。
    // run 最终完成时 coordinator 再把草稿 parts 固化回 SQLite message。
    const currentParts = await this.draftManager.getParts(messageId, runId);
    const existingIndex = findGeneratedImagePartIndex(currentParts, input);
    const nextParts = upsertGeneratedImageParts(currentParts, input);
    const partIndex = findGeneratedImagePartIndex(nextParts, input);
    const { parts: updatedParts, version } = await this.draftManager.setParts(messageId, nextParts, runId);
    const part = updatedParts[partIndex] ?? nextParts[partIndex];

    if (!part || partIndex < 0) {
      return;
    }

    // part 事件要和 draft version 一起发给前端。
    // 重连回放时前端用 version 防止旧 snapshot 覆盖新 part。
    this.appendEvent(messageId, {
      type: existingIndex === -1 ? "message.part.created" : "message.part.updated",
      messageId,
      partIndex,
      part,
      version
    }, runId);
  }

  private async upsertImageResource(
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
  ): Promise<AgentResourceRecord> {
    const message = await this.store.getMessage(messageId);

    if (!message) {
      throw new AppError("VALIDATION_ERROR", `未找到助手消息：${messageId}`, 404);
    }

    const resourceType = input.type ?? "image";
    const existingResource = await this.findImageResource(messageId, input.toolCallId, input.outputIndex, resourceType);

    if (existingResource) {
      // pending -> succeeded/failed 走 update，而不是新建 resource。
      // 这样同一个 resourceId 能贯穿占位、完成和失败状态，前端引用也更稳定。
      const resource =
        (await this.store.updateResource(existingResource.id, {
          toolCallId: input.toolCallId,
          toolCallRowId: input.toolCallRowId,
          mime: input.mime,
          url: input.url,
          name: input.name,
          status: input.status,
          width: input.width,
          height: input.height,
          metadata: input.metadata ?? existingResource.metadata
        })) ?? existingResource;
      this.appendEvent(messageId, { type: "resource.updated", resource }, runId);
      return resource;
    }

    const reusableFailedResource =
      resourceType === "image" ? await this.findReusableFailedImageResource(messageId, input.metadata) : undefined;

    if (reusableFailedResource) {
      // 对于同 prompt 的失败占位，后续成功结果可以复用原 resource。
      // 这样失败占位会自然被替换成成功图片，而不是同一位置重复出现两张卡片。
      const resource =
        (await this.store.updateResource(reusableFailedResource.id, {
          toolCallId: input.toolCallId,
          toolCallRowId: input.toolCallRowId,
          mime: input.mime,
          url: input.url,
          name: input.name,
          status: input.status,
          width: input.width,
          height: input.height,
          metadata: input.metadata ?? reusableFailedResource.metadata
        })) ?? reusableFailedResource;
      this.appendEvent(messageId, { type: "resource.updated", resource }, runId);
      return resource;
    }

    const resource = await this.store.createResource({
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

  private async findImageResource(
    messageId: string,
    toolCallId: string,
    outputIndex: number,
    resourceType = "image"
  ): Promise<AgentResourceRecord | undefined> {
    // 同一个工具调用可能产出多张图，outputIndex 用来找到对应槽位。
    // 老数据可能没有 outputIndex，所以 index=0 时允许回退到未标记的 resource。
    const resources = (await this.store
      .getResourcesByMessages([messageId]))
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

  private async findReusableFailedImageResource(messageId: string, metadata?: JsonObject): Promise<AgentResourceRecord | undefined> {
    // 有些 provider 会先返回失败 item，随后又返回同 prompt 的成功图。
    // 这里用 prompt/sourceImageUrl 复用失败 resource，让同一个位置从 failed 变成 succeeded。
    const prompt = toOptionalString(metadata?.prompt);
    const sourceImageUrl = toOptionalString(metadata?.sourceImageUrl);

    if (!prompt) {
      return undefined;
    }

    return (await this.store
      .getResourcesByMessages([messageId]))
      .find(
        (resource) =>
          resource.type === "image" &&
          resource.status === "failed" &&
          !resource.url &&
          toOptionalString(resource.metadata?.prompt) === prompt &&
          (!sourceImageUrl || toOptionalString(resource.metadata?.sourceImageUrl) === sourceImageUrl)
      );
  }
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
