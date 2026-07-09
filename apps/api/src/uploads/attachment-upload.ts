import { AppError } from "../errors/app-error.js";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_LABEL = "20MB";
export const ATTACHMENT_TOO_LARGE_MESSAGE = `附件不能超过 ${MAX_ATTACHMENT_LABEL}`;

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

export async function waitForUploadResponseDelay(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function throwAttachmentTooLarge(): never {
  throw new AppError("VALIDATION_ERROR", ATTACHMENT_TOO_LARGE_MESSAGE, 413);
}

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
