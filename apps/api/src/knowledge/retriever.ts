import type { AgentStore } from "../agent/agent-store.js";
import type { EmbeddingService } from "./embedding-service.js";

export interface KnowledgeSearchResult {
  content: string;
  source: string;
  score: number;
  documentId: string;
  chunkId: string;
  documentName: string;
}

export interface KnowledgeRetrieverOptions {
  store: AgentStore;
  embeddingService: EmbeddingService;
}

export class KnowledgeRetriever {
  constructor(private readonly options: KnowledgeRetrieverOptions) {}

  async search(input: { query: string; limit?: number; signal?: AbortSignal }): Promise<KnowledgeSearchResult[]> {
    const query = input.query.trim();

    if (!query) {
      return [];
    }

    const [queryEmbedding] = await this.options.embeddingService.embedTexts([query], { signal: input.signal });

    if (!queryEmbedding) {
      return [];
    }

    return this.options.store
      .searchKnowledgeChunks({
        queryEmbedding,
        limit: input.limit ?? 5
      })
      .map((chunk) => ({
        content: chunk.content,
        source: chunk.sourceLabel,
        score: chunk.score,
        documentId: chunk.documentId,
        chunkId: chunk.id,
        documentName: chunk.documentName
      }));
  }
}
