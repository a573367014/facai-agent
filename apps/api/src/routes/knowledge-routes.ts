import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentStore } from "../agent/agent-store.js";
import { AppError } from "../errors/app-error.js";
import { isSupportedKnowledgeDocument } from "../knowledge/document-parser.js";
import type { KnowledgeIndexQueue } from "../knowledge/knowledge-run-queue.js";
import type { KnowledgeRetriever } from "../knowledge/retriever.js";

const documentParamsSchema = z.object({
  documentId: z.string().min(1)
});
const knowledgeSearchSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(20).optional()
});

export interface RegisterKnowledgeRoutesOptions {
  uploadDirectory: string;
  store: AgentStore;
  indexQueue: KnowledgeIndexQueue;
  retriever: KnowledgeRetriever;
}

export async function registerKnowledgeRoutes(app: FastifyInstance, options: RegisterKnowledgeRoutesOptions): Promise<void> {
  app.get("/knowledge/documents", async () => ({
    documents: options.store.listKnowledgeDocuments()
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

    const buffer = await file.toBuffer();

    if (buffer.length === 0) {
      throw new AppError("VALIDATION_ERROR", "文档内容不能为空", 400);
    }

    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const storedFileName = `${contentHash}${getDocumentExtension(name, mimeType)}`;
    const targetDirectory = join(options.uploadDirectory, "knowledge");
    const sourcePath = join(targetDirectory, storedFileName);

    await mkdir(targetDirectory, { recursive: true });
    await writeFile(sourcePath, buffer);

    const document = options.store.createKnowledgeDocument({
      name,
      mimeType,
      sourcePath,
      contentHash
    });

    await options.indexQueue.enqueueDocumentIndex({ documentId: document.id });
    reply.status(201).send({ document });
  });

  app.delete("/knowledge/documents/:documentId", async (request, reply) => {
    const { documentId } = parseDocumentParams(request.params);
    const deleted = options.store.deleteKnowledgeDocument(documentId);

    if (!deleted) {
      throw new AppError("VALIDATION_ERROR", "未找到知识库文档", 404);
    }

    reply.status(204).send();
  });

  app.post("/knowledge/documents/:documentId/reindex", async (request, reply) => {
    const { documentId } = parseDocumentParams(request.params);
    const document = options.store.updateKnowledgeDocument(documentId, {
      status: "pending",
      errorMessage: null
    });

    if (!document) {
      throw new AppError("VALIDATION_ERROR", "未找到知识库文档", 404);
    }

    await options.indexQueue.enqueueDocumentIndex({ documentId });
    reply.status(202).send({ document });
  });

  app.post("/knowledge/search", async (request) => {
    const input = parseKnowledgeSearchRequest(request.body);
    return {
      results: await options.retriever.search(input)
    };
  });
}

function parseDocumentParams(params: unknown) {
  const parsed = documentParamsSchema.safeParse(params);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "documentId 必须是非空字符串", 400);
  }

  return parsed.data;
}

function parseKnowledgeSearchRequest(body: unknown) {
  const parsed = knowledgeSearchSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "query 必须是非空字符串，limit 必须是 1 到 20 之间的整数", 400);
  }

  return parsed.data;
}

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
