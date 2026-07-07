import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { AgentStore } from "../agent/agent-store.js";
import type { EmbeddingService } from "./embedding-service.js";

const tracer = trace.getTracer("knowledge-retriever");

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

    return tracer.startActiveSpan("knowledge.search", async (span) => {
      span.setAttributes({
        "knowledge.query_length": query.length,
        "knowledge.limit": input.limit ?? 5
      });

      try {
        const queryEmbedding = await tracer.startActiveSpan("knowledge.embed_query", async (embedSpan) => {
          const [vec] = await this.options.embeddingService.embedTexts([query], { signal: input.signal });
          if (vec) {
            embedSpan.setAttribute("knowledge.embedding_dims", vec.length);
          }
          return vec;
        });

        if (!queryEmbedding) {
          span.setAttribute("knowledge.outcome", "no_embedding");
          return [];
        }

        const chunks = await tracer.startActiveSpan("knowledge.vector_search", async (searchSpan) => {
          const results = await this.options.store.searchKnowledgeChunks({
            queryEmbedding,
            limit: input.limit ?? 5
          });
          searchSpan.setAttribute("knowledge.results_count", results.length);
          if (results.length > 0) {
            searchSpan.setAttribute("knowledge.top_score", results[0].score);
          }
          return results;
        });

        span.setAttribute("knowledge.outcome", "ok");
        return chunks.map((chunk) => ({
          content: chunk.content,
          source: chunk.sourceLabel,
          score: chunk.score,
          documentId: chunk.documentId,
          chunkId: chunk.id,
          documentName: chunk.documentName
        }));
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
