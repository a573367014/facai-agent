/**
 * 消息 part 领域模型与转换工具。
 *
 * MessagePart 是产品的结构化消息单元（文本、图片、视频、文档、占位控件等），
 * 同时也是数据库存储与前端展示的统一形态。本文件围绕 MessagePart 提供
 * "创建 / 清洗 / 投影 / 流式追加 / 生成资源 upsert"等纯函数转换，
 * 不涉及网络与存储 IO。
 *
 * 三套口径的转换都集中在这里，避免散落造成不一致：
 * - 产品侧：MessagePart（结构化、可渲染）；
 * - LLM 侧：partsToLlmText 投影出的纯文本；
 * - 数据库侧：先 stripRuntimePartFields 去掉前端运行时字段再落库。
 */
import type {
  JsonObject,
  LifecycleState,
  MessagePart,
  PartExtra,
  ResourcePart,
  TextPart
} from "@agent/contracts";

export type {
  LifecycleState,
  MessagePart,
  PartExtra,
  PlaceholderOption,
  PlaceholderType,
  ResourcePart,
  TextPart
} from "@agent/contracts";

/**
 * 创建一个最简文本 part。
 * 统一构造入口，避免各处散落 `{ type: "text", value }` 字面量导致结构漂移。
 */
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
  // pending 的资源不参与投影，避免模型把"正在生成中"的资源当作已经可用。
  return projectParts(parts, { includePendingResource: false }).join("\n");
}

/**
 * 把一段文本增量追加到指定位置的文本 part 上。
 *
 * 用于 LLM 流式输出：每来一个 token delta，就 immutable 地更新对应 part。
 * 返回新数组而非原地修改，方便上层（如 React）靠引用比较触发渲染；
 * 非目标位置或非文本 part 原样返回。
 */
export function appendTextDelta(parts: MessagePart[], partIndex: number, delta: string): MessagePart[] {
  return parts.map((part, index) => {
    if (index !== partIndex || part.type !== "text") {
      return part;
    }

    return { ...part, value: part.value + delta };
  });
}

/**
 * 保证 parts 末尾存在一个可追加的文本 part，返回更新后的 parts 与可写位置。
 *
 * 流式追加文本前必须先调用：末尾已是文本 part 时直接复用其位置；
 * 否则追加一个空文本 part 作为新写入点。
 * 不这么做的话，delta 可能被追加到资源 part 等不合适的结构上。
 */
export function ensureAppendableTextPart(parts: MessagePart[]): { parts: MessagePart[]; partIndex: number } {
  const lastIndex = parts.length - 1;
  const lastPart = parts[lastIndex];

  if (lastPart?.type === "text") {
    return { parts, partIndex: lastIndex };
  }

  return { parts: [...parts, createTextPart("")], partIndex: parts.length };
}

/**
 * 生成类工具（画图/视频/文档）产出资源时，用来 upsert 资源 part 的输入。
 *
 * 字段同时覆盖"pending 占位"与"成功/失败终态"两种情况：
 * - state：生命周期状态，pending 时会附带占位控件；
 * - resourceId 与 (toolCallId + outputIndex)：定位同一个资源的两个维度——
 *   resourceId 是稳定业务 id；(toolCallId, outputIndex) 用于一次工具调用
 *   产出多个资源的场景，二者在 upsert 时任一命中即视为同一条；
 * - error / generation：失败信息与生成元信息（耗时、模型等），仅对应状态下有值。
 */
export interface GeneratedResourcePartInput {
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

export function upsertGeneratedResourceParts(parts: MessagePart[], input: GeneratedResourcePartInput): MessagePart[] {
  // 生成类工具通常先插入 pending 占位，再用同一个 resource/toolCall/outputIndex 更新成成功或失败。
  // 用 upsert 而不是 append，可以避免流式事件重放或进度更新时重复出现同一张图。
  const existingIndex = parts.findIndex(
    (part) =>
      part.type === "resource" &&
      ((part.extra?.resource?.id === input.resourceId) ||
        (part.extra?.tool?.toolCallId === input.toolCallId && part.extra.tool.outputIndex === input.outputIndex))
  );
  const resourcePart: ResourcePart = removeUndefinedDeep({
    type: "resource",
    mime: input.mime,
    url: input.url,
    name: input.name,
    width: input.width,
    height: input.height,
    extra: {
      placeholder: input.state === "pending" ? getGeneratedResourcePlaceholder(input.mime) : undefined,
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
  }) as ResourcePart;

  if (existingIndex === -1) {
    return [...parts, resourcePart];
  }

  return parts.map((part, index) => (index === existingIndex ? resourcePart : part));
}

/**
 * 根据 mime 类型决定 pending 占位控件的类型与文案。
 *
 * 前端依据返回的 type 渲染对应的"生成中"骨架（视频/文档/图片），
 * 让用户在资源尚未返回时就能看到符合预期的占位，而不是统一的转圈。
 */
function getGeneratedResourcePlaceholder(mime?: string) {
  if (mime?.startsWith("video/")) {
    return { type: "video" as const, label: "视频生成中" };
  }

  if (isDocumentMime(mime)) {
    return { type: "document" as const, label: "文档生成中" };
  }

  return { type: "image" as const, label: "图片生成中" };
}

/**
 * 判断某个 mime 是否属于"文档"类资源。
 *
 * 文档类在 UI 与占位上需要区别于图片/视频（例如展示为可下载文档），
 * 这里集中维护文档 mime 白名单，避免散落的重复判断导致口径不一致。
 */
function isDocumentMime(mime?: string) {
  return (
    mime?.startsWith("text/") ||
    mime === "application/markdown" ||
    mime === "application/pdf" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword"
  );
}

/**
 * 把 MessagePart 数组投影成若干行可读文本。
 *
 * 这是"结构化 part → LLM 文本"的唯一出口，所有 part 类型都经过这里；
 * includePendingResource 控制 pending 资源是否参与投影（给用户快照时需要，
 * 给 LLM 推理时不希望模型看到尚未可用的资源）。空行会被过滤，避免上下文
 * 出现无意义空行。
 */
function projectParts(parts: MessagePart[], options: { includePendingResource: boolean }): string[] {
  return parts
    .map((part) => (part.type === "text" ? projectTextPart(part) : projectResourcePart(part, options)))
    .filter((line) => line.trim().length > 0);
}

function projectTextPart(part: TextPart): string {
  const placeholder = part.extra?.placeholder;

  // 占位型文本在 UI 里可能是一个下拉/输入控件。
  // 投影给 LLM 时要变成"标签：用户选择"，否则模型只看到原始 value 会缺少语义。
  if (placeholder?.type === "select") {
    const selected = placeholder.options?.find((option) => option.value === part.value);
    return `${placeholder.label}：${selected?.label ?? part.value}`;
  }

  if ((placeholder?.type === "input" || placeholder?.type === "text") && !part.value) {
    return placeholder.defaultValue ?? placeholder.label;
  }

  return part.value;
}

function projectResourcePart(part: ResourcePart, options: { includePendingResource: boolean }): string {
  const state = part.extra?.lifecycle?.state;

  // resource part 对 LLM 的价值是"有什么资源、资源是否失败、资源地址是否可访问"。
  // base64、本地 blob 等前端专用地址不投影，避免上下文暴涨或给模型不可用链接。
  if (state === "pending" && !options.includePendingResource) {
    return "";
  }

  if (state === "failed") {
    const message = part.extra?.lifecycle?.error?.message;
    return message ? `资源生成失败：${message}` : "资源生成失败。";
  }

  const label = part.name ?? part.extra?.placeholder?.label ?? "资源";
  const resourceUrl = toProjectableResourceUrl(part.url);

  if (resourceUrl) {
    return `${label}：${resourceUrl}`;
  }

  return label;
}

/**
 * 把资源 url 规范成"可投影给 LLM"的形式：只接受 http/https。
 *
 * base64 data:、blob: 等前端专用地址对 LLM 没意义（模型既看不了也打不开），
 * 直接投影会让上下文暴涨或给模型不可用链接，因此统一在这里拦截。
 * 解析失败（非合法 URL）同样返回 undefined，保证投影层不会抛错。
 */
function toProjectableResourceUrl(url?: string): string | undefined {
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

/**
 * 递归剔除对象/数组里的 undefined 字段。
 *
 * 生成资源 part 时大量字段是可选的（pending 阶段 url/name 往往没有），
 * 若不剔除，写入与序列化时会出现显式 undefined，既不干净也可能触发
 * 某些校验。这里递归处理嵌套结构与数组，保证最终结果不含 undefined。
 */
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
