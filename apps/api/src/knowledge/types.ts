import type { JsonObject } from "../tools/types.js";

export type KnowledgeDocumentStatus = "pending" | "indexing" | "ready" | "failed";

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

export interface CreateKnowledgeDocumentInput {
  name: string;
  mimeType: string;
  sourcePath: string;
  contentHash: string;
  status?: KnowledgeDocumentStatus;
}

export interface UpdateKnowledgeDocumentInput {
  status?: KnowledgeDocumentStatus;
  errorMessage?: string | null;
  chunkCount?: number;
  indexedAt?: string;
}

export interface CreateKnowledgeChunkInput {
  chunkIndex: number;
  content: string;
  sourceLabel: string;
  embeddingModel: string;
  embedding: number[];
  metadata?: JsonObject;
}

export interface KnowledgeChunkRecord extends CreateKnowledgeChunkInput {
  id: string;
  documentId: string;
  documentName: string;
  createdAt: string;
}

export interface SearchKnowledgeChunksInput {
  queryEmbedding: number[];
  limit: number;
}

export interface KnowledgeChunkSearchResult extends KnowledgeChunkRecord {
  score: number;
}
