import type { JsonObject } from "../tools/types.js";

export type PlaceholderType = "text" | "input" | "select" | "image" | "video" | "skill";
export type LifecycleState = "pending" | "succeeded" | "failed";

export interface PlaceholderOption {
  label: string;
  value: string;
  icon?: string;
}

export interface PartExtra {
  placeholder?: {
    type: PlaceholderType;
    label: string;
    defaultValue?: string;
    options?: PlaceholderOption[];
    removable?: boolean;
    emphasize?: boolean;
    code?: string;
    icon?: string;
    guide?: {
      description?: string;
      image?: string;
      video?: string;
    };
  };
  lifecycle?: {
    state: LifecycleState;
    error?: {
      code: string;
      message: string;
    };
  };
  tool?: {
    name: string;
    toolCallId: string;
    toolCallRowId?: string;
    outputIndex?: number;
  };
  resource?: {
    id: string;
  };
  generation?: {
    prompt?: string;
    provider?: string;
    model?: string;
  };
  [key: string]: unknown;
}

interface PartBase {
  type: "text" | "media";
  extra?: PartExtra;
}

export interface TextPart extends PartBase {
  type: "text";
  value: string;
}

export interface MediaPart extends PartBase {
  type: "media";
  mime?: string;
  url?: string;
  name?: string;
  width?: number;
  height?: number;
}

export type MessagePart = TextPart | MediaPart;

export function createTextPart(value: string): TextPart {
  return { type: "text", value };
}

export function stripRuntimePartFields(parts: Array<MessagePart & Record<string, unknown>>): MessagePart[] {
  // 前端编辑器会临时挂一些 $ 开头的运行时字段，比如选中态、上传态。
  // 这些字段只服务 UI，不应该写进数据库，也不应该发给 LLM。
  return parts.map((part) => {
    const cleanEntries = Object.entries(part).filter(([key]) => !key.startsWith("$"));
    return Object.fromEntries(cleanEntries) as unknown as MessagePart;
  });
}

export function partsToLlmText(parts: MessagePart[]): string {
  // MessagePart 是给产品展示用的结构化消息；LLM 只需要一段可读文本。
  // pending 的媒体不参与投影，避免模型把“正在生成中”的资源当作已经可用。
  return projectParts(parts, { includePendingMedia: false }).join("\n");
}

export function appendTextDelta(parts: MessagePart[], partIndex: number, delta: string): MessagePart[] {
  return parts.map((part, index) => {
    if (index !== partIndex || part.type !== "text") {
      return part;
    }

    return { ...part, value: part.value + delta };
  });
}

export function ensureAppendableTextPart(parts: MessagePart[]): { parts: MessagePart[]; partIndex: number } {
  const lastIndex = parts.length - 1;
  const lastPart = parts[lastIndex];

  if (lastPart?.type === "text") {
    return { parts, partIndex: lastIndex };
  }

  return { parts: [...parts, createTextPart("")], partIndex: parts.length };
}

export interface GeneratedImagePartInput {
  state: LifecycleState;
  resourceId: string;
  toolName: string;
  toolCallId: string;
  toolCallRowId?: string;
  outputIndex: number;
  mime?: string;
  url?: string;
  name?: string;
  width?: number;
  height?: number;
  error?: {
    code: string;
    message: string;
  };
  generation?: PartExtra["generation"];
}

export function upsertGeneratedImageParts(parts: MessagePart[], input: GeneratedImagePartInput): MessagePart[] {
  // 生成类工具通常先插入 pending 占位，再用同一个 resource/toolCall/outputIndex 更新成成功或失败。
  // 用 upsert 而不是 append，可以避免流式事件重放或进度更新时重复出现同一张图。
  const existingIndex = parts.findIndex(
    (part) =>
      part.type === "media" &&
      ((part.extra?.resource?.id === input.resourceId) ||
        (part.extra?.tool?.toolCallId === input.toolCallId && part.extra.tool.outputIndex === input.outputIndex))
  );
  const mediaPart: MediaPart = removeUndefinedDeep({
    type: "media",
    mime: input.mime,
    url: input.url,
    name: input.name,
    width: input.width,
    height: input.height,
    extra: {
      placeholder: input.state === "pending" ? getGeneratedMediaPlaceholder(input.mime) : undefined,
      lifecycle: {
        state: input.state,
        error: input.error
      },
      resource: { id: input.resourceId },
      tool: {
        name: input.toolName,
        toolCallId: input.toolCallId,
        toolCallRowId: input.toolCallRowId,
        outputIndex: input.outputIndex
      },
      generation: input.generation
    }
  }) as MediaPart;

  if (existingIndex === -1) {
    return [...parts, mediaPart];
  }

  return parts.map((part, index) => (index === existingIndex ? mediaPart : part));
}

function getGeneratedMediaPlaceholder(mime?: string) {
  if (mime?.startsWith("video/")) {
    return { type: "video" as const, label: "视频生成中" };
  }

  return { type: "image" as const, label: "图片生成中" };
}

function projectParts(parts: MessagePart[], options: { includePendingMedia: boolean }): string[] {
  return parts
    .map((part) => (part.type === "text" ? projectTextPart(part) : projectMediaPart(part, options)))
    .filter((line) => line.trim().length > 0);
}

function projectTextPart(part: TextPart): string {
  const placeholder = part.extra?.placeholder;

  // 占位型文本在 UI 里可能是一个下拉/输入控件。
  // 投影给 LLM 时要变成“标签：用户选择”，否则模型只看到原始 value 会缺少语义。
  if (placeholder?.type === "select") {
    const selected = placeholder.options?.find((option) => option.value === part.value);
    return `${placeholder.label}：${selected?.label ?? part.value}`;
  }

  if ((placeholder?.type === "input" || placeholder?.type === "text") && !part.value) {
    return placeholder.defaultValue ?? placeholder.label;
  }

  return part.value;
}

function projectMediaPart(part: MediaPart, options: { includePendingMedia: boolean }): string {
  const state = part.extra?.lifecycle?.state;

  // 媒体 part 对 LLM 的价值是“有什么资源、资源是否失败、资源地址是否可访问”。
  // base64、本地 blob 等前端专用地址不投影，避免上下文暴涨或给模型不可用链接。
  if (state === "pending" && !options.includePendingMedia) {
    return "";
  }

  if (state === "failed") {
    const message = part.extra?.lifecycle?.error?.message;
    return message ? `资源生成失败：${message}` : "资源生成失败。";
  }

  const label = part.name ?? part.extra?.placeholder?.label ?? "媒体资源";
  const mediaUrl = toProjectableMediaUrl(part.url);

  if (mediaUrl) {
    return `${label}：${mediaUrl}`;
  }

  return label;
}

function toProjectableMediaUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function removeUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedDeep);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, removeUndefinedDeep(entryValue)])
    ) as JsonObject;
  }

  return value;
}
