import type { ResourcePart } from "@agent/contracts";
import { apiBaseUrl } from "@/shared/api/api-base-url";
import { getApiErrorMessage, type ApiErrorResponse } from "@/shared/api/types";
import { authenticatedFetch } from "@/features/auth/api/authenticated-fetch";
import type { UploadAgentDocumentResponse, UploadAgentImageResponse } from "./upload-types";

export async function uploadAgentImage(file: File): Promise<ResourcePart> {
  const body = new FormData();
  body.append("image", file);

  const response = await authenticatedFetch(`${apiBaseUrl}/agents/uploads/images`, {
    method: "POST",
    body
  });
  const payload = (await response.json()) as UploadAgentImageResponse | ApiErrorResponse;

  if (!response.ok) {
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
  }

  return (payload as UploadAgentImageResponse).file;
}

export async function uploadAgentDocument(file: File): Promise<ResourcePart> {
  const body = new FormData();
  body.append("document", file);

  const response = await authenticatedFetch(`${apiBaseUrl}/agents/uploads/documents`, {
    method: "POST",
    body
  });
  const payload = (await response.json()) as UploadAgentDocumentResponse | ApiErrorResponse;

  if (!response.ok) {
    throw new Error(getApiErrorMessage(payload as ApiErrorResponse));
  }

  return (payload as UploadAgentDocumentResponse).file;
}
