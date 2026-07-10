/**
 * 知识库响应序列化映射器。
 *
 * 职责：把内部领域记录（KnowledgeDocumentRecord）转换成对外契约 DTO（KnowledgeDocumentDto）。
 *
 * 为什么要单独一层映射、而不是直接把 Record 当响应返回：
 * - Record 是"内部完整数据"，可能包含不该暴露给前端的字段（如 sourcePath 这类服务器路径）。
 * - DTO 是"对外契约"（定义在 @agent/contracts），前后端共享同一份类型，保证接口稳定。
 * - 集中映射后，未来内部 Record 结构调整也不会破坏已发布的 API 契约，起到防腐层作用。
 */
import type { KnowledgeDocumentDto } from "@agent/contracts";
import type { KnowledgeDocumentRecord } from "../types.js";

/**
 * 把文档领域记录映射为对外 DTO。
 * 刻意不透传 sourcePath 等内部字段，避免泄露服务器文件路径信息。
 */
export function toKnowledgeDocumentDto(record: KnowledgeDocumentRecord): KnowledgeDocumentDto {
  return {
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    status: record.status,
    errorMessage: record.errorMessage,
    contentHash: record.contentHash,
    chunkCount: record.chunkCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    indexedAt: record.indexedAt
  };
}
