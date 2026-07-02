import type { AgentStore } from "../agent/agent-store.js";
import { splitKnowledgeText, type SplitKnowledgeTextOptions } from "./chunker.js";
import { parseKnowledgeDocument, type ParsedKnowledgeDocument } from "./document-parser.js";
import type { EmbeddingService } from "./embedding-service.js";

export interface KnowledgeIndexingServiceOptions {
  store: AgentStore;
  embeddingService: EmbeddingService;
  chunkOptions?: SplitKnowledgeTextOptions;
  parseDocument?: typeof parseKnowledgeDocument;
}

export class KnowledgeIndexingService {
  private readonly parseDocument: typeof parseKnowledgeDocument;

  constructor(private readonly options: KnowledgeIndexingServiceOptions) {
    this.parseDocument = options.parseDocument ?? parseKnowledgeDocument;
  }

  async indexDocument(documentId: string): Promise<void> {
    const document = this.options.store.getKnowledgeDocument(documentId);

    if (!document) {
      return;
    }

    this.options.store.updateKnowledgeDocument(document.id, {
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

      this.options.store.replaceKnowledgeChunks(
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
      this.options.store.updateKnowledgeDocument(document.id, {
        status: "ready",
        errorMessage: null,
        chunkCount: chunks.length,
        indexedAt: new Date().toISOString()
      });
    } catch (error) {
      this.options.store.replaceKnowledgeChunks(document.id, []);
      this.options.store.updateKnowledgeDocument(document.id, {
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
