/**
 * 文档文件工具（generate_document）
 *
 * 把 LLM 生成的文本落地为可下载的文件（txt / markdown / docx），
 * 让用户能直接拿到"成品文档"而不是一段聊天文本。
 *
 * 边界：本工具只做"文本→文件"的格式化落地，不做内容生成、排版美化、模板填充；
 * 文件写到系统临时目录，由前端通过另外的下载接口取走。
 */
import { Buffer } from "node:buffer";
import { createWriteStream } from "node:fs";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { finished } from "node:stream/promises";
import JSZip from "jszip";
import { z } from "zod";
import type { RegisteredTool, ToolOutput } from "./types.js";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type DocumentFormat = "txt" | "markdown" | "docx";

interface GeneratedDocument {
  name: string;
  mime: string;
  source: {
    type: "local_file";
    path: string;
  };
  size: number;
}

const documentArgumentSchema = z.object({
  format: z.enum(["txt", "markdown", "docx"]),
  fileName: z.string().trim().min(1).max(160).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().min(1).max(500_000)
});

/**
 * 构造文档生成工具。
 *
 * timeoutMs 设为 30s：docx 打包是 CPU 密集型，但内容上限 50 万字符，
 * 正常场景毫秒级完成；留 30s 是给极端大文档余量，同时避免工具长时间挂住整个会话。
 */
export function createDocumentFileTool(): RegisteredTool {
  return {
    name: "generate_document",
    description: "生成可下载的文档文件，支持 txt、markdown 和 docx。适合用户明确要求返回文件、报告、文档、Markdown、纯文本或 Word 文档时使用。",
    parameters: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["txt", "markdown", "docx"],
          description: "输出文件格式。Markdown 用 markdown，纯文本用 txt，Word 文档用 docx。"
        },
        fileName: {
          type: "string",
          description: "文件名，可不带扩展名；系统会按 format 规范化扩展名。"
        },
        title: {
          type: "string",
          description: "文档标题。docx 会把它作为标题段落；txt/markdown 不会自动改写 content。"
        },
        content: {
          type: "string",
          description: "文档正文。txt/markdown 会原样写入；docx 会按换行拆成段落。"
        }
      },
      required: ["format", "content"],
      additionalProperties: false
    },
    argumentSchema: documentArgumentSchema,
    timeoutMs: 30_000,
    execute: async (args) => {
      const input = documentArgumentSchema.parse(args);
      const generated = await generateDocument({
        format: input.format,
        fileName: input.fileName,
        title: input.title,
        content: input.content
      });

      return {
        data: {
          provider: "agent_document",
          status: "done",
          documents: [generated]
        },
        llmContent: `已生成文档：${generated.name}（${generated.mime}，${generated.size} 字节）。`
      } satisfies ToolOutput;
    }
  };
}

/**
 * 按指定格式生成文档并写入临时目录。
 *
 * 每次调用都新建一个独立临时目录（mkdtemp），避免并发或多次生成时文件名碰撞；
 * txt / markdown 直接写 UTF-8 文本，docx 走 createDocxBuffer 打包成 OOXML zip。
 */
async function generateDocument(input: {
  format: DocumentFormat;
  fileName?: string;
  title?: string;
  content: string;
}): Promise<GeneratedDocument> {
  const mime = getDocumentMime(input.format);
  const extension = getDocumentExtension(input.format);
  const name = normalizeDocumentFileName(input.fileName ?? input.title ?? "document", extension);
  const outputDirectory = await mkdtemp(join(tmpdir(), "agent-document-"));
  const outputPath = join(outputDirectory, name);

  if (input.format === "docx") {
    await writeFile(outputPath, await createDocxBuffer({ title: input.title, content: input.content }));
  } else {
    await writeUtf8File(outputPath, input.content);
  }

  const fileStats = await stat(outputPath);

  return {
    name,
    mime,
    source: {
      type: "local_file",
      path: outputPath
    },
    size: fileStats.size
  };
}

async function writeUtf8File(path: string, content: string): Promise<void> {
  const stream = createWriteStream(path, { encoding: "utf8" });
  stream.end(content);
  await finished(stream);
}

function getDocumentMime(format: DocumentFormat): string {
  if (format === "txt") {
    return "text/plain";
  }

  if (format === "markdown") {
    return "text/markdown";
  }

  return DOCX_MIME;
}

function getDocumentExtension(format: DocumentFormat): string {
  if (format === "txt") {
    return ".txt";
  }

  if (format === "markdown") {
    return ".md";
  }

  return ".docx";
}

/**
 * 把用户传入的文件名规范化为安全的、带正确扩展名的最终文件名。
 *
 * 处理顺序：取最后一段（剥离路径）→ 去掉 Windows 非法字符 → 剥离用户自带的扩展名 → 补上 format 对应扩展名。
 * 不做这一步，用户可能传入含路径或非法字符的名字，导致文件写到预期目录之外或打开失败。
 */
function normalizeDocumentFileName(value: string, extension: string): string {
  const fallback = `document${extension}`;
  const rawName = value.trim() || fallback;
  const pathlessName = rawName.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? fallback;
  const safeName = pathlessName.replace(/[:*?"<>|]/g, "-").trim() || fallback;
  const currentExtension = extname(safeName);
  const stem = currentExtension ? safeName.slice(0, -currentExtension.length) : safeName;

  return `${stem || "document"}${extension}`;
}

/**
 * 生成 docx 文件的二进制 Buffer。
 *
 * docx 本质是一个包含若干 XML 部件的 zip 包（OOXML 标准）。
 * 这里不依赖重量级 docx 专用库，而是用 JSZip 手工拼出最小可用的部件集合：
 * [Content_Types].xml / _rels/.rels / docProps/core.xml / docProps/app.xml / word/document.xml，
 * 足以被 Word、WPS、Pages 等主流办公软件正确打开。
 */
async function createDocxBuffer(input: { title?: string; content: string }): Promise<Buffer> {
  const zip = new JSZip();
  const now = new Date().toISOString();

  zip.file("[Content_Types].xml", contentTypesXml());
  zip.file("_rels/.rels", packageRelationshipsXml());
  zip.file("docProps/core.xml", corePropertiesXml(input.title ?? "Document", now));
  zip.file("docProps/app.xml", appPropertiesXml());
  zip.file("word/document.xml", documentXml(input));

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE"
  });
}

function documentXml(input: { title?: string; content: string }): string {
  const blocks = splitBlocks(input.content);
  const paragraphs = [
    input.title ? paragraphXml(input.title, { style: "Title" }) : undefined,
    ...blocks.map((block) => paragraphXml(block))
  ].filter(Boolean).join("");

  return xmlDeclaration(`\
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`);
}

function splitBlocks(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function paragraphXml(text: string, options: { style?: string } = {}): string {
  const properties = options.style ? `<w:pPr><w:pStyle w:val="${escapeXml(options.style)}"/></w:pPr>` : "";
  const runs = text.split(/\n/).map((line, index) => {
    const breakXml = index > 0 ? "<w:br/>" : "";
    return `${breakXml}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`;
  }).join("");

  return `<w:p>${properties}<w:r>${runs}</w:r></w:p>`;
}

function contentTypesXml(): string {
  return xmlDeclaration(`\
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
}

function packageRelationshipsXml(): string {
  return xmlDeclaration(`\
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
}

function corePropertiesXml(title: string, now: string): string {
  return xmlDeclaration(`\
<cp:coreProperties
  xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:dcmitype="http://purl.org/dc/dcmitype/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title)}</dc:title>
  <dc:creator>Agent</dc:creator>
  <cp:lastModifiedBy>Agent</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`);
}

function appPropertiesXml(): string {
  return xmlDeclaration(`\
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
  xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Agent</Application>
</Properties>`);
}

function xmlDeclaration(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => xmlEntities[char] ?? char);
}

const xmlEntities: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "'": "&apos;",
  "\"": "&quot;"
};
