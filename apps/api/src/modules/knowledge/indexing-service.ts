/**
 * 索引服务（Indexing Service）。
 *
 * 职责：编排一份文档从"原始文件"到"可检索向量"的完整流水线，是知识库模块的"指挥中心"。
 *
 * 流水线四步（按顺序串联）：
 *   解析(parseKnowledgeDocument) → 切块(splitKnowledgeText) → 向量化(embedTexts) → 落库(replaceKnowledgeChunks)
 *
 * 为什么用编排者模式而不是让路由层直接调用各步：
 * - 这四步有严格的顺序依赖和事务语义（要么全成功，要么回滚成 failed 状态），
 *   集中在一个服务里管理状态机，避免状态散落、难以追踪。
 * - parseDocument 通过构造参数可注入（默认用真实的解析器，测试时可替换为 mock），
 *   让单元测试不必真的去读文件。
 *
 * 边界：本服务不直接被 HTTP 请求同步调用（索引耗时较长），而是由队列 worker 异步触发。
 */
import { splitKnowledgeText, type SplitKnowledgeTextOptions } from "./chunker.js";
import { parseKnowledgeDocument, type ParsedKnowledgeDocument } from "./document-parser.js";
import type { EmbeddingService } from "./embedding-service.js";
import type { KnowledgeRepository } from "./knowledge-repository.js";

export interface KnowledgeIndexingServiceOptions {
  store: KnowledgeRepository;
  embeddingService: EmbeddingService;
  chunkOptions?: SplitKnowledgeTextOptions;
  /** 解析器可注入，默认用 document-parser 的实现；测试时可替换以避免真实文件 IO。 */
  parseDocument?: typeof parseKnowledgeDocument;
}

export class KnowledgeIndexingService {
  private readonly parseDocument: typeof parseKnowledgeDocument;

  constructor(private readonly options: KnowledgeIndexingServiceOptions) {
    this.parseDocument = options.parseDocument ?? parseKnowledgeDocument;
  }

  /**
   * 对单个文档执行完整的索引流水线。
   *
   * 状态管理说明：
   * - 开始时先把文档置为 indexing，让前端能看到"正在处理"；
   * - 成功则置 ready 并记录 chunkCount / indexedAt；
   * - 任何一步抛错，都会清空该文档的旧 chunk 并置为 failed，把错误信息存进去，
   *   保证文档状态与实际索引结果始终一致（不会出现"状态是 ready 但实际没 chunk"的脏数据）。
   *
   * @param documentId 待索引的文档 id；若文档已被删除则静默返回（幂等）
   */
  async indexDocument(documentId: string): Promise<void> {
    const document = await this.options.store.getKnowledgeDocument(documentId);

    if (!document) {
      return;
    }

    await this.options.store.updateKnowledgeDocument(document.id, {
      status: "indexing",
      errorMessage: null
    });

    try {
      const parsedDocument = await this.parseDocument({
        sourcePath: document.sourcePath,
        mimeType: document.mimeType,
        name: document.name
      });
      const chunks = this.createChunks(parsedDocument);

      if (chunks.length === 0) {
        throw new Error("文档没有可索引的文本内容");
      }

      const embeddings = await this.options.embeddingService.embedTexts(chunks.map((chunk) => chunk.content));

      await this.options.store.replaceKnowledgeChunks(
        document.id,
        chunks.map((chunk, index) => ({
          chunkIndex: index,
          content: chunk.content,
          sourceLabel: `${document.name} #${index + 1}`,
          embeddingModel: this.options.embeddingService.model,
          embedding: embeddings[index] ?? [],
          metadata: {
            startOffset: chunk.startOffset,
            endOffset: chunk.endOffset
          }
        }))
      );
      await this.options.store.updateKnowledgeDocument(document.id, {
        status: "ready",
        errorMessage: null,
        chunkCount: chunks.length,
        indexedAt: new Date().toISOString()
      });
    } catch (error) {
      // 失败时先清空旧 chunk，再标记 failed，确保不会残留半成品向量干扰检索
      await this.options.store.replaceKnowledgeChunks(document.id, []);
      await this.options.store.updateKnowledgeDocument(document.id, {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "索引失败",
        chunkCount: 0
      });
    }
  }

  private createChunks(parsedDocument: ParsedKnowledgeDocument) {
    return splitKnowledgeText(parsedDocument.text, this.options.chunkOptions);
  }
}
