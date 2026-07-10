/**
 * 文档解析器（Document Parser）。
 *
 * 职责：把不同格式的原始文件（PDF / Word / Markdown / TXT）统一抽取出"纯文本"，
 * 作为后续切块（chunker）和向量化（embedding）的输入。
 *
 * 为什么用 createRequire 而不是 ESM import：
 * - pdf-parse、mammoth、word-extractor 这类解析库多是 CommonJS 模块，且部分依赖动态 require。
 * - 在 ESM 环境下用 createRequire 可以安全地同步加载它们，避免顶层 await 和模块解析顺序问题。
 *
 * 边界：本模块只输出 { text }，不做任何切块、过滤或向量化；
 * 也不负责判断文件是否"值得索引"（那是 indexing-service 的职责）。
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);

export interface ParseKnowledgeDocumentInput {
  sourcePath: string;
  mimeType: string;
  name: string;
}

export interface ParsedKnowledgeDocument {
  text: string;
}

/**
 * 根据文件类型分发到对应的解析逻辑，统一返回纯文本。
 *
 * 分发依据是 mimeType 优先、文件名兜底（因为浏览器有时无法准确识别 MIME）。
 * 三类都不匹配时抛错，由上层（indexing-service）捕获并标记文档为 failed。
 *
 * @throws 当文件类型不在支持范围内时抛出错误
 */
export async function parseKnowledgeDocument(input: ParseKnowledgeDocumentInput): Promise<ParsedKnowledgeDocument> {
  if (isTextDocument(input)) {
    return {
      text: await readFile(input.sourcePath, "utf8")
    };
  }

  if (isPdfDocument(input)) {
    const buffer = await readFile(input.sourcePath);
    const pdfParse = require("pdf-parse") as (data: Buffer) => Promise<{ text?: string }>;
    const result = await pdfParse(buffer);
    return { text: result.text ?? "" };
  }

  if (isWordDocument(input)) {
    const buffer = await readFile(input.sourcePath);
    return { text: await extractWordText(buffer, input) };
  }

  throw new Error("当前只支持上传 PDF、Word、Markdown 和 TXT 文档");
}

/**
 * 判断文件是否属于系统支持的知识库文档类型。
 * 在 HTTP 路由层用于上传前的白名单校验，把不支持的格式挡在落库之前。
 */
export function isSupportedKnowledgeDocument(input: { mimeType: string; name: string }): boolean {
  return isTextDocument(input) || isPdfDocument(input) || isWordDocument(input);
}

/**
 * 识别纯文本类文档（含 Markdown）。
 * 同时匹配 text/* 前缀、application/markdown 以及常见扩展名，
 * 因为不同上传来源对 Markdown 的 MIME 标注并不统一。
 */
function isTextDocument(input: { mimeType: string; name: string }) {
  const name = input.name.toLowerCase();
  return (
    input.mimeType.startsWith("text/") ||
    input.mimeType === "application/markdown" ||
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    name.endsWith(".txt")
  );
}

/** 识别 PDF 文档，MIME 和扩展名二选一即可命中。 */
function isPdfDocument(input: { mimeType: string; name: string }) {
  return input.mimeType === "application/pdf" || input.name.toLowerCase().endsWith(".pdf");
}

/** 识别 Word 文档，同时覆盖新版 .docx 和老版 .doc 两种格式。 */
function isWordDocument(input: { mimeType: string; name: string }) {
  const name = input.name.toLowerCase();
  return (
    input.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    input.mimeType === "application/msword" ||
    name.endsWith(".docx") ||
    name.endsWith(".doc")
  );
}

/** 识别老版二进制 .doc 格式（需要走不同的解析库，见 extractWordText）。 */
function isLegacyDoc(input: { mimeType: string; name: string }) {
  return (
    input.mimeType === "application/msword" || input.name.toLowerCase().endsWith(".doc")
  );
}

/**
 * 提取 Word 文档文本。
 *
 * 为什么要分两套库：
 * - .docx（新版）本质是 ZIP 打包的 XML，mammoth 可以解析它并提取纯文本。
 * - .doc（老版）是二进制格式（CFB/OLE），mammoth 无法处理，必须用 word-extractor。
 * 两套格式底层完全不同，所以必须按格式分发到对应解析器。
 */
async function extractWordText(buffer: Buffer, input: { mimeType: string; name: string }): Promise<string> {
  if (isLegacyDoc(input)) {
    const WordExtractor = require("word-extractor");
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buffer);
    return doc.getBody() ?? "";
  }

  const mammoth = require("mammoth") as {
    extractRawText(input: { buffer: Buffer }): Promise<{ value?: string }>;
  };
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? "";
}
