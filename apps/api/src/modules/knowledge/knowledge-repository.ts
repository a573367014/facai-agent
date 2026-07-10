/**
 * 知识库仓储层接口（端口）。
 *
 * 职责：定义知识库模块对"持久化"的全部需求，是领域层与具体数据库实现之间的隔离层。
 *
 * 为什么是纯接口、没有实现：
 * - 采用六边形架构（端口-适配器）思想：知识库的业务逻辑（indexing/retriever）只依赖这个抽象端口，
 *   不绑定具体数据库（SQLite/Postgres/pgvector 等由平台适配器各自实现）。
 * - 这样业务逻辑可以被独立测试（用内存 mock 实现），也方便切换底层存储而不改动业务代码。
 */
import type {
  CreateKnowledgeChunkInput,
  CreateKnowledgeDocumentInput,
  KnowledgeChunkSearchResult,
  KnowledgeDocumentRecord,
  SearchKnowledgeChunksInput,
  UpdateKnowledgeDocumentInput
} from "./types.js";

/**
 * Persistence port owned by the knowledge module.
 * Platform adapters may implement it alongside other repositories, but knowledge
 * services must not depend on the Agent store aggregate.
 */
export interface KnowledgeRepository {
  /** 落库一条文档记录，返回含系统生成字段（id/时间戳）的完整记录。 */
  createKnowledgeDocument(input: CreateKnowledgeDocumentInput): Promise<KnowledgeDocumentRecord>;
  /**
   * 部分更新文档。返回 undefined 表示文档不存在（调用方据此判断是否要抛 404）。
   */
  updateKnowledgeDocument(
    documentId: string,
    input: UpdateKnowledgeDocumentInput
  ): Promise<KnowledgeDocumentRecord | undefined>;
  /** 按 id 查询单条文档，不存在返回 undefined。 */
  getKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentRecord | undefined>;
  /** 列出全部文档，用于前端文档列表展示。 */
  listKnowledgeDocuments(): Promise<KnowledgeDocumentRecord[]>;
  /**
   * 删除文档。返回布尔值表示是否真的删除了（false = 不存在），
   * 调用方据此区分"删除成功"和"文档本来就不存在"。
   */
  deleteKnowledgeDocument(documentId: string): Promise<boolean>;
  /**
   * 用新的 chunk 列表整体替换某文档的全部 chunk（先删后建）。
   * "替换"而非"追加"语义，保证重建索引时不会残留旧 chunk。
   * 传空数组即清空该文档所有 chunk。
   */
  replaceKnowledgeChunks(documentId: string, chunks: CreateKnowledgeChunkInput[]): Promise<void>;
  /** 基于向量做相似度检索，返回带 score 的命中结果，具体距离算法由实现决定。 */
  searchKnowledgeChunks(input: SearchKnowledgeChunksInput): Promise<KnowledgeChunkSearchResult[]>;
}
