export type KnowledgeDocumentStatus = "pending" | "indexing" | "ready" | "failed";

export interface KnowledgeDocumentDto {
  id: string;
  name: string;
  mimeType: string;
  status: KnowledgeDocumentStatus;
  errorMessage?: string;
  contentHash: string;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
  indexedAt?: string;
}

export interface KnowledgeSearchResultDto {
  content: string;
  source: string;
  score: number;
  documentId: string;
  chunkId: string;
  documentName: string;
}

export interface KnowledgeDocumentsResponse {
  documents: KnowledgeDocumentDto[];
}

export interface KnowledgeDocumentResponse {
  document: KnowledgeDocumentDto;
}

export interface KnowledgeSearchResponse {
  results: KnowledgeSearchResultDto[];
}
