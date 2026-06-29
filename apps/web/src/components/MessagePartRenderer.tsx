import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentResourceRecord, MediaPart, MessagePart } from "../api/agent-client";
import { MessageImageGallery, type MessageImageGalleryItem } from "./MessageImageGallery";
import type { ToolImageActionPayload } from "./ToolResultPreview";
import type { ToolTrace } from "../utils/tool-traces";

interface MessagePartRendererProps {
  role: "user" | "assistant";
  parts: MessagePart[];
  resourcesById?: Record<string, AgentResourceRecord>;
  showCursor?: boolean;
  onImageAction?: (payload: ToolImageActionPayload) => void;
}

export function MessagePartRenderer({ role, parts, resourcesById = {}, showCursor = false, onImageAction }: MessagePartRendererProps) {
  const text = parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.value)
    .filter((value) => value.length > 0)
    .join("\n");
  const mediaParts = parts.filter((part): part is MediaPart => part.type === "media");

  return (
    <>
      {text ? (
        role === "assistant" ? (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            {showCursor ? <span className="typing-cursor" aria-hidden="true" /> : null}
          </div>
        ) : (
          <p className="chat-text">
            {text}
            {showCursor ? <span className="typing-cursor" aria-hidden="true" /> : null}
          </p>
        )
      ) : null}

      {mediaParts.length > 0 ? (
        <MessageImageGallery
          items={mediaParts.map((part, index) =>
            toMediaGalleryItem(part, index, part.extra?.resource?.id ? resourcesById[part.extra.resource.id] : undefined)
          )}
          onImageAction={onImageAction}
        />
      ) : null}
    </>
  );
}

function toMediaGalleryItem(part: MediaPart, index: number, resource?: AgentResourceRecord): MessageImageGalleryItem {
  const trace = toMediaTrace(part, index, resource);
  const state = resource?.status ?? part.extra?.lifecycle?.state;
  const url = resource?.url ?? part.url;
  const prompt = getResourcePrompt(resource) ?? part.extra?.generation?.prompt ?? part.name;
  const width = resource?.width ?? part.width;
  const height = resource?.height ?? part.height;

  return {
    id: `${part.extra?.resource?.id ?? part.extra?.tool?.toolCallId ?? url ?? "media"}:${part.extra?.tool?.outputIndex ?? index}`,
    url,
    prompt,
    width,
    height,
    state:
      state === "failed"
        ? "failed"
        : state === "pending" || !url
          ? "pending"
          : "succeeded",
    error: getResourceErrorMessage(resource) ?? part.extra?.lifecycle?.error?.message,
    trace
  };
}

function toMediaTrace(part: MediaPart, index: number, resource?: AgentResourceRecord): ToolTrace {
  const state = resource?.status ?? part.extra?.lifecycle?.state;
  const url = resource?.url ?? part.url;
  const prompt = getResourcePrompt(resource) ?? part.extra?.generation?.prompt;
  const width = resource?.width ?? part.width;
  const height = resource?.height ?? part.height;

  return {
    id: part.extra?.tool?.toolCallId ?? `media:${index}`,
    iteration: 0,
    toolName: part.extra?.tool?.name ?? "media",
    status:
      state === "failed"
        ? "failed"
        : state === "succeeded"
          ? "success"
          : "running",
    arguments: {
      prompt,
      width,
      height
    },
    result: url ? { imageUrls: [url], prompt } : undefined,
    error: resource?.status === "failed" ? getResourceError(resource) : part.extra?.lifecycle?.error
  };
}

function getResourcePrompt(resource?: AgentResourceRecord): string | undefined {
  const prompt = resource?.metadata?.prompt;
  return typeof prompt === "string" ? prompt : undefined;
}

function getResourceError(resource?: AgentResourceRecord): { code: string; message: string } | undefined {
  const error = resource?.metadata?.error;

  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return undefined;
  }

  const code = "code" in error && typeof error.code === "string" ? error.code : "RESOURCE_ERROR";
  const message = "message" in error && typeof error.message === "string" ? error.message : "图片生成失败";

  return { code, message };
}

function getResourceErrorMessage(resource?: AgentResourceRecord): string | undefined {
  return getResourceError(resource)?.message;
}
