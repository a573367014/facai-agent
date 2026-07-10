import { basename, isAbsolute, join, normalize } from "node:path";
import { parseKnowledgeDocument } from "../knowledge/document-parser.js";
import type { MessagePart, ResourcePart } from "./message-parts.js";
import { partsToLlmText } from "./message-parts.js";

const DEFAULT_MAX_DOCUMENT_CHARACTERS = 30_000;
const uploadsPrefix = "/uploads/";
const agentDocumentsPrefix = "agent-documents/";

export interface InputResourceResolver {
  resolvePartsToLlmText(parts: MessagePart[]): Promise<string>;
}

export interface LocalUploadInputResourceResolverOptions {
  uploadDirectory: string;
  maxDocumentCharacters?: number;
}

export class LocalUploadInputResourceResolver implements InputResourceResolver {
  private readonly uploadDirectory: string;
  private readonly maxDocumentCharacters: number;

  constructor(options: LocalUploadInputResourceResolverOptions) {
    this.uploadDirectory = options.uploadDirectory;
    this.maxDocumentCharacters = options.maxDocumentCharacters ?? DEFAULT_MAX_DOCUMENT_CHARACTERS;
  }

  async resolvePartsToLlmText(parts: MessagePart[]): Promise<string> {
    const projectedParts = await Promise.all(parts.map((part) => this.projectPart(part)));
    return projectedParts.filter((part) => part.trim().length > 0).join("\n");
  }

  private async projectPart(part: MessagePart): Promise<string> {
    if (part.type !== "resource") {
      return partsToLlmText([part]);
    }

    const localDocument = this.resolveLocalDocument(part);

    if (!localDocument) {
      return partsToLlmText([part]);
    }

    try {
      const parsed = await parseKnowledgeDocument({
        sourcePath: localDocument.sourcePath,
        mimeType: localDocument.mimeType,
        name: localDocument.name
      });
      const { text, truncated } = truncateDocumentText(parsed.text, this.maxDocumentCharacters);
      const content = text.trim() || "（文档内容为空）";

      return [
        `用户上传文档：${localDocument.name}`,
        `类型：${localDocument.mimeType}`,
        "内容：",
        content,
        truncated ? `\n[文档内容已截断，仅展示前 ${this.maxDocumentCharacters} 个字符]` : ""
      ].filter(Boolean).join("\n");
    } catch (error) {
      const fallback = partsToLlmText([part]);
      const message = error instanceof Error ? error.message : "未知错误";
      return `${fallback}\n[文档内容读取失败：${message}]`;
    }
  }

  private resolveLocalDocument(part: ResourcePart): { sourcePath: string; mimeType: string; name: string } | undefined {
    if (!part.url) {
      return undefined;
    }

    let parsedUrl: URL;

    try {
      parsedUrl = new URL(part.url, "http://localhost");
    } catch {
      return undefined;
    }

    if (!parsedUrl.pathname.startsWith(`${uploadsPrefix}${agentDocumentsPrefix}`)) {
      return undefined;
    }

    const relativePath = normalize(decodeURIComponent(parsedUrl.pathname.slice(uploadsPrefix.length)));

    if (isAbsolute(relativePath) || relativePath.startsWith("..") || !relativePath.startsWith(agentDocumentsPrefix)) {
      return undefined;
    }

    const name = part.name?.trim() || basename(relativePath) || "文档";
    const mimeType = part.mime?.trim() || inferDocumentMime(name);

    return {
      sourcePath: join(this.uploadDirectory, relativePath),
      mimeType,
      name
    };
  }
}

function truncateDocumentText(text: string, maxCharacters: number): { text: string; truncated: boolean } {
  if (text.length <= maxCharacters) {
    return { text, truncated: false };
  }

  return {
    text: text.slice(0, maxCharacters),
    truncated: true
  };
}

function inferDocumentMime(name: string): string {
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
