/**
 * 知识库 HTTP 路由层。
 *
 * 职责：把 HTTP 请求翻译成对领域服务（仓储 / 队列 / 检索器）的调用，再把结果序列化成 HTTP 响应。
 *
 * 这一层是系统的"门面"，只做三件事：
 *   ① 参数校验（用 zod 把脏数据挡在业务逻辑之外）；
 *   ② 协调领域服务（store / indexQueue / retriever）；
 *   ③ 用 response-mapper 把领域记录转成对外 DTO。
 *
 * 边界：路由层不包含任何业务规则（如"如何切块""如何算相似度"），
 * 那些都在各自的 service 里，路由层只是"接线"。
 *
 * 路由清单：
 *   GET    /knowledge/documents                      文档列表
 *   POST   /knowledge/documents/upload               上传文档（落盘 + 入库 + 投递索引任务）
 *   DELETE /knowledge/documents/:documentId          删除文档
 *   POST   /knowledge/documents/:documentId/reindex  重建索引
 *   POST   /knowledge/search                         语义检索
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readAttachmentBuffer } from "../../../platform/storage/attachment-upload.js";
import { AppError } from "../../../shared/errors/app-error.js";
import { isSupportedKnowledgeDocument } from "../document-parser.js";
import type { KnowledgeIndexQueue } from "../knowledge-run-queue.js";
import type { KnowledgeRepository } from "../knowledge-repository.js";
import type { KnowledgeRetriever } from "../retriever.js";
import { toKnowledgeDocumentDto } from "./knowledge-response-mappers.js";

/** 路径参数校验：documentId 必须是非空字符串。 */
const documentParamsSchema = z.object({
  documentId: z.string().min(1)
});
/** 搜索请求体校验：query 非空，limit 限制在 1~20 防止滥用。 */
const knowledgeSearchSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(20).optional()
});

export interface RegisterKnowledgeRoutesOptions {
  uploadDirectory: string;
  store: KnowledgeRepository;
  indexQueue: KnowledgeIndexQueue;
  retriever: KnowledgeRetriever;
}

/**
 * 向 Fastify 实例注册全部知识库路由。
 * 所有依赖通过 options 注入，便于测试时替换为 mock。
 */
export async function registerKnowledgeRoutes(app: FastifyInstance, options: RegisterKnowledgeRoutesOptions): Promise<void> {
  app.get("/knowledge/documents", async () => ({
    documents: (await options.store.listKnowledgeDocuments()).map(toKnowledgeDocumentDto)
  }));

  app.post("/knowledge/documents/upload", async (request, reply) => {
    const file = await request.file();

    if (!file) {
      throw new AppError("VALIDATION_ERROR", "请选择要上传的文档", 400);
    }

    const name = basename(file.filename);
    const mimeType = file.mimetype || getMimeTypeFromName(name);

    if (!isSupportedKnowledgeDocument({ mimeType, name })) {
      throw new AppError("VALIDATION_ERROR", "当前只支持上传 PDF、Word、Markdown 和 TXT 文档", 400);
    }

    const buffer = await readAttachmentBuffer(file);

    if (buffer.length === 0) {
      throw new AppError("VALIDATION_ERROR", "文档内容不能为空", 400);
    }

    // 用内容哈希作文件名：天然去重——相同内容只存一份磁盘文件，且避免文件名冲突
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const storedFileName = `${contentHash}${getDocumentExtension(name, mimeType)}`;
    const targetDirectory = join(options.uploadDirectory, "knowledge");
    const sourcePath = join(targetDirectory, storedFileName);

    await mkdir(targetDirectory, { recursive: true });
    await writeFile(sourcePath, buffer);

    const document = await options.store.createKnowledgeDocument({
      name,
      mimeType,
      sourcePath,
      contentHash
    });

    // 文件落盘 + 记录入库后，立即投递异步索引任务，请求本身不等索引完成
    await options.indexQueue.enqueueDocumentIndex({ documentId: document.id });
    reply.status(201).send({ document: toKnowledgeDocumentDto(document) });
  });

  app.delete("/knowledge/documents/:documentId", async (request, reply) => {
    const { documentId } = parseDocumentParams(request.params);
    const deleted = await options.store.deleteKnowledgeDocument(documentId);

    if (!deleted) {
      throw new AppError("VALIDATION_ERROR", "未找到知识库文档", 404);
    }

    reply.status(204).send();
  });

  app.post("/knowledge/documents/:documentId/reindex", async (request, reply) => {
    const { documentId } = parseDocumentParams(request.params);
    // 先重置状态为 pending 并清空错误信息，再投递任务，让前端立刻看到"重新排队中"
    const document = await options.store.updateKnowledgeDocument(documentId, {
      status: "pending",
      errorMessage: null
    });

    if (!document) {
      throw new AppError("VALIDATION_ERROR", "未找到知识库文档", 404);
    }

    await options.indexQueue.enqueueDocumentIndex({ documentId });
    // 202 Accepted：表示请求已受理、但索引尚未完成（异步语义）
    reply.status(202).send({ document: toKnowledgeDocumentDto(document) });
  });

  app.post("/knowledge/search", async (request) => {
    const input = parseKnowledgeSearchRequest(request.body);
    return {
      results: await options.retriever.search(input)
    };
  });
}

/** 解析并校验路径参数，失败时抛出 400 业务错误。 */
function parseDocumentParams(params: unknown) {
  const parsed = documentParamsSchema.safeParse(params);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "documentId 必须是非空字符串", 400);
  }

  return parsed.data;
}

/** 解析并校验搜索请求体，失败时抛出 400 业务错误。 */
function parseKnowledgeSearchRequest(body: unknown) {
  const parsed = knowledgeSearchSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "query 必须是非空字符串，limit 必须是 1 到 20 之间的整数", 400);
  }

  return parsed.data;
}

/**
 * 推断存储用的文件扩展名：优先用原始扩展名，没有则按 MIME 兜底，
 * 保证解析器（依赖扩展名分发）能正确识别格式。
 */
function getDocumentExtension(name: string, mimeType: string) {
  const extension = extname(name);

  if (extension) {
    return extension;
  }

  if (mimeType === "application/pdf") {
    return ".pdf";
  }

  if (mimeType.includes("word")) {
    return ".docx";
  }

  return ".txt";
}

/**
 * 当上传请求未携带 MIME 时，根据文件名后缀兜底推断。
 * 浏览器/客户端有时不传 mimetype，没有兜底会导致白名单校验误判。
 */
function getMimeTypeFromName(name: string) {
  const lowerName = name.toLowerCase();

  if (lowerName.endsWith(".pdf")) {
    return "application/pdf";
  }

  if (lowerName.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  if (lowerName.endsWith(".md")) {
    return "text/markdown";
  }

  return "text/plain";
}
