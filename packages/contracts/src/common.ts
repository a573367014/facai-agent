export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = Record<string, unknown>;

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export interface PageInfo {
  hasMore: boolean;
  nextCursor?: string;
  limit: number;
}
