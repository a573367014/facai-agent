import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors/app-error.js";
import type { JsonObject, RegisteredTool, ToolExecutionContext } from "./types.js";

const VOLCENGINE_ENDPOINT = "https://visual.volcengineapi.com";
const VOLCENGINE_VERSION = "2022-08-31";
const DEFAULT_REGION = "cn-north-1";
const DEFAULT_SERVICE = "cv";
const DEFAULT_REQ_KEY = "high_aes_general_v30l_zt2i";
const DEFAULT_WIDTH = 1328;
const DEFAULT_HEIGHT = 1328;
const DEFAULT_SEED = -1;
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
type JimengResponse = z.infer<typeof jimengResponseSchema>;

export interface JimengImageToolOptions {
  accessKeyId?: string;
  secretAccessKey?: string;
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
  // 批量生图允许部分成功：如果这里只给总数，模型很容易误把已经成功的项目再次重试。
  // 所以这里刻意列出每个子任务的序号、prompt 和成功/失败状态，但仍然不放 URL/taskId/base64。
  const retryInstruction =
    result.failed > 0
      ? "如果需要继续处理，只重试失败项；不要重试已经成功的项目。"
      : "所有子任务均已完成，不需要重试。";

  return [
    `图片已生成，共 ${imageCount} 张。`,
    `批量生图完成：成功 ${result.succeeded} 项，失败 ${result.failed} 项。`,
    ...result.items.map(renderBatchItemForLlm),
    retryInstruction,
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

function ensureCredentials(options: JimengImageToolOptions): VolcengineCredentials {
  const accessKeyId = options.accessKeyId?.trim();
  const secretAccessKey = options.secretAccessKey?.trim();

  if (!accessKeyId || !secretAccessKey) {
    throw new AppError("TOOL_EXECUTION_ERROR", "火山引擎 AK/SK 未配置，无法使用通用文生图", 500);
  }

  return { accessKeyId, secretAccessKey };
}

function ensureSuccessfulResponse(payload: JimengResponse, actionLabel: string) {
  if (payload.code === 10000) {
    return;
  }

  const volcError = payload.ResponseMetadata?.Error;
  const code = payload.code ?? payload.status ?? volcError?.Code ?? "未知";
  const requestId = payload.request_id ?? payload.ResponseMetadata?.RequestId;
  const requestIdText = requestId ? `，request_id=${requestId}` : "";
  throw new AppError(
    "TOOL_EXECUTION_ERROR",
    `火山通用文生图${actionLabel}失败：${payload.message ?? volcError?.Message ?? code}${requestIdText}`,
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
    const credentials = ensureCredentials(options);
    const url = toRequestUrl(endpoint, action, version);
    const bodyText = JSON.stringify(body);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: signRequest({
        url,
        bodyText,
        credentials,
        region,
        service,
        date: now()
      }),
      body: bodyText,
      signal: context.signal
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
      const message = /access denied/i.test(rawMessage)
        ? "火山 AK/SK 已参与签名，但当前账号或密钥没有智能绘图（文生图）接口权限，请在火山控制台确认视觉智能/智能绘图（文生图）服务已开通，并给该 AK 授权"
        : rawMessage;
      throw new AppError("TOOL_EXECUTION_ERROR", `火山通用文生图接口请求失败，HTTP ${response.status}：${message}`, 502);
    }

    if (!payload.success) {
      throw new AppError("TOOL_EXECUTION_ERROR", "火山通用文生图接口返回格式异常", 502);
    }

    return payload.data;
  };

  const generateImageItem = async (item: ImageItemArgs, context: ToolExecutionContext): Promise<GeneratedImagePayload> => {
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
