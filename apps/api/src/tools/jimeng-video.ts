import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors/app-error.js";
import type { JsonObject, RegisteredTool, ToolExecutionContext } from "./types.js";

const VOLCENGINE_ENDPOINT = "https://visual.volcengineapi.com";
const VOLCENGINE_VERSION = "2022-08-31";
const DEFAULT_REGION = "cn-north-1";
const DEFAULT_SERVICE = "cv";
const DEFAULT_TEXT_TO_VIDEO_REQ_KEY = "jimeng_t2v_v30";
const DEFAULT_FIRST_FRAME_REQ_KEY = "jimeng_i2v_first_v30";
const DEFAULT_FIRST_LAST_FRAME_REQ_KEY = "jimeng_i2v_first_tail_v30";
const DEFAULT_SEED = -1;
const DEFAULT_FRAMES = 121;
const DEFAULT_ASPECT_RATIO = "16:9";
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_MAX_POLL_ATTEMPTS = 80;
const DEFAULT_TOOL_TIMEOUT_MS = 600000;

const httpImageUrlSchema = z
  .string()
  .trim()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "图片地址只支持 http 或 https"
      });
    }
  });

const videoArgsSchema = z
  .object({
    prompt: z.string().trim().min(1).max(1200),
    frames: z.number().int().positive().max(241).optional(),
    aspectRatio: z.string().trim().regex(/^\d+:\d+$/).optional(),
    seed: z.number().int().min(-1).optional(),
    firstFrameImageUrl: httpImageUrlSchema.optional(),
    lastFrameImageUrl: httpImageUrlSchema.optional()
  })
  .superRefine((args, context) => {
    if (args.lastFrameImageUrl && !args.firstFrameImageUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastFrameImageUrl"],
        message: "lastFrameImageUrl 需要和 firstFrameImageUrl 一起传入"
      });
    }
  });

const videoResponseSchema = z
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
        video_url: z.string().optional()
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

type VideoArgs = z.infer<typeof videoArgsSchema>;
type VideoResponse = z.infer<typeof videoResponseSchema>;

export interface JimengVideoToolOptions {
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
  region?: string;
  service?: string;
  version?: string;
  reqKey?: string;
  firstFrameReqKey?: string;
  firstLastFrameReqKey?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  timeoutMs?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

interface VolcengineCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

interface JimengVideoResult {
  provider: "volcengine_jimeng_video";
  reqKey: string;
  taskId: string;
  status: "done";
  prompt: string;
  videoUrls: string[];
  seed: number;
  frames: number;
  aspectRatio: string;
  firstFrameImageUrl?: string;
  lastFrameImageUrl?: string;
}

interface VideoMode {
  reqKey: string;
  type: "text_to_video" | "first_frame" | "first_last_frame";
}

function toRequestUrl(endpoint: string, action: string, version: string) {
  const url = new URL(endpoint);
  url.searchParams.set("Action", action);
  url.searchParams.set("Version", version);
  return url;
}

function isLocalhost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

// 第三方服务（火山引擎）无法访问 localhost 地址的图片。
// 如果图片 URL 是 localhost，服务端先 fetch 下载再转 base64 提交。
// 生产环境用公网域名时（R2/CDN），火山引擎可以直接访问，不需要转 base64。
async function tryReadLocalUploadAsBase64(imageUrl: string) {
  const parsedUrl = new URL(imageUrl);

  if (!isLocalhost(parsedUrl.hostname)) {
    return undefined;
  }

  const response = await fetch(imageUrl);

  if (!response.ok) {
    throw new AppError("VALIDATION_ERROR", `读取本地图片失败，HTTP ${response.status}`, 400);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("base64");
}

async function toVideoFrameInput(frameUrls: string[]) {
  const base64Frames = await Promise.all(frameUrls.map((url) => tryReadLocalUploadAsBase64(url)));

  if (base64Frames.every(Boolean)) {
    return { binary_data_base64: base64Frames as string[] };
  }

  return { image_urls: frameUrls };
}

function selectVideoMode(
  args: VideoArgs,
  reqKeys: {
    textToVideoReqKey: string;
    firstFrameReqKey: string;
    firstLastFrameReqKey: string;
  }
): VideoMode {
  // 同一个 generate_video 工具覆盖三种上游能力：
  // 纯文生视频、首帧图生视频、首尾帧过渡视频。这里根据用户是否带图选择 reqKey。
  if (args.firstFrameImageUrl && args.lastFrameImageUrl) {
    return {
      type: "first_last_frame",
      reqKey: reqKeys.firstLastFrameReqKey
    };
  }

  if (args.firstFrameImageUrl) {
    return {
      type: "first_frame",
      reqKey: reqKeys.firstFrameReqKey
    };
  }

  return {
    type: "text_to_video",
    reqKey: reqKeys.textToVideoReqKey
  };
}

async function toSubmitBody(args: VideoArgs, mode: VideoMode) {
  if (mode.type === "text_to_video") {
    return {
      req_key: mode.reqKey,
      prompt: args.prompt,
      seed: args.seed ?? DEFAULT_SEED,
      frames: args.frames ?? DEFAULT_FRAMES,
      aspect_ratio: args.aspectRatio ?? DEFAULT_ASPECT_RATIO
    };
  }

  const frameUrls = [args.firstFrameImageUrl, args.lastFrameImageUrl].filter(Boolean) as string[];

  // 图生视频不传 aspect_ratio，让上游优先按首帧/首尾帧图片比例生成。
  return {
    req_key: mode.reqKey,
    prompt: args.prompt,
    ...(await toVideoFrameInput(frameUrls)),
    seed: args.seed ?? DEFAULT_SEED,
    frames: args.frames ?? DEFAULT_FRAMES
  };
}

function toGetResultBody(taskId: string, reqKey: string) {
  return {
    req_key: reqKey,
    task_id: taskId
  };
}

function renderVideoResultForLlm(result: JimengVideoResult) {
  return [
    `视频已生成完成，共 ${result.videoUrls.length} 个视频。`,
    "视频资源已交给前端界面展示。",
    "回复用户时不要输出视频链接、Markdown 链接、下载链接或任务 ID。"
  ].join("\n");
}

function ensureCredentials(options: JimengVideoToolOptions): VolcengineCredentials {
  const accessKeyId = options.accessKeyId?.trim();
  const secretAccessKey = options.secretAccessKey?.trim();

  if (!accessKeyId || !secretAccessKey) {
    throw new AppError("TOOL_EXECUTION_ERROR", "火山引擎 AK/SK 未配置，无法使用即梦视频生成", 500);
  }

  return { accessKeyId, secretAccessKey };
}

function ensureSuccessfulResponse(payload: VideoResponse, actionLabel: string) {
  if (payload.code === 10000) {
    return;
  }

  const volcError = payload.ResponseMetadata?.Error;
  const code = payload.code ?? payload.status ?? volcError?.Code ?? "UNKNOWN";
  const requestId = payload.request_id ?? payload.ResponseMetadata?.RequestId;
  const requestIdText = requestId ? `，request_id=${requestId}` : "";

  throw new AppError(
    "TOOL_EXECUTION_ERROR",
    `火山即梦视频生成${actionLabel}失败：${payload.message ?? volcError?.Message ?? code}${requestIdText}`,
    502
  );
}

function toAmzDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function toDateStamp(date: Date) {
  return toAmzDate(date).slice(0, 8);
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Buffer | string, value: string) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function getSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string) {
  const kDate = hmac(secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "request");
}

function signRequest(input: {
  url: URL;
  bodyText: string;
  credentials: VolcengineCredentials;
  region: string;
  service: string;
  date: Date;
}) {
  // 火山签名流程和图片工具一致：请求体 hash + canonical request + AK/SK 派生签名。
  // 放在工具内部是因为它只服务火山视觉接口，不污染通用 ToolExecutor。
  const amzDate = toAmzDate(input.date);
  const dateStamp = toDateStamp(input.date);
  const payloadHash = sha256Hex(input.bodyText);
  const host = input.url.host;
  const canonicalHeaders = [
    "content-type:application/json",
    `host:${host}`,
    `x-content-sha256:${payloadHash}`,
    `x-date:${amzDate}`
  ].join("\n");
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonicalRequest = [
    "POST",
    input.url.pathname || "/",
    input.url.searchParams.toString(),
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash
  ].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/${input.service}/request`;
  const stringToSign = ["HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmacHex(getSigningKey(input.credentials.secretAccessKey, dateStamp, input.region, input.service), stringToSign);

  return {
    "content-type": "application/json",
    host,
    "x-content-sha256": payloadHash,
    "x-date": amzDate,
    authorization: [
      `HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`
    ].join(", ")
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
  options: JimengVideoToolOptions;
  fetchImpl: typeof fetch;
  now: () => Date;
}) {
  // 这一层把 fetch、签名、响应格式校验、权限错误提示统一封装。
  // generateVideo 只负责业务流程：提交任务、轮询状态、拿最终视频 URL。
  const credentials = ensureCredentials(input.options);
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
  const payload = videoResponseSchema.safeParse(responseText ? JSON.parse(responseText) : {});

  if (!response.ok) {
    const parsedError = payload.success ? payload.data : undefined;
    const rawMessage =
      parsedError?.ResponseMetadata?.Error?.Message ??
      parsedError?.message ??
      responseText.slice(0, 200) ??
      "未知错误";
    const message = /access denied/i.test(rawMessage)
      ? "火山 AK/SK 已参与签名，但当前账号或密钥没有即梦AI-视频生成接口权限，请在火山控制台确认即梦AI-视频生成3.0 720P 服务已开通，并给该 AK 授权"
      : rawMessage;

    throw new AppError("TOOL_EXECUTION_ERROR", `火山即梦视频生成接口请求失败，HTTP ${response.status}：${message}`, 502);
  }

  if (!payload.success) {
    throw new AppError("TOOL_EXECUTION_ERROR", "火山即梦视频生成接口返回格式异常", 502);
  }

  return payload.data;
}

async function sleep(ms: number, signal?: AbortSignal) {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

export function createJimengVideoTool(options: JimengVideoToolOptions): RegisteredTool {
  const endpoint = options.endpoint ?? VOLCENGINE_ENDPOINT;
  const version = options.version ?? VOLCENGINE_VERSION;
  const region = options.region?.trim() || DEFAULT_REGION;
  const service = options.service?.trim() || DEFAULT_SERVICE;
  const textToVideoReqKey = options.reqKey?.trim() || DEFAULT_TEXT_TO_VIDEO_REQ_KEY;
  const firstFrameReqKey = options.firstFrameReqKey?.trim() || DEFAULT_FIRST_FRAME_REQ_KEY;
  const firstLastFrameReqKey = options.firstLastFrameReqKey?.trim() || DEFAULT_FIRST_LAST_FRAME_REQ_KEY;
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
      now
    });
  };

  const generateVideo = async (
    args: VideoArgs,
    mode: VideoMode,
    context: ToolExecutionContext
  ): Promise<{ taskId: string; videoUrl: string }> => {
    // 即梦视频生成也是异步任务：提交后只拿 taskId，真正的视频 URL 要轮询获取。
    // 轮询过程使用 context.signal，所以用户取消 run 时这里会尽快停止等待。
    const submitPayload = await request("CVSync2AsyncSubmitTask", await toSubmitBody(args, mode), context);
    ensureSuccessfulResponse(submitPayload, "提交任务");

    const taskId = submitPayload.data?.task_id ?? submitPayload.task_id;

    if (!taskId) {
      throw new AppError("TOOL_EXECUTION_ERROR", "火山即梦视频生成提交任务成功但没有返回 task_id", 502);
    }

    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      const resultPayload = await request("CVSync2AsyncGetResult", toGetResultBody(taskId, mode.reqKey), context);
      ensureSuccessfulResponse(resultPayload, "查询结果");

      const status = resultPayload.data?.status;

      if (status === "done") {
        const videoUrl = resultPayload.data?.video_url;

        if (!videoUrl) {
          throw new AppError("TOOL_EXECUTION_ERROR", "火山即梦视频生成任务完成但没有返回视频", 502);
        }

        return { taskId, videoUrl };
      }

      if (status === "not_found" || status === "expired") {
        throw new AppError("TOOL_EXECUTION_ERROR", `火山即梦视频生成任务状态异常：${status}`, 502);
      }

      await sleep(pollIntervalMs, context.signal);
    }

    throw new AppError("TOOL_EXECUTION_ERROR", "火山即梦视频生成任务未在限定时间内完成", 504);
  };

  return {
    name: "generate_video",
    description:
      "使用火山引擎即梦AI-视频生成3.0 720P 能力生成视频。支持文生视频、基于首帧图片生成视频、基于首尾帧图片生成视频。适合用户要求生成短视频、动态画面、动画镜头、视频素材，或让已有图片动起来/在两张图之间过渡的场景。",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "视频生成提示词，描述主体、动作、场景、镜头运动和风格。"
        },
        frames: {
          type: "number",
          description: "视频帧数，默认 121，约等于 5 秒视频。"
        },
        aspectRatio: {
          type: "string",
          description: "文生视频画幅比例，默认 16:9，例如 16:9、9:16、1:1。传入首帧或首尾帧图片时，通常由图片比例决定，不需要传。"
        },
        seed: {
          type: "number",
          description: "随机种子；-1 表示随机生成，默认 -1。"
        },
        firstFrameImageUrl: {
          type: "string",
          description:
            "可选。首帧图片 URL。用户要求基于某张图片生成视频、让图片动起来、以这张图作为视频开头时传入。支持 http/https；本地 /uploads 图片会由服务端转 base64 提交。"
        },
        lastFrameImageUrl: {
          type: "string",
          description:
            "可选。尾帧图片 URL，必须和 firstFrameImageUrl 一起传入。用户给出首尾两张图，或要求从第一张图过渡到第二张图时传入。"
        }
      },
      required: ["prompt"]
    },
    argumentSchema: videoArgsSchema,
    timeoutMs: options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    async execute(args: JsonObject, context: ToolExecutionContext) {
      const parsedArgs = videoArgsSchema.parse(args);
      ensureCredentials(options);

      const mode = selectVideoMode(parsedArgs, {
        textToVideoReqKey,
        firstFrameReqKey,
        firstLastFrameReqKey
      });
      const generated = await generateVideo(parsedArgs, mode, context);
      const result: JimengVideoResult = {
        provider: "volcengine_jimeng_video",
        reqKey: mode.reqKey,
        taskId: generated.taskId,
        status: "done",
        prompt: parsedArgs.prompt,
        videoUrls: [generated.videoUrl],
        seed: parsedArgs.seed ?? DEFAULT_SEED,
        frames: parsedArgs.frames ?? DEFAULT_FRAMES,
        aspectRatio: parsedArgs.aspectRatio ?? DEFAULT_ASPECT_RATIO,
        ...(parsedArgs.firstFrameImageUrl ? { firstFrameImageUrl: parsedArgs.firstFrameImageUrl } : {}),
        ...(parsedArgs.lastFrameImageUrl ? { lastFrameImageUrl: parsedArgs.lastFrameImageUrl } : {})
      };

      return {
        data: result,
        llmContent: renderVideoResultForLlm(result)
      };
    }
  };
}
