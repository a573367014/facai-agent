/**
 * 附件上传处理。
 *
 * 职责：把 Fastify multipart 上传的文件读取为内存 Buffer，并做大小校验，
 * 在超限时抛出统一的 AppError(413)。同时提供上传后延迟响应的能力。
 * 边界：只负责「读 Buffer + 校验大小」，不负责写入对象存储（S3/MinIO），
 * 不负责文件类型白名单、不负责病毒扫描。存储由调用方拿到 Buffer 后自行处理。
 * 不这么做会怎样：不做大小校验，恶意用户可上传超大文件撑爆内存；
 * 不区分「Fastify 限制触发」与「业务限制触发」，错误信息会不一致。
 */
import { AppError } from "../../shared/errors/app-error.js";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_LABEL = "20MB";
export const ATTACHMENT_TOO_LARGE_MESSAGE = `附件不能超过 ${MAX_ATTACHMENT_LABEL}`;

/**
 * 读取上传文件为 Buffer，超限则抛 AppError(413)。
 *
 * 两道校验：先捕获 Fastify 自身的 FST_REQ_FILE_TOO_LARGE（Fastify 在流式读取时
 * 超过其配置的 limit 就会中断并抛错），再在拿到完整 Buffer 后做业务级大小判断。
 * 为什么需要两道：Fastify 的 limit 是传输层保护（防内存爆），业务限制是语义层约束，
 * 两者数值可能不同，且 Fastify 抛的错不是 AppError，需要转换才能统一错误响应格式。
 */
export async function readAttachmentBuffer(file: { toBuffer(): Promise<Buffer> }): Promise<Buffer> {
  let buffer: Buffer;

  try {
    buffer = await file.toBuffer();
  } catch (error) {
    if (isMultipartFileTooLargeError(error)) {
      throwAttachmentTooLarge();
    }

    throw error;
  }

  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throwAttachmentTooLarge();
  }

  return buffer;
}

/**
 * 等待指定的延迟时间后再继续。
 *
 * 用途：上传完成后人为引入延迟，用于模拟慢速网络或测试前端 loading 态。
 * delayMs <= 0 时直接返回：避免在非测试环境下无意义地阻塞响应。
 */
export async function waitForUploadResponseDelay(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * 抛出「附件过大」的 AppError，返回类型标注 never 让调用方类型系统知道后续不可达。
 *
 * 413 Payload Too Large：HTTP 语义上即「请求体过大」，比 400 更精确。
 */
function throwAttachmentTooLarge(): never {
  throw new AppError("VALIDATION_ERROR", ATTACHMENT_TOO_LARGE_MESSAGE, 413);
}

/**
 * 判断错误是否为 Fastify multipart 的「文件过大」错误。
 *
 * Fastify 不同版本错误码不同（FST_REQ_FILE_TOO_LARGE / FASTIFY_REQUEST_FILE_TOO_LARGE），
 * 还可能只有 message 关键词，因此三重判断确保兼容。不识别就会把 Fastify 内部错误
 * 原样抛给前端，暴露实现细节且无法给出「请压缩后重试」的友好提示。
 */
function isMultipartFileTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as { code?: unknown; message?: unknown };
  return (
    maybeError.code === "FST_REQ_FILE_TOO_LARGE" ||
    maybeError.code === "FASTIFY_REQUEST_FILE_TOO_LARGE" ||
    (typeof maybeError.message === "string" && maybeError.message.toLowerCase().includes("file size limit"))
  );
}
