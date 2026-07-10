import type { ToolTrace } from "./tool-traces";

export type ToolResourceActionType = "preview" | "download" | "copy_link" | "quote" | "open_original";

export interface ToolResourceActionPayload {
  action: ToolResourceActionType;
  url: string;
  index: number;
  prompt: string;
  mime?: string;
  width?: number;
  height?: number;
  resourceId?: string;
  toolCallRowId?: string;
  outputIndex?: number;
  trace: ToolTrace;
}
