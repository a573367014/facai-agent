/**
 * 模块职责：输入资源解析器。
 *
 * 用户在对话中可以上传文档（PDF/Word/Markdown 等）作为上下文。这些文档以 ResourcePart
 * 形式存在于 message parts 中，但 LLM 无法直接理解结构化的 part。本模块负责把用户上传的
 * 文档解析成纯文本，拼装成 LLM 能理解的文本格式，注入到对话上下文里。
 *
 * 边界：
 * - 只处理"本地 uploads 目录下的 agent-documents 路径"的资源，其他 URL（如 http）原样透传。
 * - 解析失败不中断流程，降级为返回原始 part 文本 + 错误提示。
 * - 文档内容有最大字符数限制（默认 30000），超长截断并提示用户。
 */
import { basename, isAbsolute, join, normalize } from "node:path";
import { parseKnowledgeDocument } from "../knowledge/document-parser.js";
import type { MessagePart, ResourcePart } from "./message-parts.js";
import { partsToLlmText } from "./message-parts.js";

const DEFAULT_MAX_DOCUMENT_CHARACTERS = 30_000;
const uploadsPrefix = "/uploads/";
const agentDocumentsPrefix = "agent-documents/";

/**
 * 输入资源解析器接口。coordinator 通过它把用户输入的 message parts 转成 LLM 文本。
 * 抽象成接口是为了支持不同的资源解析策略（本地文件、远程 URL、对象存储等）。
 */
export interface InputResourceResolver {
  resolvePartsToLlmText(parts: MessagePart[]): Promise<string>;
}

export interface LocalUploadInputResourceResolverOptions {
  uploadDirectory: string;
  maxDocumentCharacters?: number;
}

/**
 * 本地上传资源解析器。处理用户通过 /uploads/agent-documents/ 路径上传的文档。
 * 把文档解析成纯文本，拼装成"用户上传文档：xxx\n类型：xxx\n内容：xxx"的格式喂给 LLM。
 * 非 resource 类型的 part 直接用 partsToLlmText 透传。
 */
export class LocalUploadInputResourceResolver implements InputResourceResolver {
  private readonly uploadDirectory: string;
  private readonly maxDocumentCharacters: number;

  constructor(options: LocalUploadInputResourceResolverOptions) {
    this.uploadDirectory = options.uploadDirectory;
    this.maxDocumentCharacters = options.maxDocumentCharacters ?? DEFAULT_MAX_DOCUMENT_CHARACTERS;
  }

  /**
   * 把 message parts 数组转成 LLM 可理解的文本。
   * 每个 part 单独投影，非空文本用换行拼接。resource part 会尝试解析文档内容。
   */
  async resolvePartsToLlmText(parts: MessagePart[]): Promise<string> {
    const projectedParts = await Promise.all(parts.map((part) => this.projectPart(part)));
    return projectedParts.filter((part) => part.trim().length > 0).join("\n");
  }

  /**
   * 解析单个 part。resource part 会尝试读取本地文档文件并解析成文本；
   * 解析失败时降级为返回原始 part 文本 + 错误提示，不中断流程。
   */
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

  /**
   * 从 ResourcePart 的 URL 中解析出本地文档路径。
   * 只处理 /uploads/agent-documents/ 前缀的路径，其他 URL 返回 undefined（原样透传）。
   * 做了路径穿越防护：拒绝绝对路径和 .. 前缀的相对路径，防止恶意 URL 访问 uploads 目录之外的文件。
   */
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
