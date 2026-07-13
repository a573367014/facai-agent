/**
 * 检索器（Retriever）。
 *
 * 职责：把用户的自然语言查询，转换成向量后在知识库里做相似度检索，返回最相关的 chunk。
 *
 * 检索两步走（与索引流水线对称）：
 *   ① 把 query 文本向量化（embedTexts）—— 因为比较必须在同一向量空间里进行；
 *   ② 用该向量在库里做近邻搜索（searchKnowledgeChunks），由仓储层负责实际的距离计算。
 *
 * 为什么检索和索引用同一个 embeddingService：
 * - 向量检索的前提是"查询向量和库内向量由同一模型、在同一空间生成"，
 *   混用不同模型会导致向量空间错位，相似度计算毫无意义。
 *
 * 可观测性：用 OpenTelemetry span 把"向量化"和"向量搜索"分别埋点，
 * 方便定位检索慢是卡在 embedding 还是卡在数据库。
 */
import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { EmbeddingService } from "./embedding-service.js";
import type { KnowledgeRepository } from "./knowledge-repository.js";

const tracer = trace.getTracer("knowledge-retriever");

/** 对外暴露的单条检索结果，已裁剪为上游（LLM / 前端）需要的最小字段集。 */
export interface KnowledgeSearchResult {
  content: string;
  source: string;
  score: number;
  documentId: string;
  chunkId: string;
  documentName: string;
}

export interface KnowledgeRetrieverOptions {
  store: KnowledgeRepository;
  embeddingService: EmbeddingService;
}

export class KnowledgeRetriever {
  constructor(private readonly options: KnowledgeRetrieverOptions) {}

  /**
   * 执行一次语义检索。
   *
   * @param input.query 用户查询文本；空字符串直接返回空结果，避免无意义的向量化开销
   * @param input.limit 返回结果数上限，默认 5（RAG 场景下取 top-k 即可，过多会稀释上下文）
   * @param input.signal 支持中断，便于请求被取消时及时中止下游 embedding 调用
   * @returns 按相关度排序的 chunk 结果
   */
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
        // 记录异常到 span，保证 trace 里能看到失败原因；错误继续向上抛由全局错误处理统一兜底
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
