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
    const mammoth = require("mammoth") as {
      extractRawText(input: { buffer: Buffer }): Promise<{ value?: string }>;
    };
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value ?? "" };
  }

  throw new Error("当前只支持上传 PDF、Word、Markdown 和 TXT 文档");
}

export function isSupportedKnowledgeDocument(input: { mimeType: string; name: string }): boolean {
  return isTextDocument(input) || isPdfDocument(input) || isWordDocument(input);
}

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

function isPdfDocument(input: { mimeType: string; name: string }) {
  return input.mimeType === "application/pdf" || input.name.toLowerCase().endsWith(".pdf");
}

function isWordDocument(input: { mimeType: string; name: string }) {
  const name = input.name.toLowerCase();
  return (
    input.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    input.mimeType === "application/msword" ||
    name.endsWith(".docx") ||
    name.endsWith(".doc")
  );
}
