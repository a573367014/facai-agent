export type AttachmentUploadKind = "image" | "document";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_LABEL = "20MB";
export const ATTACHMENT_TOO_LARGE_MESSAGE = `附件不能超过 ${MAX_ATTACHMENT_LABEL}`;
export const UNSUPPORTED_ATTACHMENT_MESSAGE = "当前只支持上传图片、TXT、Markdown 和 Word 文档";

const supportedDocumentMimeTypes = new Set([
  "text/plain",
  "text/markdown",
  "application/markdown",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);

const supportedDocumentExtensions = [".txt", ".md", ".markdown", ".doc", ".docx"];

export function getAttachmentUploadKind(file: File): AttachmentUploadKind | undefined {
  if (file.type.startsWith("image/")) {
    return "image";
  }

  if (isSupportedDocumentFile(file)) {
    return "document";
  }

  return undefined;
}

export function getAttachmentValidationMessage(file: File, expectedKind?: AttachmentUploadKind): string | undefined {
  const sizeMessage = getAttachmentSizeValidationMessage(file);

  if (sizeMessage) {
    return sizeMessage;
  }

  const kind = getAttachmentUploadKind(file);

  if (!kind || (expectedKind && kind !== expectedKind)) {
    return UNSUPPORTED_ATTACHMENT_MESSAGE;
  }

  return undefined;
}

export function getAttachmentSizeValidationMessage(file: File): string | undefined {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return ATTACHMENT_TOO_LARGE_MESSAGE;
  }

  return undefined;
}

function isSupportedDocumentFile(file: File) {
  const mimeType = file.type.trim().toLowerCase();

  if (supportedDocumentMimeTypes.has(mimeType)) {
    return true;
  }

  const lowerName = file.name.trim().toLowerCase();
  return supportedDocumentExtensions.some((extension) => lowerName.endsWith(extension));
}
