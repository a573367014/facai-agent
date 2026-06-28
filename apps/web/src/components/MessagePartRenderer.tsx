import { Alert } from "@mui/material";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MediaPart, MessagePart } from "../api/agent-client";
import { ImageLoadingPreview, ImagePreview, type ToolImageActionPayload } from "./ToolResultPreview";
import type { ToolTrace } from "../utils/tool-traces";

interface MessagePartRendererProps {
  role: "user" | "assistant";
  parts: MessagePart[];
  showCursor?: boolean;
  onImageAction?: (payload: ToolImageActionPayload) => void;
}

export function MessagePartRenderer({ role, parts, showCursor = false, onImageAction }: MessagePartRendererProps) {
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
        <div className="message-image-assets">
          {mediaParts.map((part, index) => (
            <MediaPartPreview
              key={`${part.extra?.tool?.toolCallId ?? part.url ?? "media"}:${part.extra?.tool?.outputIndex ?? index}`}
              index={index}
              part={part}
              onImageAction={onImageAction}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function MediaPartPreview({
  part,
  index,
  onImageAction
}: {
  part: MediaPart;
  index: number;
  onImageAction?: (payload: ToolImageActionPayload) => void;
}) {
  const trace = toMediaTrace(part, index);
  const state = part.extra?.lifecycle?.state;

  if (state === "pending" || !part.url) {
    return <ImageLoadingPreview trace={trace} />;
  }

  if (state === "failed") {
    return (
      <Alert className="error-box inline-error" severity="error">
        {part.extra?.lifecycle?.error?.message ?? "图片生成失败"}
      </Alert>
    );
  }

  return (
    <ImagePreview
      trace={trace}
      result={{
        prompt: part.extra?.generation?.prompt,
        imageUrls: [part.url],
        items: [
          {
            index,
            status: "success",
            prompt: part.extra?.generation?.prompt ?? part.name,
            width: part.width,
            height: part.height,
            imageUrls: [part.url]
          }
        ]
      }}
      onImageAction={onImageAction}
    />
  );
}

function toMediaTrace(part: MediaPart, index: number): ToolTrace {
  return {
    id: part.extra?.tool?.toolCallId ?? `media:${index}`,
    iteration: 0,
    toolName: part.extra?.tool?.name ?? "media",
    status:
      part.extra?.lifecycle?.state === "failed"
        ? "failed"
        : part.extra?.lifecycle?.state === "succeeded"
          ? "success"
          : "running",
    arguments: {
      prompt: part.extra?.generation?.prompt,
      width: part.width,
      height: part.height
    },
    result: part.url ? { imageUrls: [part.url], prompt: part.extra?.generation?.prompt } : undefined,
    error: part.extra?.lifecycle?.error
  };
}
