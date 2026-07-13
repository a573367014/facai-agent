/**
 * 模块职责：资源输出投影器。
 *
 * 专门处理"会产出资源的工具"（generate_image / edit_image / generate_video / generate_document），
 * 把工具执行过程中的事件投影到三层数据：
 * - tool_call：审计工具调用是否成功、耗时、失败原因；
 * - resource：长期保存资源 URL、尺寸、状态（pending → succeeded/failed）；
 * - message part：让前端聊天正文里出现资源占位、成功资源、失败提示。
 *
 * 边界：
 * - 只处理资源类工具事件，普通工具事件由 coordinator 自己处理（返回 false 表示不消费）。
 * - 资源转储委托给 ToolResourceStorage，不直接操作 S3。
 * - message part 写入运行中草稿层（Redis），run 完成后由 coordinator 固化回 SQLite。
 */
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { AppError } from "../../shared/errors/app-error.js";
import type { AgentErrorDetail, AgentStreamEvent } from "./types.js";
import type {
  AgentResourceRecord,
  AgentStore,
  AgentToolCallRecord
} from "./agent-store.js";
import {
  upsertGeneratedResourceParts,
  type GeneratedResourcePartInput
} from "./message-parts.js";
import type { ToolResourceStorage, StoredToolResource, ToolResourceType } from "./tool-resource-storage.js";
import type { JsonObject } from "../tools/types.js";
import type { AgentRunningDraftManager } from "./agent-running-draft-manager.js";
import {
  buildImageMetadata,
  buildDocumentMetadata,
  buildVideoMetadata,
  compactJsonObject,
  extractDocumentAssets,
  extractDocumentRequestSlot,
  extractFailedImageAssets,
  extractImageAssets,
  extractImageRequestSlots,
  extractVideoAssets,
  extractVideoRequestSlot,
  findGeneratedResourcePartIndex,
  isDocumentOutputToolName,
  isDocumentToolResultWithId,
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

export interface AgentResourceOutputProjectorOptions {
  store: AgentStore;
  resourceStorage: ToolResourceStorage;
  draftManager: AgentRunningDraftManager;
  ensureToolCallRecord: EnsureToolCallRecord;
  appendEvent: AppendExecutionEvent;
}

// AgentResourceOutputProjector 专门处理“会产出资源的工具”，覆盖图片、视频、文档等类型。
// 它同时维护三层数据：
// - tool_call：审计工具调用是否成功、耗时、失败原因；
// - resource：长期保存资源 URL、尺寸、状态；
// - message part：让前端聊天正文里出现资源占位、成功资源、失败提示。
// 这样 coordinator 只关心 run 编排，不需要知道每种资源结果长什么样。
export class AgentResourceOutputProjector {
  private readonly store: AgentStore;
  private readonly resourceStorage: ToolResourceStorage;
  private readonly draftManager: AgentRunningDraftManager;
  private readonly ensureToolCallRecord: EnsureToolCallRecord;
  private readonly appendEvent: AppendExecutionEvent;

  constructor(options: AgentResourceOutputProjectorOptions) {
    this.store = options.store;
    this.resourceStorage = options.resourceStorage;
    this.draftManager = options.draftManager;
    this.ensureToolCallRecord = options.ensureToolCallRecord;
    this.appendEvent = options.appendEvent;
  }

  /**
   * 处理 tool_start 事件：为资源类工具创建 pending resource + pending resource part。
   * 返回 true 表示这个事件被资源投影器消费了，coordinator 不需要再走普通工具逻辑。
   * 返回 false 表示这不是资源类工具，coordinator 需要自己处理。
   */
  async handleToolStart(
    messageId: string,
    event: Extract<AgentStreamEvent, { type: "tool_start" }>,
    runId?: string
  ): Promise<boolean> {
    if (isImageOutputToolName(event.toolName) && event.toolCallId) {
      // tool_start 时先创建 pending resource + pending resource part。
      // 用户能立刻看到“图片生成中”的占位，后续 tool_result/tool_error 再更新同一个资源和 part。
      const toolCall = await this.ensureToolCallRecord(messageId, event, runId, "running");
      const imageSlots = extractImageRequestSlots(event.arguments);

      for (const slot of imageSlots) {
        const resource = await this.upsertResource(messageId, {
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

        await this.upsertResourcePart(messageId, {
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
      const resource = await this.upsertResource(messageId, {
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

      await this.upsertResourcePart(messageId, {
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

    if (isDocumentOutputToolName(event.toolName) && event.toolCallId) {
      const toolCall = await this.ensureToolCallRecord(messageId, event, runId, "running");
      const documentSlot = extractDocumentRequestSlot(event.arguments);
      const mime = getDocumentMimeFromFormat(documentSlot.format);
      const resource = await this.upsertResource(messageId, {
        type: "document",
        status: "pending",
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: documentSlot.outputIndex,
        mime,
        name: documentSlot.fileName ?? documentSlot.title,
        metadata: buildDocumentMetadata({
          title: documentSlot.title,
          fileName: documentSlot.fileName,
          format: documentSlot.format,
          outputIndex: documentSlot.outputIndex
        })
      }, runId);

      await this.upsertResourcePart(messageId, {
        state: "pending",
        resourceId: resource.id,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: documentSlot.outputIndex,
        mime,
        name: documentSlot.fileName ?? documentSlot.title
      }, runId);

      return true;
    }

    return false;
  }

  /**
   * 处理 tool_result 事件：把工具产出的资源转存到 S3，更新 resource 和 message part 为 succeeded。
   * 批量生图可能"部分成功"：成功项写 succeeded，失败项写 failed。
   * 返回 true 表示被消费；返回 false 表示不是资源类工具结果。
   */
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

    if (isDocumentToolResultWithId(event)) {
      await this.upsertDocumentResultParts(messageId, event, runId);
      return true;
    }

    return false;
  }

  /**
   * 处理 tool_error 事件：把资源类工具的失败写成 failed resource + failed resource part。
   * 这样用户在正文里能看到失败位置，审计侧也能按 resource/tool_call 追失败原因。
   * 返回 true 表示被消费；返回 false 表示不是资源类工具。
   */
  async handleToolError(
    messageId: string,
    event: Extract<AgentStreamEvent, { type: "tool_error" }>,
    runId?: string
  ): Promise<boolean> {
    if (isImageOutputToolName(event.toolName) && event.toolCallId) {
      // 媒体工具失败也要写成 failed resource/part。
      // 这样用户在正文里能看到失败位置，审计侧也能按 resource/tool_call 追失败原因。
      const toolCall = await this.ensureToolCallRecord(messageId, event, runId, "running");
      const resource = await this.upsertResource(messageId, {
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

      await this.upsertResourcePart(messageId, {
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
      const resource = await this.upsertResource(messageId, {
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

      await this.upsertResourcePart(messageId, {
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

    if (isDocumentOutputToolName(event.toolName) && event.toolCallId) {
      const toolCall = await this.ensureToolCallRecord(messageId, event, runId, "running");
      const format = toOptionalString(toolCall?.arguments.format);
      const fileName = toOptionalString(toolCall?.arguments.fileName);
      const title = toOptionalString(toolCall?.arguments.title);
      const resource = await this.upsertResource(messageId, {
        type: "document",
        status: "failed",
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: 0,
        mime: getDocumentMimeFromFormat(format),
        name: fileName ?? title,
        metadata: buildDocumentMetadata({
          title,
          fileName,
          format,
          outputIndex: 0,
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

      await this.upsertResourcePart(messageId, {
        state: "failed",
        resourceId: resource.id,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: 0,
        mime: getDocumentMimeFromFormat(format),
        name: fileName ?? title,
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
      const resource = await this.upsertResource(messageId, {
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

      await this.upsertResourcePart(messageId, {
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

      const resource = await this.upsertResource(messageId, {
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

      await this.upsertResourcePart(messageId, {
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

      const resource = await this.upsertResource(messageId, {
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

      await this.upsertResourcePart(messageId, {
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

  private async upsertDocumentResultParts(
    messageId: string,
    event: Extract<AgentStreamEvent, { type: "tool_result" }> & { toolName: string; toolCallId: string },
    runId?: string
  ) {
    const toolCall = await this.ensureToolCallRecord(messageId, event, runId, "running");
    const assets = extractDocumentAssets(event.result, 0);
    const requestedTitle = toOptionalString(toolCall?.arguments.title);
    const requestedFormat = toOptionalString(toolCall?.arguments.format);

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
      const metadata = buildDocumentMetadata({
        title: toOptionalString(asset.metadata.title) ?? requestedTitle,
        fileName: asset.name,
        format: toOptionalString(asset.metadata.format) ?? requestedFormat,
        outputIndex: asset.index,
        provider: asset.metadata.provider,
        size: asset.size
      });
      const storedAsset = await this.storeGeneratedToolResource(messageId, runId, {
        type: "document",
        source: asset.source,
        mime: asset.mime,
        fileName: asset.name,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: asset.index,
        name: asset.name,
        generation: compactJsonObject({
          provider: asset.metadata.provider
        }),
        metadata
      });

      if (!storedAsset) {
        continue;
      }

      const resourceMetadata = buildDocumentMetadata({
        title: toOptionalString(asset.metadata.title) ?? requestedTitle,
        fileName: storedAsset.name,
        format: toOptionalString(asset.metadata.format) ?? requestedFormat,
        outputIndex: asset.index,
        provider: asset.metadata.provider,
        size: storedAsset.size ?? asset.size
      });
      const resource = await this.upsertResource(messageId, {
        type: "document",
        status: "succeeded",
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: asset.index,
        mime: storedAsset.mime ?? asset.mime,
        url: storedAsset.url,
        name: storedAsset.name,
        metadata: resourceMetadata
      }, runId);

      await this.upsertResourcePart(messageId, {
        state: "succeeded",
        resourceId: resource.id,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolCallRowId: toolCall?.id,
        outputIndex: asset.index,
        mime: storedAsset.mime ?? asset.mime,
        url: storedAsset.url,
        name: storedAsset.name,
        generation: compactJsonObject({
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
      const mime = input.mime ?? getDefaultMimeForResourceType(input.type);
      const resource = await this.upsertResource(messageId, {
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

      await this.upsertResourcePart(messageId, {
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

  private async storeGeneratedToolResource(
    messageId: string,
    runId: string | undefined,
    input: {
      type: ToolResourceType;
      source: {
        type: "local_file";
        path: string;
      };
      mime?: string;
      fileName?: string;
      toolName: string;
      toolCallId: string;
      toolCallRowId?: string;
      outputIndex: number;
      name?: string;
      width?: number;
      height?: number;
      generation?: JsonObject;
      metadata: JsonObject;
    }
  ): Promise<StoredToolResource | undefined> {
    try {
      if (!this.resourceStorage.storeGeneratedResourceStream) {
        throw new AppError("TOOL_EXECUTION_ERROR", "当前资源存储不支持生成文件流式转储", 500);
      }

      const fileStats = await stat(input.source.path);

      return await this.resourceStorage.storeGeneratedResourceStream({
        stream: createReadStream(input.source.path),
        size: fileStats.size,
        type: input.type,
        mime: input.mime,
        fileName: input.fileName
      });
    } catch (error) {
      const detail = toErrorDetail(error);
      const mime = input.mime ?? getDefaultMimeForResourceType(input.type);
      const resource = await this.upsertResource(messageId, {
        type: input.type,
        status: "failed",
        toolCallId: input.toolCallId,
        toolCallRowId: input.toolCallRowId,
        outputIndex: input.outputIndex,
        mime,
        width: input.width,
        height: input.height,
        name: input.name,
        metadata: compactJsonObject({
          ...input.metadata,
          error: {
            code: detail.code,
            message: `资源转储失败：${detail.message}`
          }
        })
      }, runId);

      await this.upsertResourcePart(messageId, {
        state: "failed",
        resourceId: resource.id,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        toolCallRowId: input.toolCallRowId,
        outputIndex: input.outputIndex,
        mime,
        name: input.name,
        width: input.width,
        height: input.height,
        generation: input.generation,
        error: {
          code: detail.code,
          message: `资源转储失败：${detail.message}`
        }
      }, runId);

      return undefined;
    } finally {
      await unlink(input.source.path).catch(() => undefined);
    }
  }

  private async upsertResourcePart(messageId: string, input: GeneratedResourcePartInput, runId?: string) {
    const message = await this.store.getMessage(messageId);

    if (!message) {
      return;
    }

    // message part 写入的是运行中草稿层：token 流、图片占位、图片成功态都先改 Redis/内存草稿。
    // run 最终完成时 coordinator 再把草稿 parts 固化回 SQLite message。
    const currentParts = await this.draftManager.getParts(messageId, runId);
    const existingIndex = findGeneratedResourcePartIndex(currentParts, input);
    const nextParts = upsertGeneratedResourceParts(currentParts, input);
    const partIndex = findGeneratedResourcePartIndex(nextParts, input);
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

  /**
   * 创建或更新 resource 记录。
   * 查找逻辑：先按 toolCallId + outputIndex 找已有 resource（pending → succeeded/failed 走 update）；
   * 找不到时再尝试复用同 prompt 的 failed resource（让失败占位自然替换成成功结果）；
   * 都找不到才新建。这样同一个 resourceId 能贯穿占位、完成和失败状态，前端引用更稳定。
   */
  private async upsertResource(
    messageId: string,
    input: {
      type?: ToolResourceType;
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

function getDocumentMimeFromFormat(format?: string): string {
  if (format === "txt") {
    return "text/plain";
  }

  if (format === "markdown") {
    return "text/markdown";
  }

  if (format === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  return "application/octet-stream";
}

function getDefaultMimeForResourceType(type: ToolResourceType): string {
  if (type === "video") {
    return "video/mp4";
  }

  if (type === "document") {
    return "application/octet-stream";
  }

  return "image/png";
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
