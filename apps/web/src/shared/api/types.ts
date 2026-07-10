import type { ApiErrorResponse } from "@agent/contracts";

export type { ApiErrorResponse } from "@agent/contracts";

export function getApiErrorMessage(payload: ApiErrorResponse): string {
  return `${payload.error.code}: ${payload.error.message}`;
}
