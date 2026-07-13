import type { JsonObject } from "@agent/contracts";

/**
 * 知识库模块的领域类型定义层。
 *
 * 职责边界：
 * - 只描述"数据长什么样"，不包含任何行为逻辑（行为分散在 chunker / parser / service 等文件中）。
 * - 这些类型是仓储层（KnowledgeRepository）、索引服务、检索器之间的"通用语言"，
 *   保证各层之间传递的数据结构一致，避免隐式的 any 契约。
 *
 * 设计说明：
 * - Record 后缀表示"已落库的完整记录"（含 id、时间戳等系统字段）。
 * - Input 后缀表示"外部传入的创建/更新入参"（只含业务字段，不含系统生成字段）。
 */

/**
 * 文档在整个索引生命周期中的状态机。
 *
 * 状态流转：pending(刚上传/待索引) → indexing(正在处理) → ready(可检索) / failed(处理失败)。
 * 这个状态被前端用于展示进度，也被队列用于判断是否需要重试。
 * 不设置"completed"而是"ready"，是为了语义上强调"可被检索使用"，而非仅仅"处理结束"。
 */
export type KnowledgeDocumentStatus = "pending" | "indexing" | "ready" | "failed";

/**
 * 一份知识库文档在系统中的完整记录。
 *
 * 注意 contentHash 的作用：它是文件内容的 SHA-256 指纹，用于：
 * 1. 生成唯一存储文件名，避免同名文件覆盖；
 * 2. 未来可用于去重（相同内容不重复索引）。
 */
export interface KnowledgeDocumentRecord {
  id: string;
  name: string;
  mimeType: string;
  sourcePath: string;
  status: KnowledgeDocumentStatus;
  errorMessage?: string;
  contentHash: string;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
  indexedAt?: string;
}

/**
 * 创建文档时由调用方（HTTP 路由层）提供的入参。
 * status 可选，缺省时仓储层会赋默认值（通常为 pending）。
 */
export interface CreateKnowledgeDocumentInput {
  name: string;
  mimeType: string;
  sourcePath: string;
  contentHash: string;
  status?: KnowledgeDocumentStatus;
}

/**
 * 更新文档入参。所有字段可选，对应"部分更新"语义。
 * errorMessage 类型为 string | null：传 null 表示显式清空错误信息（如重建索引时），
 * 这比 undefined 更能表达"主动清除"的意图。
 */
export interface UpdateKnowledgeDocumentInput {
  status?: KnowledgeDocumentStatus;
  errorMessage?: string | null;
  chunkCount?: number;
  indexedAt?: string;
}

/**
 * 创建一个 chunk（文档切片）的入参。
 *
 * 为什么要把 embedding 直接存在 chunk 上？
 * - 在 RAG 架构里，chunk 是"最小检索单元"，它的向量与其文本必须一一绑定存储，
 *   这样检索时一次查询就能同时拿到文本和向量，无需二次关联。
 * - embeddingModel 记录生成该向量使用的模型，方便后续模型升级后区分新旧向量。
 */
export interface CreateKnowledgeChunkInput {
  chunkIndex: number;
  content: string;
  sourceLabel: string;
  embeddingModel: string;
  embedding: number[];
  metadata?: JsonObject;
}

/**
 * 已落库的 chunk 记录，在创建入参基础上补充了系统生成字段。
 * documentName 冗余存储，避免检索时还要 JOIN 文档表，用空间换查询效率。
 */
export interface KnowledgeChunkRecord extends CreateKnowledgeChunkInput {
  id: string;
  documentId: string;
  documentName: string;
  createdAt: string;
}

/**
 * 向量检索的入参。limit 必填而非可选，强制调用方明确返回数量上限，
 * 避免不设限的全表扫描拖垮数据库。
 */
export interface SearchKnowledgeChunksInput {
  queryEmbedding: number[];
  limit: number;
}

/**
 * 检索命中的 chunk 结果，在完整记录基础上额外携带 score（相似度分数）。
 * 分数由仓储层在执行向量距离计算时产生，调用方可据此排序或过滤低质量命中。
 */
export interface KnowledgeChunkSearchResult extends KnowledgeChunkRecord {
  score: number;
}
