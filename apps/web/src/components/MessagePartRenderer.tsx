import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Ref } from "react";
import type { AgentResourceRecord, MediaPart, MessagePart } from "../api/agent-client";
import { MessageImageGallery, type MessageImageGalleryItem } from "./MessageImageGallery";
import type { ToolImageActionPayload } from "./ToolResultPreview";
import type { ToolTrace } from "../utils/tool-traces";
import { UserPartSurface, type UserPartSurfaceHandle } from "./UserPartSurface";

type AssistantPartGroup =
  | { type: "text"; startIndex: number; value: string }
  | { type: "media"; startIndex: number; parts: MediaPart[] };

interface MessagePartRendererProps {
  role: "user" | "assistant";
  parts: MessagePart[];
  resourcesById?: Record<string, AgentResourceRecord>;
  showCursor?: boolean;
  onImageAction?: (payload: ToolImageActionPayload) => void;
  userPartSurfaceRef?: Ref<UserPartSurfaceHandle>;
}

export function MessagePartRenderer({
  role,
  parts,
  resourcesById = {},
  showCursor = false,
  onImageAction,
  userPartSurfaceRef
}: MessagePartRendererProps) {
  if (role === "user") {
    return <UserPartSurface ref={userPartSurfaceRef} parts={parts} />;
  }

  const groups = groupAssistantParts(parts);
  const lastGroupIsText = groups.length > 0 && groups[groups.length - 1].type === "text";

  return (
    <>
      {groups.map((group, groupIndex) => {
        if (group.type === "text") {
          const isLastGroup = groupIndex === groups.length - 1;
          return (
            <div className="markdown-body" key={`text:${group.startIndex}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{group.value}</ReactMarkdown>
              {showCursor && isLastGroup ? <span className="typing-cursor" aria-hidden="true" /> : null}
            </div>
          );
        }

        return (
          <MessageImageGallery
            key={`media:${group.startIndex}`}
            items={group.parts.map((part, index) => toMediaGalleryItem(part, index))}
            onImageAction={onImageAction}
          />
        );
      })}
      {showCursor && !lastGroupIsText ? <span className="typing-cursor" aria-hidden="true" /> : null}
    </>
  );
}

function groupAssistantParts(parts: MessagePart[]): AssistantPartGroup[] {
  const groups: AssistantPartGroup[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const lastGroup = groups[groups.length - 1];

    if (part.type === "text") {
      if (!part.value) {
        continue;
      }

      if (lastGroup?.type === "text") {
        lastGroup.value = [lastGroup.value, part.value].filter(Boolean).join("\n");
      } else {
        groups.push({ type: "text", startIndex: index, value: part.value });
      }
      continue;
    }

    if (lastGroup?.type === "media") {
      lastGroup.parts.push(part);
    } else {
      groups.push({ type: "media", startIndex: index, parts: [part] });
    }
  }

  return groups;
}

function toMediaGalleryItem(part: MediaPart, index: number): MessageImageGalleryItem {
  const trace = toMediaTrace(part, index);
  const state = part.extra?.lifecycle?.state;
  const url = part.url;
  const prompt = part.extra?.generation?.prompt ?? part.name;
  const width = part.width;
  const height = part.height;
  const missingUrlError = isVideoPart(part) ? "视频资源缺少地址" : "图片资源缺少地址";
  const galleryState =
    state === "failed"
      ? "failed"
      : state === "pending"
        ? "pending"
        : !url
          ? "failed"
          : "succeeded";

  return {
    id: `${part.extra?.resource?.id ?? part.extra?.tool?.toolCallId ?? url ?? "media"}:${part.extra?.tool?.outputIndex ?? index}`,
    resourceId: part.extra?.resource?.id,
    url,
    mime: part.mime,
    prompt,
    width,
    height,
    toolCallRowId: part.extra?.tool?.toolCallRowId,
    outputIndex: part.extra?.tool?.outputIndex ?? index,
    state: galleryState,
    error: part.extra?.lifecycle?.error?.message ?? (galleryState === "failed" && !url ? missingUrlError : undefined),
    trace
  };
}

function toMediaTrace(part: MediaPart, index: number): ToolTrace {
  const state = part.extra?.lifecycle?.state;
  const url = part.url;
  const prompt = part.extra?.generation?.prompt;
  const width = part.width;
  const height = part.height;
  const missingUrlError = isVideoPart(part) ? "视频资源缺少地址" : "图片资源缺少地址";

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
    error: part.extra?.lifecycle?.error ?? (!url && state !== "pending" ? { code: "MEDIA_URL_MISSING", message: missingUrlError } : undefined)
  };
}

function isVideoPart(part: MediaPart) {
  return part.mime?.startsWith("video/") || part.extra?.tool?.name === "generate_video";
}
