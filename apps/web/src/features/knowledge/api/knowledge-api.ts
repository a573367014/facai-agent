import { apiBaseUrl } from "@/shared/api/api-base-url";
import { getApiErrorMessage, type ApiErrorResponse } from "@/shared/api/types";
import { authenticatedFetch } from "@/features/auth/api/authenticated-fetch";
import type {
  KnowledgeDocumentRecord,
  KnowledgeDocumentResponse,
  KnowledgeDocumentsResponse,
  KnowledgeSearchResponse,
  KnowledgeSearchResult
} from "./knowledge-types";

export async function listKnowledgeDocuments(): Promise<KnowledgeDocumentRecord[]> {
  const response = await authenticatedFetch(`${apiBaseUrl}/knowledge/documents`);
  const payload = (await response.json()) as KnowledgeDocumentsResponse | ApiErrorResponse;

  if (!response.ok) {
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
  }

  return (payload as KnowledgeDocumentsResponse).documents;
}

export async function uploadKnowledgeDocument(file: File): Promise<KnowledgeDocumentRecord> {
  const body = new FormData();
  body.append("document", file);

  const response = await authenticatedFetch(`${apiBaseUrl}/knowledge/documents/upload`, {
    method: "POST",
    body
  });
  const payload = (await response.json()) as KnowledgeDocumentResponse | ApiErrorResponse;

  if (!response.ok) {
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
  }

  return (payload as KnowledgeDocumentResponse).document;
}

export async function deleteKnowledgeDocument(documentId: string): Promise<void> {
  const response = await authenticatedFetch(`${apiBaseUrl}/knowledge/documents/${documentId}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    const errorPayload = (await response.json()) as ApiErrorResponse;
    throw new Error(getApiErrorMessage(errorPayload));
  }
}

export async function reindexKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentRecord> {
  const response = await authenticatedFetch(`${apiBaseUrl}/knowledge/documents/${documentId}/reindex`, {
    method: "POST"
  });
  const payload = (await response.json()) as KnowledgeDocumentResponse | ApiErrorResponse;

  if (!response.ok) {
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
  }

  return (payload as KnowledgeDocumentResponse).document;
}

export async function searchKnowledge(query: string, limit = 5): Promise<KnowledgeSearchResult[]> {
  const response = await authenticatedFetch(`${apiBaseUrl}/knowledge/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ query, limit })
  });
  const payload = (await response.json()) as KnowledgeSearchResponse | ApiErrorResponse;

  if (!response.ok) {
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
  }

  return (payload as KnowledgeSearchResponse).results;
}
