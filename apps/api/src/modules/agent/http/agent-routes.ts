/**
 * Agent HTTP 路由层。
 *
 * 本文件是 Agent 系统的 HTTP 入口，负责把外部 HTTP 请求转交给
 * AgentMessageCoordinator（消息协调器），再把结果序列化成 HTTP 响应。
 * 它是"传输层"和"业务层"之间的边界。
 *
 * 职责：
 * 1. 用 Zod schema 校验请求体/参数/查询参数，拒绝非法输入；
 * 2. 从请求中提取认证用户身份（userId），透传给 coordinator 做权限隔离；
 * 3. 处理 SSE 流式响应（/agents/runs/:runId/stream），包括断线重连恢复；
 * 4. 处理文件上传（图片走 S3，文档走本地文件系统）；
 * 5. 调用 agent-response-mappers 把内部 Record 转成对外 DTO。
 *
 * 边界说明：本文件不含业务逻辑——不调 LLM、不执行工具、不操作数据库。
 * 所有业务逻辑委托给 coordinator。路由层只管"HTTP 协议适配 + 输入校验 +
 * 响应序列化"。
 */
import type { OutgoingHttpHeaders } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentMessageCoordinator } from "../agent-message-coordinator.js";
import type { StoredAgentEvent } from "../agent-store.js";
import {
  createTextPart,
  partsToLlmText,
  stripRuntimePartFields,
  type MessagePart
} from "../message-parts.js";
import { getAuthenticatedUser } from "../../auth/auth-guard.js";
import { getRequestTraceContext } from "../../../platform/observability/trace-context.js";
import { readAttachmentBuffer, waitForUploadResponseDelay } from "../../../platform/storage/attachment-upload.js";
import { getS3Bucket, getS3Client, getS3ObjectUrl } from "../../../platform/storage/s3-client.js";
import { AppError } from "../../../shared/errors/app-error.js";
import {
  toAgentMessageDetailResponse,
  toAgentRunDetailResponse,
  toAgentSessionDto,
  toAgentSessionMessagesResponse,
  toAgentSessionResponse,
  toAgentSessionsResponse,
  toCancelAgentRunResponse,
  toRegenerateAgentMessageResponse,
  toStartAgentRunResponse
} from "./agent-response-mappers.js";

/**
 * 请求体/参数/查询参数的 Zod 校验 schema 集合。
 *
 * 所有 HTTP 输入在进入业务逻辑前都先过 Zod 校验，确保类型安全。
 * 用 Zod 而非手写校验：schema 既是运行时校验器，又是 TypeScript 类型来源，
 * 一份定义两用，避免"校验逻辑和类型声明不一致"的问题。
 */
const partExtraSchema = z.record(z.unknown());
const textPartSchema = z
  .object({
    type: z.literal("text"),
    value: z.string(),
    extra: partExtraSchema.optional()
  })
  .passthrough();
const resourcePartSchema = z
  .object({
    type: z.literal("resource"),
    mime: z.string().min(1).optional(),
    url: z.string().optional(),
    name: z.string().optional(),
    size: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    extra: partExtraSchema.optional()
  })
  .passthrough();
/**
 * 消息片段的判别联合：根据 type 字段区分文本片段和资源片段。
 * 用 discriminatedUnion 而非普通 union，性能更好且类型推导更精确。
 */
const messagePartSchema = z.discriminatedUnion("type", [textPartSchema, resourcePartSchema]);
const messageRequestSchema = z.object({
  input: z.string().trim().min(1).optional(),
  parts: z.array(messagePartSchema).min(1).optional(),
  maxIterations: z.number().int().min(1).max(8).optional()
});
const messageStartRequestSchema = messageRequestSchema.extend({
  sessionId: z.string().min(1).optional()
});
const sessionRequestSchema = z.object({
  title: z.string().trim().min(1).optional()
});
const sessionsQuerySchema = z.object({
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});
const messageParamsSchema = z.object({
  messageId: z.string().min(1)
});
const runParamsSchema = z.object({
  runId: z.string().min(1)
});
const sessionParamsSchema = z.object({
  sessionId: z.string().min(1)
});
const sessionMessagesQuerySchema = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});
/**
 * 图片 MIME 类型到文件扩展名的映射表。
 * 用于上传图片时根据 MIME 确定存储文件名的后缀。
 */
const imageMimeExtensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg"
};
/**
 * 文档 MIME 类型到文件扩展名的映射表。
 * 用于上传文档时根据 MIME 确定存储文件名的后缀。
 */
const documentMimeExtensions: Record<string, string> = {
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/markdown": ".md",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx"
};
/**
 * 未认证请求的默认用户标识。
 * 当 auth-guard 取不到用户身份时用这个兜底，保证路由不会因为缺认证而崩溃。
 */
const defaultRouteUserId = "user_system";

/**
 * 路由注册的可选配置。
 *
 * - uploadDirectory：文档上传的本地存储根目录，不配则文档上传不可用；
 * - publicBaseUrl：生成文档访问 URL 时的基础地址，缺省时用请求 Host 头；
 * - uploadResponseDelayMs：上传响应前的延迟，用于测试/限流场景。
 */
export interface RegisterAgentRoutesOptions {
  uploadDirectory?: string;
  publicBaseUrl?: string;
  uploadResponseDelayMs?: number;
}

/**
 * 解析并校验消息请求体（不含 sessionId）。
 *
 * 要求 input 和 parts 至少有一个非空，否则报 400。
 * 校验通过后调用 normalizeMessageRequest 做归一化处理。
 */
function parseMessageRequest(body: unknown) {
  const parsed = messageRequestSchema.safeParse(body);

  if (!parsed.success || (!parsed.data.input && !parsed.data.parts?.length)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "input 必须是非空字符串，或 parts 必须是非空消息片段数组，maxIterations 必须是 1 到 8 之间的整数",
      400
    );
  }

  return normalizeMessageRequest(parsed.data);
}

function parseMessageStartRequest(body: unknown) {
  const parsed = messageStartRequestSchema.safeParse(body);

  if (!parsed.success || (!parsed.data.input && !parsed.data.parts?.length)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "input 必须是非空字符串，或 parts 必须是非空消息片段数组，maxIterations 必须是 1 到 8 之间的整数",
      400
    );
  }

  return normalizeMessageRequest(parsed.data);
}

/**
 * 把校验后的消息请求归一化为统一结构。
 *
 * 核心逻辑：如果用户传了 parts（结构化输入），就用 parts；
 * 否则把 input 文本包成一个 text part。最终统一输出 parts + 投影后的
 * 纯文本 input（给 LLM 用）。
 *
 * projectedInput 用 partsToLmText 从 parts 提取文本，如果提取不到
 * 就降级用原始 input。这样无论用户传的是纯文本还是结构化片段，
 * 下游都能拿到一份统一的 input 文本。
 */
function normalizeMessageRequest(input: z.infer<typeof messageStartRequestSchema>) {
  const parts = input.parts?.length
    ? stripRuntimePartFields(input.parts as Array<MessagePart & Record<string, unknown>>)
    : [createTextPart(input.input ?? "")];
  const projectedInput = partsToLlmText(parts) || input.input?.trim() || "";

  return {
    input: projectedInput,
    parts,
    maxIterations: input.maxIterations,
    sessionId: "sessionId" in input ? input.sessionId : undefined
  };
}

function parseSessionRequest(body: unknown) {
  const parsed = sessionRequestSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "title 必须是非空字符串", 400);
  }

  return parsed.data;
}

function parseMessageParams(params: unknown) {
  const parsed = messageParamsSchema.safeParse(params);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "messageId 必须是非空字符串", 400);
  }

  return parsed.data;
}

function parseRunParams(params: unknown) {
  const parsed = runParamsSchema.safeParse(params);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "runId 必须是非空字符串", 400);
  }

  return parsed.data;
}

function parseSessionParams(params: unknown) {
  const parsed = sessionParamsSchema.safeParse(params);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "sessionId 必须是非空字符串", 400);
  }

  return parsed.data;
}

function parseSessionsQuery(query: unknown) {
  const parsed = sessionsQuerySchema.safeParse(query);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "after 必须是非空字符串，limit 必须是 1 到 100 之间的整数", 400);
  }

  return parsed.data;
}

function parseSessionMessagesQuery(query: unknown) {
  const parsed = sessionMessagesQuerySchema.safeParse(query);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "before 必须是非空字符串，limit 必须是 1 到 100 之间的整数", 400);
  }

  return parsed.data;
}

/**
 * 把一条存储的事件格式化为 SSE 数据帧。
 *
 * SSE 协议要求每条消息格式为 "id: xxx\ndata: xxx\n\n"，
 * 这里严格按规范拼接。id 字段让客户端断线重连后能用 Last-Event-ID
 * 续传，不会丢事件。
 */
function formatStoredSseEvent(event: StoredAgentEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * 判断一条事件是否是终止事件。
 *
 * run_completed / error / cancelled 三种状态意味着 run 已经结束，
 * SSE 连接应该在推送完这条事件后关闭。不判断的话客户端会一直挂着
 * 等不到结束信号。
 */
function isTerminalStoredEvent(event: StoredAgentEvent): boolean {
  return event.event.type === "run_completed" || event.event.type === "error" || event.event.type === "cancelled";
}

/**
 * 构建 SSE 响应头。
 *
 * 三个关键头：
 * - content-type: text/event-stream —— 声明这是 SSE 流；
 * - cache-control: no-cache, no-transform —— 禁止缓存和代理改写，
 *   否则中间代理可能缓冲整个流，导致前端收不到实时数据；
 * - connection: keep-alive —— 保持长连接。
 *
 * 同时透传 reply 上已有的头（如 CORS），不覆盖。
 */
function buildSseHeaders(headers: Record<string, number | string | string[] | undefined>): OutgoingHttpHeaders {
  const sseHeaders: OutgoingHttpHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      sseHeaders[key] = value;
    }
  }

  sseHeaders["content-type"] = "text/event-stream; charset=utf-8";
  sseHeaders["cache-control"] = "no-cache, no-transform";
  sseHeaders.connection = "keep-alive";

  return sseHeaders;
}

/**
 * 构造一条"实时"事件（非持久化存储的事件）。
 *
 * 有些事件（如 message.snapshot）是 SSE 连接建立时临时生成的，
 * 不需要也不应该写入事件存储。用 transient: true 标记，让下游知道
 * 这条事件是临时的，不需要持久化。id 用 "event_live_" 前缀加 UUID，
 * 保证唯一且可识别。
 */
function createLiveSseEvent(input: {
  messageId?: string;
  runId?: string;
  event: StoredAgentEvent["event"];
}): StoredAgentEvent {
  return {
    id: `event_live_${randomUUID()}`,
    messageId: input.messageId,
    runId: input.runId,
    event: input.event,
    createdAt: new Date().toISOString(),
    transient: true
  };
}

/**
 * 根据图片 MIME 类型和原始文件名确定存储扩展名。
 *
 * 优先用 MIME 映射表（更可靠），映射不到时从文件名提取扩展名，
 * 都不行就用 .img 兜底。保证存储文件名总有合法后缀。
 */
function getImageExtension(mime: string, fileName: string) {
  const mimeExtension = imageMimeExtensions[mime.toLowerCase()];

  if (mimeExtension) {
    return mimeExtension;
  }

  const extension = basename(fileName).match(/\.[a-zA-Z0-9]+$/)?.[0];
  return extension ? extension.toLowerCase() : ".img";
}

/**
 * 根据文档文件名和 MIME 类型确定存储扩展名。
 *
 * 优先从文件名提取扩展名（用户上传的文件名通常带正确后缀），
 * 提取不到时用 MIME 映射表兜底，都不行用 .bin。
 */
function getDocumentExtension(name: string, mimeType: string) {
  const extension = extname(name);

  if (extension) {
    return extension.toLowerCase();
  }

  return documentMimeExtensions[mimeType.toLowerCase()] ?? ".bin";
}

/**
 * 根据文档文件名反推 MIME 类型。
 *
 * 当客户端上传时没带正确的 Content-Type 时，用文件名后缀兜底推断。
 * 不识别的后缀统一返回 application/octet-stream（二进制流）。
 */
function getDocumentMimeTypeFromName(name: string): string {
  const lowerName = name.toLowerCase();

  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) {
    return "text/markdown";
  }

  if (lowerName.endsWith(".txt")) {
    return "text/plain";
  }

  if (lowerName.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  if (lowerName.endsWith(".doc")) {
    return "application/msword";
  }

  return "application/octet-stream";
}

/**
 * 归一化文档 MIME 类型。
 *
 * 客户端传的 mimeType 可能带 charset 参数（如 "text/plain; charset=utf-8"），
 * 这里先取分号前的纯类型部分。如果结果是通用二进制类型（octet-stream），
 * 再用文件名推断更精确的类型。确保下游拿到的 MIME 是干净可用的。
 */
function normalizeAgentDocumentMime(mimeType: string, name: string): string {
  const normalizedMime = mimeType.split(";")[0]?.trim().toLowerCase() || getDocumentMimeTypeFromName(name);

  if (normalizedMime === "application/octet-stream") {
    return getDocumentMimeTypeFromName(name);
  }

  return normalizedMime;
}

/**
 * 判断上传的文档是否是 Agent 支持的输入类型。
 *
 * 只支持纯文本、Markdown 和 Word 文档。其他类型（如 PDF）不支持，
 * 因为当前 Agent 的文档解析能力有限。用 MIME 前缀和文件名后缀双重判断，
 * 避免漏判。
 */
function isSupportedAgentInputDocument(input: { mimeType: string; name: string }) {
  const lowerName = input.name.toLowerCase();
  return (
    input.mimeType.startsWith("text/") ||
    input.mimeType === "application/markdown" ||
    input.mimeType === "text/markdown" ||
    input.mimeType === "application/msword" ||
    input.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".markdown") ||
    lowerName.endsWith(".doc") ||
    lowerName.endsWith(".docx")
  );
}

/**
 * 获取文档访问的基础 URL。
 *
 * 优先用配置的 publicBaseUrl，缺省时从请求 Host 头构造。
 * 末尾斜杠会被去掉，保证拼接路径时不会出现双斜杠。
 */
function getPublicBaseUrl(options: RegisterAgentRoutesOptions, request: FastifyRequest): string {
  const fallbackHost = request.headers.host ?? "127.0.0.1:4001";
  return (options.publicBaseUrl ?? `http://${fallbackHost}`).replace(/\/$/, "");
}

/**
 * 从请求中提取认证用户 ID。
 *
 * 通过 auth-guard 获取已认证用户的 sub（subject），取不到时用
 * defaultRouteUserId 兜底。所有 coordinator 调用都带 userId，
 * 确保数据隔离——不同用户只能看到自己的 session 和消息。
 */
function getRequestUserId(request: FastifyRequest): string {
  return getAuthenticatedUser(request)?.sub ?? defaultRouteUserId;
}

/**
 * 注册所有 Agent 相关的 HTTP 路由。
 *
 * 路由清单：
 * - POST   /agents/sessions                  创建会话
 * - GET    /agents/sessions                  列出会话（分页）
 * - DELETE /agents/sessions/:sessionId       删除会话
 * - GET    /agents/sessions/:sessionId       获取会话详情（含最近消息）
 * - GET    /agents/sessions/:sessionId/messages  获取会话消息（分页）
 * - POST   /agents/runs                      发起运行（不绑定 session）
 * - POST   /agents/sessions/:sessionId/runs 发起运行（绑定 session）
 * - POST   /agents/uploads/images            上传图片（存 S3）
 * - POST   /agents/uploads/documents         上传文档（存本地）
 * - GET    /agents/messages/:messageId       获取消息快照
 * - GET    /agents/runs/:runId               获取运行详情
 * - POST   /agents/runs/:runId/cancel        取消运行
 * - POST   /agents/messages/:messageId/regenerate  重新生成消息
 * - GET    /agents/runs/:runId/stream        SSE 流式订阅运行事件
 *
 * 所有路由都通过 getRequestUserId 提取用户身份，coordinator 据此做权限隔离。
 */
export async function registerAgentRoutes(
  app: FastifyInstance,
  coordinator: AgentMessageCoordinator,
  options: RegisterAgentRoutesOptions = {}
): Promise<void> {
  app.post("/agents/sessions", async (request, reply) => {
    const { title } = parseSessionRequest(request.body);
    reply.status(201).send({ session: toAgentSessionDto(await coordinator.createSession(title, getRequestUserId(request))) });
  });

  app.get("/agents/sessions", async (request) => {
    return toAgentSessionsResponse(
      await coordinator.listSessions({ ...parseSessionsQuery(request.query), userId: getRequestUserId(request) })
    );
  });

  app.delete("/agents/sessions/:sessionId", async (request, reply) => {
    const { sessionId } = parseSessionParams(request.params);
    await coordinator.deleteSession(sessionId, getRequestUserId(request));
    reply.status(204).send();
  });

  app.get("/agents/sessions/:sessionId", async (request) => {
    const { sessionId } = parseSessionParams(request.params);
    const { limit } = parseSessionMessagesQuery(request.query);
    return toAgentSessionResponse(
      await coordinator.getSession(sessionId, { messageLimit: limit, userId: getRequestUserId(request) })
    );
  });

  app.get("/agents/sessions/:sessionId/messages", async (request) => {
    const { sessionId } = parseSessionParams(request.params);
    const { before, limit } = parseSessionMessagesQuery(request.query);
    return toAgentSessionMessagesResponse(
      await coordinator.getSessionMessages(sessionId, { before, messageLimit: limit, userId: getRequestUserId(request) })
    );
  });

  app.post("/agents/runs", async (request, reply) => {
    const input = parseMessageStartRequest(request.body);
    reply
      .status(202)
      .send(
        toStartAgentRunResponse(
          await coordinator.startRun(
            { ...input, userId: getRequestUserId(request) },
            getRequestTraceContext(request) ?? undefined
          )
        )
      );
  });

  app.post("/agents/uploads/images", async (request, reply) => {
    const file = await request.file();

    if (!file) {
      throw new AppError("VALIDATION_ERROR", "请选择要上传的图片", 400);
    }

    if (!file.mimetype.startsWith("image/")) {
      throw new AppError("VALIDATION_ERROR", "当前只支持上传图片", 400);
    }

    const buffer = await readAttachmentBuffer(file);

    if (buffer.length === 0) {
      throw new AppError("VALIDATION_ERROR", "图片内容不能为空", 400);
    }

    const extension = getImageExtension(file.mimetype, file.filename);
    const contentHash = createHash("md5").update(buffer).digest("hex");
    const storedFileName = `${contentHash}${extension}`;
    const s3Key = `images/${storedFileName}`;

    // S3 putObject 对相同 key 是幂等覆盖，不需要本地文件系统的 "wx" 去重逻辑。
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: getS3Bucket(),
        Key: s3Key,
        Body: buffer,
        ContentType: file.mimetype
      })
    );

    await waitForUploadResponseDelay(options.uploadResponseDelayMs ?? 0);

    reply.status(201).send({
      file: {
        type: "resource",
        mime: file.mimetype,
        url: getS3ObjectUrl(s3Key),
        name: basename(file.filename),
        size: buffer.length
      }
    });
  });

  app.post("/agents/uploads/documents", async (request, reply) => {
    const file = await request.file();

    if (!file) {
      throw new AppError("VALIDATION_ERROR", "请选择要上传的文档", 400);
    }

    const name = basename(file.filename);
    const mimeType = normalizeAgentDocumentMime(file.mimetype || getDocumentMimeTypeFromName(name), name);

    if (!isSupportedAgentInputDocument({ mimeType, name })) {
      throw new AppError("VALIDATION_ERROR", "当前只支持上传 TXT、Markdown 和 Word 文档", 400);
    }

    const buffer = await readAttachmentBuffer(file);

    if (buffer.length === 0) {
      throw new AppError("VALIDATION_ERROR", "文档内容不能为空", 400);
    }

    if (!options.uploadDirectory) {
      throw new AppError("RUNTIME_DEPENDENCY_ERROR", "未配置附件上传目录", 503);
    }

    const extension = getDocumentExtension(name, mimeType);
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const storedFileName = `${contentHash}${extension}`;
    const targetDirectory = join(options.uploadDirectory, "agent-documents");
    const sourcePath = join(targetDirectory, storedFileName);

    await mkdir(targetDirectory, { recursive: true });
    await writeFile(sourcePath, buffer);

    await waitForUploadResponseDelay(options.uploadResponseDelayMs ?? 0);

    reply.status(201).send({
      file: {
        type: "resource",
        mime: mimeType,
        url: `${getPublicBaseUrl(options, request)}/uploads/agent-documents/${storedFileName}`,
        name,
        size: buffer.length,
        extra: {
          inputResource: {
            type: "document"
          }
        }
      }
    });
  });

  app.post("/agents/sessions/:sessionId/runs", async (request, reply) => {
    const { sessionId } = parseSessionParams(request.params);
    const input = parseMessageRequest(request.body);
    reply
      .status(202)
      .send(
        toStartAgentRunResponse(
          await coordinator.startRun(
            { ...input, sessionId, userId: getRequestUserId(request) },
            getRequestTraceContext(request) ?? undefined
          )
        )
      );
  });

  app.get("/agents/messages/:messageId", async (request) => {
    const { messageId } = parseMessageParams(request.params);
    return toAgentMessageDetailResponse(await coordinator.getMessageSnapshot(messageId, getRequestUserId(request)));
  });

  app.get("/agents/runs/:runId", async (request) => {
    const { runId } = parseRunParams(request.params);
    return toAgentRunDetailResponse(await coordinator.getRun(runId, getRequestUserId(request)));
  });

  app.post("/agents/runs/:runId/cancel", async (request) => {
    const { runId } = parseRunParams(request.params);
    return toCancelAgentRunResponse(await coordinator.cancelRun(runId, "用户中断", getRequestUserId(request)));
  });

  app.post("/agents/messages/:messageId/regenerate", async (request, reply) => {
    const { messageId } = parseMessageParams(request.params);
    reply
      .status(202)
      .send(toRegenerateAgentMessageResponse(await coordinator.regenerateMessage(messageId, getRequestUserId(request))));
  });

  /**
   * SSE 流式订阅运行事件。
   *
   * 这是前端获取 Agent 执行过程的核心接口。连接建立后，服务端会持续
   * 推送事件（token、工具进度、最终答案等），直到 run 结束或客户端断开。
   *
   * 断线恢复机制：SSE 连接可能来自首次提交，也可能来自页面刷新后的恢复。
   * 因此这里不只订阅 live event，还会在订阅后主动补一个 message.snapshot：
   * - running 时 snapshot 从 Redis draft 读，能恢复当前生成中的 parts；
   * - completed/failed/cancelled 时 snapshot 从 SQLite message 读，展示最终状态。
   *
   * 连接生命周期管理：用 ended 标志位防止重复关闭，request close 事件
   * 触发取消订阅，避免连接断开后服务端继续往已关闭的流写数据。
   */
  app.get("/agents/runs/:runId/stream", async (request, reply) => {
    const { runId } = parseRunParams(request.params);
    const userId = getRequestUserId(request);
    await coordinator.getRun(runId, userId);

    reply.raw.writeHead(200, buildSseHeaders(reply.getHeaders()));

    // SSE 连接可能来自首次提交，也可能来自刷新后的恢复。
    // 因此这里不只订阅 live event，还会在订阅后主动补一个 message.snapshot：
    // - running 时 snapshot 从 Redis draft 读，能恢复当前生成中的 parts；
    // - completed/failed/cancelled 时 snapshot 从 SQLite message 读，展示最终状态。
    let ended = false;
    let unsubscribe: () => void | Promise<void> = () => {};
    const finish = () => {
      if (ended) {
        return;
      }

      ended = true;
      void unsubscribe();
      reply.raw.end();
    };
    const writeStoredEvent = (event: StoredAgentEvent) => {
      if (ended) {
        return;
      }

      reply.raw.write(formatStoredSseEvent(event));

      if (isTerminalStoredEvent(event)) {
        finish();
      }
    };

    unsubscribe = await coordinator.subscribeRun(runId, writeStoredEvent, userId);
    request.raw.on("close", () => {
      if (!ended) {
        ended = true;
        void unsubscribe();
      }
    });

    const { run } = await coordinator.getRun(runId, userId);
    if (run.assistantMessageId) {
      const { message, resources, processSteps, version } = await coordinator.getMessageSnapshot(run.assistantMessageId, userId);
      writeStoredEvent(
        createLiveSseEvent({
          runId,
          messageId: message.id,
          event: { type: "message.snapshot", message, resources, processSteps, version }
        })
      );
    }

    if (run.status !== "running") {
      finish();
    }
  });
}
