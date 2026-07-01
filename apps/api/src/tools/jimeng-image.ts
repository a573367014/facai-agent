import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { z } from "zod";
import { AppError } from "../errors/app-error.js";
import type { JsonObject, RegisteredTool, ToolExecutionContext } from "./types.js";

const VOLCENGINE_ENDPOINT = "https://visual.volcengineapi.com";
const VOLCENGINE_VERSION = "2022-08-31";
const VOLCENGINE_SEEDEDIT_VERSION = VOLCENGINE_VERSION;
const DEFAULT_REGION = "cn-north-1";
const DEFAULT_SERVICE = "cv";
const DEFAULT_REQ_KEY = "high_aes_general_v30l_zt2i";
const DEFAULT_EDIT_REQ_KEY = "seededit_v3.0";
const DEFAULT_WIDTH = 1328;
const DEFAULT_HEIGHT = 1328;
const DEFAULT_SEED = -1;
const DEFAULT_EDIT_SCALE = 0.5;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_MAX_POLL_ATTEMPTS = 40;
const DEFAULT_TOOL_TIMEOUT_MS = 300000;
const DEFAULT_BATCH_CONCURRENCY = 2;
const MAX_BATCH_IMAGES = 5;

function validateImageDimensions(
  args: { width?: number; height?: number },
  context: z.RefinementCtx
) {
  if ((args.width && !args.height) || (!args.width && args.height)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["width"],
      message: "width 和 height 需要同时传入"
    });
    return;
  }

  if (!args.width || !args.height) {
    return;
  }

  const area = args.width * args.height;

  if (area > 2048 * 2048) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["width"],
      message: "width * height 需要小于等于 2048*2048"
    });
  }
}

const imageItemSchema = z
  .object({
    prompt: z.string().trim().min(1).max(800),
    width: z.number().int().positive().max(2048).optional(),
    height: z.number().int().positive().max(2048).optional(),
    seed: z.number().int().min(-1).optional(),
    usePreLlm: z.boolean().optional()
  })
  .superRefine(validateImageDimensions);

// 这个 schema 同时兼容两种调用形态：
// 1. 老的单张图片：{ prompt, width, height }
// 2. 新的批量图片：{ items: [{ prompt, width, height }, ...] }
// 真正的“必须二选一”放在 superRefine 里做，因为 JSON Schema 给 LLM 看时保留两个入口更直观。
const imageArgsSchema = z
  .object({
    prompt: z.string().trim().min(1).max(800).optional(),
    width: z.number().int().positive().max(2048).optional(),
    height: z.number().int().positive().max(2048).optional(),
    seed: z.number().int().min(-1).optional(),
    usePreLlm: z.boolean().optional(),
    items: z.array(imageItemSchema).min(1).max(MAX_BATCH_IMAGES).optional()
  })
  .superRefine((args, context) => {
    validateImageDimensions(args, context);

    if (!args.prompt && !args.items?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: "单张生图需要 prompt，批量生图需要 items"
      });
    }
  });

const httpImageUrlSchema = z
  .string()
  .trim()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "imageUrl 只支持 http 或 https 地址"
      });
    }
  });

const editImageArgsSchema = z.object({
  prompt: z.string().trim().min(1).max(800),
  imageUrl: httpImageUrlSchema,
  seed: z.number().int().min(-1).optional(),
  scale: z.number().min(0).max(1).optional()
});

const jimengResponseSchema = z
  .object({
    code: z.number().optional(),
    status: z.number().optional(),
    message: z.string().optional(),
    request_id: z.string().optional(),
    task_id: z.string().optional(),
    data: z
      .object({
        task_id: z.string().optional(),
        status: z.string().optional(),
        image_urls: z.array(z.string()).nullable().optional(),
        binary_data_base64: z.array(z.string()).nullable().optional()
      })
      .nullable()
      .optional(),
    ResponseMetadata: z
      .object({
        RequestId: z.string().optional(),
        Error: z
          .object({
            Code: z.string().optional(),
            Message: z.string().optional()
          })
          .passthrough()
          .optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

type ImageArgs = z.infer<typeof imageArgsSchema>;
type ImageItemArgs = z.infer<typeof imageItemSchema>;
type EditImageArgs = z.infer<typeof editImageArgsSchema>;
type JimengResponse = z.infer<typeof jimengResponseSchema>;

export interface JimengImageToolOptions {
  accessKeyId?: string;
  secretAccessKey?: string;
  uploadDirectory?: string;
  endpoint?: string;
  region?: string;
  service?: string;
  version?: string;
  reqKey?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  timeoutMs?: number;
  batchConcurrency?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

export type JimengImageEditToolOptions = JimengImageToolOptions;

interface GeneratedImagePayload {
  taskId: string;
  imageUrls: string[];
  binaryDataBase64: string[];
}

interface JimengImageSingleResult extends GeneratedImagePayload {
  provider: "volcengine_seedream";
  reqKey: string;
  status: "done";
  prompt: string;
}

type JimengImageBatchItem =
  | (GeneratedImagePayload & {
      index: number;
      status: "success";
      prompt: string;
      width: number;
      height: number;
      seed: number;
      usePreLlm?: boolean;
    })
  | {
      index: number;
      status: "failed";
      prompt: string;
      width: number;
      height: number;
      seed: number;
      usePreLlm?: boolean;
      error: string;
    };

type JimengImageBatchProgressItem =
  | JimengImageBatchItem
  | {
      index: number;
      status: "running";
      prompt: string;
      width: number;
      height: number;
      seed: number;
      usePreLlm?: boolean;
    };

interface JimengImageBatchResult {
  provider: "volcengine_seedream";
  reqKey: string;
  status: "done" | "partial_failed" | "failed";
  total: number;
  succeeded: number;
  failed: number;
  imageUrls: string[];
  binaryDataBase64: string[];
  items: JimengImageBatchItem[];
}

type JimengImageResult = JimengImageSingleResult | JimengImageBatchResult;

interface JimengImageEditResult extends GeneratedImagePayload {
  provider: "volcengine_seededit";
  reqKey: string;
  status: "done";
  prompt: string;
  imageUrl: string;
  seed: number;
  scale: number;
}

interface VolcengineCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

function toRequestUrl(endpoint: string, action: string, version: string) {
  const url = new URL(endpoint);
  url.searchParams.set("Action", action);
  url.searchParams.set("Version", version);
  return url;
}

function toSubmitBody(args: ImageItemArgs, reqKey: string) {
  return {
    req_key: reqKey,
    prompt: args.prompt,
    seed: args.seed ?? DEFAULT_SEED,
    width: args.width ?? DEFAULT_WIDTH,
    height: args.height ?? DEFAULT_HEIGHT,
    ...(args.usePreLlm !== undefined ? { use_pre_llm: args.usePreLlm } : {})
  };
}

function isLocalhost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isPathInside(basePath: string, targetPath: string) {
  const childPath = relative(basePath, targetPath);
  return childPath === "" || (!childPath.startsWith("..") && !childPath.startsWith(sep) && childPath !== "..");
}

async function tryReadLocalUploadAsBase64(imageUrl: string, uploadDirectory?: string) {
  if (!uploadDirectory) {
    return undefined;
  }

  // 当前 demo 的上传图片可能还是 localhost /uploads 地址，第三方服务访问不到。
  // 所以服务端在确认路径安全后，把本地文件转成 base64 直接提交给火山。
  const parsedUrl = new URL(imageUrl);

  if (!isLocalhost(parsedUrl.hostname) || !parsedUrl.pathname.startsWith("/uploads/")) {
    return undefined;
  }

  const relativeUploadPath = decodeURIComponent(parsedUrl.pathname.slice("/uploads/".length));
  const rootPath = resolve(uploadDirectory);
  const filePath = resolve(rootPath, relativeUploadPath);

  if (!isPathInside(rootPath, filePath)) {
    throw new AppError("VALIDATION_ERROR", "图片地址不在允许的上传目录内", 400);
  }

  // TODO: 后续上传切到 OSS/CDN 公网地址后，移除这段 localhost 图片转 base64 的兼容逻辑。
  const buffer = await readFile(filePath);
  return buffer.toString("base64");
}

async function toEditSubmitBody(args: EditImageArgs, reqKey: string, uploadDirectory?: string) {
  const localUploadBase64 = await tryReadLocalUploadAsBase64(args.imageUrl, uploadDirectory);

  return {
    req_key: reqKey,
    prompt: args.prompt,
    ...(localUploadBase64 ? { binary_data_base64: [localUploadBase64] } : { image_urls: [args.imageUrl] }),
    seed: args.seed ?? DEFAULT_SEED,
    scale: args.scale ?? DEFAULT_EDIT_SCALE
  };
}

function toGetResultBody(taskId: string, reqKey: string) {
  return {
    req_key: reqKey,
    task_id: taskId,
    req_json: JSON.stringify({ return_url: true })
  };
}

function toLlmSafeText(text: string, maxLength = 160) {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

function renderBatchItemForLlm(item: JimengImageBatchItem) {
  const label = `第 ${item.index + 1} 项`;
  const prompt = toLlmSafeText(item.prompt);

  if (item.status === "success") {
    const imageCount = item.imageUrls.length || item.binaryDataBase64.length;

    return `${label}成功：${prompt}（${imageCount} 张图片已交给前端展示）`;
  }

  return [`${label}失败：${prompt}`, `  原因：${toLlmSafeText(item.error, 240)}`].join("\n");
}

function renderBatchImageResultForLlm(result: JimengImageBatchResult) {
  const imageCount = result.imageUrls.length || result.binaryDataBase64.length;

  // llmContent 是“给模型看的工具观察结果”，不是给前端渲染的完整数据。
  // 批量生图允许部分成功：这里列出每个子任务的序号、prompt 和成功/失败状态，
  // 让后续最终回复能概括结果，但仍然不放 URL/taskId/base64，也不诱导长篇分析。
  const failureInstruction =
    result.failed > 0
      ? "请简短说明成功/失败数量和最关键失败原因；不要展开分析；不要自动重试失败项。"
      : "所有子任务均已完成。";

  return [
    `图片已生成，共 ${imageCount} 张。`,
    `批量生图完成：成功 ${result.succeeded} 项，失败 ${result.failed} 项。`,
    ...result.items.map(renderBatchItemForLlm),
    failureInstruction,
    "回复用户时不要输出图片链接、Markdown 图片、下载链接、任务 ID 或 base64 内容。"
  ].join("\n");
}

function renderImageResultForLlm(result: JimengImageResult) {
  if ("items" in result) {
    return renderBatchImageResultForLlm(result);
  }

  const imageCount = result.imageUrls.length || result.binaryDataBase64.length;

  // 工具结果里的 URL/base64 是给前端渲染用的，不让 LLM 再把它们写进正文。
  // 否则用户会同时看到 Markdown 链接和图片预览，后续复制/下载也更难统一交互。
  return [
    `图片已生成，共 ${imageCount} 张。`,
    "图片资源已交给前端界面展示。",
    "回复用户时不要输出图片链接、Markdown 图片、下载链接、任务 ID 或 base64 内容。"
  ].join("\n");
}

function renderEditImageResultForLlm(result: JimengImageEditResult) {
  const imageCount = result.imageUrls.length || result.binaryDataBase64.length;

  return [
    `图片已编辑完成，共 ${imageCount} 张。`,
    "图片资源已交给前端界面展示。",
    "回复用户时不要输出原图链接、生成图链接、Markdown 图片、下载链接、任务 ID 或 base64 内容。"
  ].join("\n");
}

function toImageItems(args: ImageArgs): ImageItemArgs[] {
  // execute 后面的主流程只关心“要生成哪些图片”。
  // 这里把单张调用也包成数组，后面就可以复用同一套提交/轮询逻辑。
  if (args.items?.length) {
    return args.items;
  }

  return [
    {
      prompt: args.prompt ?? "",
      width: args.width,
      height: args.height,
      seed: args.seed,
      usePreLlm: args.usePreLlm
    }
  ];
}

function toResolvedImageItem(item: ImageItemArgs) {
  return {
    prompt: item.prompt,
    width: item.width ?? DEFAULT_WIDTH,
    height: item.height ?? DEFAULT_HEIGHT,
    seed: item.seed ?? DEFAULT_SEED,
    usePreLlm: item.usePreLlm
  };
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "图片生成失败";
}

async function emitImageBatchProgress(
  context: ToolExecutionContext,
  total: number,
  item: JimengImageBatchProgressItem
) {
  await context.emitProgress?.({
    kind: "image_batch_item",
    total,
    item
  });
}

function ensureCredentials(options: JimengImageToolOptions, toolLabel = "通用文生图"): VolcengineCredentials {
  const accessKeyId = options.accessKeyId?.trim();
  const secretAccessKey = options.secretAccessKey?.trim();

  if (!accessKeyId || !secretAccessKey) {
    throw new AppError("TOOL_EXECUTION_ERROR", `火山引擎 AK/SK 未配置，无法使用${toolLabel}`, 500);
  }

  return { accessKeyId, secretAccessKey };
}

function ensureSuccessfulResponse(payload: JimengResponse, actionLabel: string, serviceLabel = "火山通用文生图") {
  if (payload.code === 10000) {
    return;
  }

  const volcError = payload.ResponseMetadata?.Error;
  const code = payload.code ?? payload.status ?? volcError?.Code ?? "未知";
  const requestId = payload.request_id ?? payload.ResponseMetadata?.RequestId;
  const requestIdText = requestId ? `，request_id=${requestId}` : "";
  throw new AppError(
    "TOOL_EXECUTION_ERROR",
    `${serviceLabel}${actionLabel}失败：${payload.message ?? volcError?.Message ?? code}${requestIdText}`,
    502
  );
}

function hashSha256Hex(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function hmacSha256(key: string | Buffer, content: string) {
  return createHmac("sha256", key).update(content).digest();
}

function hmacSha256Hex(key: string | Buffer, content: string) {
  return createHmac("sha256", key).update(content).digest("hex");
}

function toAmzDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function toShortDate(amzDate: string) {
  return amzDate.slice(0, 8);
}

function toCanonicalQuery(url: URL) {
  return [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) {
        return leftValue.localeCompare(rightValue);
      }

      return leftKey.localeCompare(rightKey);
    })
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function signRequest(input: {
  url: URL;
  bodyText: string;
  credentials: VolcengineCredentials;
  region: string;
  service: string;
  date: Date;
}) {
  // 火山接口使用 HMAC-SHA256 签名。签名的关键不是“加密 body”，
  // 而是把 method/path/query/headers/body hash 组成 canonical request，再用 AK/SK 证明请求确实由我们发出。
  const xDate = toAmzDate(input.date);
  const shortDate = toShortDate(xDate);
  const contentHash = hashSha256Hex(input.bodyText);
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonicalHeaders = [
    "content-type:application/json",
    `host:${input.url.host}`,
    `x-content-sha256:${contentHash}`,
    `x-date:${xDate}`
  ].join("\n");
  const canonicalRequest = [
    "POST",
    input.url.pathname || "/",
    toCanonicalQuery(input.url),
    `${canonicalHeaders}\n`,
    signedHeaders,
    contentHash
  ].join("\n");
  const credentialScope = `${shortDate}/${input.region}/${input.service}/request`;
  const stringToSign = ["HMAC-SHA256", xDate, credentialScope, hashSha256Hex(canonicalRequest)].join("\n");
  const dateKey = hmacSha256(input.credentials.secretAccessKey, shortDate);
  const regionKey = hmacSha256(dateKey, input.region);
  const serviceKey = hmacSha256(regionKey, input.service);
  const signingKey = hmacSha256(serviceKey, "request");
  const signature = hmacSha256Hex(signingKey, stringToSign);

  return {
    "content-type": "application/json",
    host: input.url.host,
    "x-date": xDate,
    "x-content-sha256": contentHash,
    authorization: `HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}

async function requestVolcengine(input: {
  action: string;
  body: Record<string, unknown>;
  context: ToolExecutionContext;
  endpoint: string;
  version: string;
  region: string;
  service: string;
  options: JimengImageToolOptions;
  fetchImpl: typeof fetch;
  now: () => Date;
  toolLabel: string;
  serviceLabel: string;
  permissionHint: string;
}) {
  // 所有火山请求都从这里出去：补签名、带 AbortSignal、解析统一响应、把上游错误翻译成 AppError。
  // 工具主流程只关心“提交任务/查结果”，不用重复写 HTTP 和鉴权细节。
  const credentials = ensureCredentials(input.options, input.toolLabel);
  const url = toRequestUrl(input.endpoint, input.action, input.version);
  const bodyText = JSON.stringify(input.body);
  const response = await input.fetchImpl(url, {
    method: "POST",
    headers: signRequest({
      url,
      bodyText,
      credentials,
      region: input.region,
      service: input.service,
      date: input.now()
    }),
    body: bodyText,
    signal: input.context.signal
  });

  const responseText = await response.text();
  const payload = jimengResponseSchema.safeParse(responseText ? JSON.parse(responseText) : {});

  if (!response.ok) {
    const parsedError = payload.success ? payload.data : undefined;
    const rawMessage =
      parsedError?.ResponseMetadata?.Error?.Message ??
      parsedError?.message ??
      responseText.slice(0, 200) ??
      "未知错误";
    const message = /access denied/i.test(rawMessage) ? input.permissionHint : rawMessage;
    throw new AppError("TOOL_EXECUTION_ERROR", `${input.serviceLabel}接口请求失败，HTTP ${response.status}：${message}`, 502);
  }

  if (!payload.success) {
    throw new AppError("TOOL_EXECUTION_ERROR", `${input.serviceLabel}接口返回格式异常`, 502);
  }

  return payload.data;
}

async function sleep(ms: number, signal?: AbortSignal) {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timeoutId);
    };
    const finish = () => {
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new AppError("TOOL_EXECUTION_ERROR", "火山通用文生图已取消", 499));
    };
    const timeoutId = setTimeout(finish, ms);

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createJimengImageTool(options: JimengImageToolOptions): RegisteredTool {
  const endpoint = options.endpoint ?? VOLCENGINE_ENDPOINT;
  const version = options.version ?? VOLCENGINE_VERSION;
  const region = options.region?.trim() || DEFAULT_REGION;
  const service = options.service?.trim() || DEFAULT_SERVICE;
  const reqKey = options.reqKey?.trim() || DEFAULT_REQ_KEY;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPollAttempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
  const batchConcurrency = Math.max(1, Math.min(MAX_BATCH_IMAGES, options.batchConcurrency ?? DEFAULT_BATCH_CONCURRENCY));
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  const request = async (action: string, body: Record<string, unknown>, context: ToolExecutionContext) => {
    return requestVolcengine({
      action,
      body,
      context,
      endpoint,
      version,
      region,
      service,
      options,
      fetchImpl,
      now,
      toolLabel: "通用文生图",
      serviceLabel: "火山通用文生图",
      permissionHint:
        "火山 AK/SK 已参与签名，但当前账号或密钥没有智能绘图（文生图）接口权限，请在火山控制台确认视觉智能/智能绘图（文生图）服务已开通，并给该 AK 授权"
    });
  };

  const generateImageItem = async (item: ImageItemArgs, context: ToolExecutionContext): Promise<GeneratedImagePayload> => {
    // 火山生图是 submit + poll 模式：
    // 第一步提交任务拿 taskId，第二步按间隔查询，直到 done/异常/超时。
    const submitPayload = await request("CVSync2AsyncSubmitTask", toSubmitBody(item, reqKey), context);
    ensureSuccessfulResponse(submitPayload, "提交任务");

    const taskId = submitPayload.data?.task_id ?? submitPayload.task_id;

    if (!taskId) {
      throw new AppError("TOOL_EXECUTION_ERROR", "火山通用文生图提交任务成功但没有返回 task_id", 502);
    }

    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      const resultPayload = await request("CVSync2AsyncGetResult", toGetResultBody(taskId, reqKey), context);
      ensureSuccessfulResponse(resultPayload, "查询结果");

      const status = resultPayload.data?.status;

      if (status === "done") {
        const imageUrls = resultPayload.data?.image_urls ?? [];
        const binaryDataBase64 = resultPayload.data?.binary_data_base64 ?? [];

        if (imageUrls.length === 0 && binaryDataBase64.length === 0) {
          throw new AppError("TOOL_EXECUTION_ERROR", "火山通用文生图任务完成但没有返回图片", 502);
        }

        return {
          taskId,
          imageUrls,
          binaryDataBase64
        };
      }

      // not_found/expired 不是“继续等就会好”的状态，直接失败能让上层尽快给用户反馈。
      if (status === "not_found" || status === "expired") {
        throw new AppError("TOOL_EXECUTION_ERROR", `火山通用文生图任务状态异常：${status}`, 502);
      }

      await sleep(pollIntervalMs, context.signal);
    }

    throw new AppError("TOOL_EXECUTION_ERROR", "火山通用文生图任务未在限定时间内完成", 504);
  };

  return {
    name: "generate_image",
    description:
      "使用火山引擎 Seedream 通用3.0 文生图生成图片。适合用户明确要求画图、生成图片、设计视觉方案、制作海报插图或基于提示词出图的场景。",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "单张图片生成提示词。用户要求多张图片时不要使用 prompt，请使用 items 一次传入最多 5 个子任务。"
        },
        width: {
          type: "number",
          description: "可选输出宽度，需要和 height 同时传入；不传默认 1328。"
        },
        height: {
          type: "number",
          description: "可选输出高度，需要和 width 同时传入；不传默认 1328。"
        },
        seed: {
          type: "number",
          description: "随机种子；-1 表示随机生成，默认 -1。"
        },
        usePreLlm: {
          type: "boolean",
          description: "是否开启文本扩写；短 prompt 可以设为 true，默认 false。"
        },
        items: {
          type: "array",
          description:
            "批量生图子任务列表，最多 5 个。用户要求多张、不同风格或不同宽高时，优先使用 items，一次 tool call 内完成，不要拆成多次 generate_image 调用。",
          minItems: 1,
          maxItems: MAX_BATCH_IMAGES,
          items: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description: "当前子任务的图片提示词。"
              },
              width: {
                type: "number",
                description: "当前子任务输出宽度，需要和 height 同时传入；不传默认 1328。"
              },
              height: {
                type: "number",
                description: "当前子任务输出高度，需要和 width 同时传入；不传默认 1328。"
              },
              seed: {
                type: "number",
                description: "当前子任务随机种子；-1 表示随机生成，默认 -1。"
              },
              usePreLlm: {
                type: "boolean",
                description: "当前子任务是否开启文本扩写；短 prompt 可以设为 true，默认 false。"
              }
            },
            required: ["prompt"]
          }
        }
      },
      required: []
    },
    argumentSchema: imageArgsSchema,
    timeoutMs: options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    async execute(args: JsonObject, context: ToolExecutionContext) {
      const parsedArgs = imageArgsSchema.parse(args);
      const imageItems = toImageItems(parsedArgs);

      // AK/SK 缺失属于服务配置错误，批量模式下也应该整体失败，
      // 不能把多个子任务都包装成业务失败，否则会误导用户以为只是个别图片失败。
      ensureCredentials(options);

      if (!parsedArgs.items?.length) {
        const [item] = imageItems;
        const generated = await generateImageItem(item, context);
        const result: JimengImageSingleResult = {
          provider: "volcengine_seedream",
          reqKey,
          taskId: generated.taskId,
          status: "done",
          prompt: item.prompt,
          imageUrls: generated.imageUrls,
          binaryDataBase64: generated.binaryDataBase64
        };

        return {
          data: result,
          llmContent: renderImageResultForLlm(result)
        };
      }

      // 批量模式保持一次 tool call，但内部用有限并发执行。
      // 并发数默认 2：比严格顺序更快，又不会一次性把所有任务全打到上游，后续积分扣费和限流也更可控。
      const items: JimengImageBatchItem[] = [];
      let nextIndex = 0;

      const runNextItem = async () => {
        // 多个 worker 共享 nextIndex，实现一个很轻量的并发队列。
        // JS 单线程下这里不会出现两个 worker 抢到同一个 index 的问题。
        while (nextIndex < imageItems.length) {
          if (context.signal?.aborted) {
            return;
          }

          const index = nextIndex;
          nextIndex += 1;
          const item = imageItems[index];
          const resolvedItem = toResolvedImageItem(item);

          await emitImageBatchProgress(context, imageItems.length, {
            index,
            status: "running",
            ...resolvedItem
          });

          try {
            const generated = await generateImageItem(item, context);
            const successItem: Extract<JimengImageBatchItem, { status: "success" }> = {
              index,
              status: "success",
              ...resolvedItem,
              taskId: generated.taskId,
              imageUrls: generated.imageUrls,
              binaryDataBase64: generated.binaryDataBase64
            };

            items[index] = successItem;
            await emitImageBatchProgress(context, imageItems.length, successItem);
          } catch (error) {
            const failedItem: Extract<JimengImageBatchItem, { status: "failed" }> = {
              index,
              status: "failed",
              ...resolvedItem,
              error: toErrorMessage(error)
            };

            items[index] = failedItem;
            await emitImageBatchProgress(context, imageItems.length, failedItem);
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(batchConcurrency, imageItems.length) }, () => runNextItem())
      );

      const succeededItems = items.filter(
        (item): item is Extract<JimengImageBatchItem, { status: "success" }> => item.status === "success"
      );
      const failed = items.length - succeededItems.length;
      // 批量工具不因为单项失败就整体 throw。把 partial_failed 返回给 Agent，
      // 前端可以展示成功图片，LLM 也能基于 llmContent 给用户简短说明失败项。
      const result: JimengImageBatchResult = {
        provider: "volcengine_seedream",
        reqKey,
        status: failed === 0 ? "done" : succeededItems.length > 0 ? "partial_failed" : "failed",
        total: items.length,
        succeeded: succeededItems.length,
        failed,
        imageUrls: succeededItems.flatMap((item) => item.imageUrls),
        binaryDataBase64: succeededItems.flatMap((item) => item.binaryDataBase64),
        items
      };

      return {
        data: result,
        llmContent: renderImageResultForLlm(result)
      };
    }
  };
}

export function createJimengImageEditTool(options: JimengImageEditToolOptions): RegisteredTool {
  const endpoint = options.endpoint ?? VOLCENGINE_ENDPOINT;
  const version = options.version ?? VOLCENGINE_SEEDEDIT_VERSION;
  const region = options.region?.trim() || DEFAULT_REGION;
  const service = options.service?.trim() || DEFAULT_SERVICE;
  const reqKey = options.reqKey?.trim() || DEFAULT_EDIT_REQ_KEY;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPollAttempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  const request = async (action: string, body: Record<string, unknown>, context: ToolExecutionContext) => {
    return requestVolcengine({
      action,
      body,
      context,
      endpoint,
      version,
      region,
      service,
      options,
      fetchImpl,
      now,
      toolLabel: "SeedEdit3.0 图片编辑",
      serviceLabel: "火山 SeedEdit3.0",
      permissionHint:
        "火山 AK/SK 已参与签名，但当前账号或密钥没有即梦 AI 图片生成/图像编辑接口权限，请在火山控制台确认即梦AI-图片生成服务已开通，并给该 AK 授权"
    });
  };

  const editImage = async (args: EditImageArgs, context: ToolExecutionContext): Promise<GeneratedImagePayload> => {
    // 图生图和文生图共用火山的异步任务模型，只是提交 body 多了原图输入。
    // 本地上传图会在 toEditSubmitBody 里转换成 base64，公网图则直接传 image_urls。
    const submitPayload = await request(
      "CVSync2AsyncSubmitTask",
      await toEditSubmitBody(args, reqKey, options.uploadDirectory),
      context
    );
    ensureSuccessfulResponse(submitPayload, "提交任务", "火山 SeedEdit3.0");

    const taskId = submitPayload.data?.task_id ?? submitPayload.task_id;

    if (!taskId) {
      throw new AppError("TOOL_EXECUTION_ERROR", "火山 SeedEdit3.0 提交任务成功但没有返回 task_id", 502);
    }

    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      const resultPayload = await request("CVSync2AsyncGetResult", toGetResultBody(taskId, reqKey), context);
      ensureSuccessfulResponse(resultPayload, "查询结果", "火山 SeedEdit3.0");

      const status = resultPayload.data?.status;

      if (status === "done") {
        const imageUrls = resultPayload.data?.image_urls ?? [];
        const binaryDataBase64 = resultPayload.data?.binary_data_base64 ?? [];

        if (imageUrls.length === 0 && binaryDataBase64.length === 0) {
          throw new AppError("TOOL_EXECUTION_ERROR", "火山 SeedEdit3.0 任务完成但没有返回图片", 502);
        }

        return {
          taskId,
          imageUrls,
          binaryDataBase64
        };
      }

      if (status === "not_found" || status === "expired") {
        throw new AppError("TOOL_EXECUTION_ERROR", `火山 SeedEdit3.0 任务状态异常：${status}`, 502);
      }

      await sleep(pollIntervalMs, context.signal);
    }

    throw new AppError("TOOL_EXECUTION_ERROR", "火山 SeedEdit3.0 任务未在限定时间内完成", 504);
  };

  return {
    name: "edit_image",
    description:
      "使用火山引擎 SeedEdit3.0 根据输入图片和编辑指令生成新图片。适合用户要求修改、重绘、换风格、替换局部、基于已有图片继续创作的场景。",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "图片编辑指令，描述要保留什么、修改什么，以及目标风格。"
        },
        imageUrl: {
          type: "string",
          description: "需要编辑的源图片 URL。当前 demo 直接传 http/https URL，后续会增加 CDN 白名单校验。"
        },
        seed: {
          type: "number",
          description: "随机种子；-1 表示随机生成，默认 -1。"
        },
        scale: {
          type: "number",
          description: "编辑强度，0 到 1，默认 0.5；越高越贴近编辑指令，越低越保留原图。"
        }
      },
      required: ["prompt", "imageUrl"]
    },
    argumentSchema: editImageArgsSchema,
    timeoutMs: options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    async execute(args: JsonObject, context: ToolExecutionContext) {
      const parsedArgs = editImageArgsSchema.parse(args);

      ensureCredentials(options, "SeedEdit3.0 图片编辑");

      const generated = await editImage(parsedArgs, context);
      const result: JimengImageEditResult = {
        provider: "volcengine_seededit",
        reqKey,
        taskId: generated.taskId,
        status: "done",
        prompt: parsedArgs.prompt,
        imageUrl: parsedArgs.imageUrl,
        imageUrls: generated.imageUrls,
        binaryDataBase64: generated.binaryDataBase64,
        seed: parsedArgs.seed ?? DEFAULT_SEED,
        scale: parsedArgs.scale ?? DEFAULT_EDIT_SCALE
      };

      return {
        data: result,
        llmContent: renderEditImageResultForLlm(result)
      };
    }
  };
}
