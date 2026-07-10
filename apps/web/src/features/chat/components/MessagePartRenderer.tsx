import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Ref } from "react";
import type { AgentResourceRecord, ResourcePart, MessagePart } from "@/features/chat/api/agent-types";
import type { ToolResourceActionPayload } from "@/features/inspector/model/tool-resource-action";
import type { ToolTrace } from "@/features/inspector/model/tool-traces";
import {
  MessageResourceGallery,
  type MessageResourceGalleryItem
} from "@/features/resources/components/MessageResourceGallery";
import { UserPartSurface, type UserPartSurfaceHandle } from "./UserPartSurface";

type AssistantPartGroup =
  | { type: "text"; startIndex: number; value: string }
  | { type: "resource"; startIndex: number; parts: ResourcePart[] };

interface MessagePartRendererProps {
  role: "user" | "assistant";
  parts: MessagePart[];
  resourcesById?: Record<string, AgentResourceRecord>;
  showCursor?: boolean;
  onResourceAction?: (payload: ToolResourceActionPayload) => void;
  userPartSurfaceRef?: Ref<UserPartSurfaceHandle>;
}

export function MessagePartRenderer({
  role,
  parts,
  resourcesById = {},
  showCursor = false,
  onResourceAction,
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
          <MessageResourceGallery
            key={`resource:${group.startIndex}`}
            items={group.parts.map((part, index) => toResourceGalleryItem(part, index, resourcesById))}
            onResourceAction={onResourceAction}
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

    if (lastGroup?.type === "resource") {
      lastGroup.parts.push(part);
    } else {
      groups.push({ type: "resource", startIndex: index, parts: [part] });
    }
  }

  return groups;
}

function toResourceGalleryItem(part: ResourcePart, index: number, resourcesById: Record<string, AgentResourceRecord>): MessageResourceGalleryItem {
  const resourceId = part.extra?.resource?.id;
  const resource = resourceId ? resourcesById[resourceId] : undefined;
  const trace = toResourceTrace(part, index);
  const state = part.extra?.lifecycle?.state;
  const url = part.url;
  const name = part.name ?? resource?.name;
  const prompt = part.extra?.generation?.prompt ?? name;
  const width = part.width;
  const height = part.height;
  const missingUrlError = isDocumentPart(part, resource) ? "文档资源缺少地址" : isVideoPart(part) ? "视频资源缺少地址" : "图片资源缺少地址";
  const galleryState =
    state === "failed"
      ? "failed"
      : state === "pending"
        ? "pending"
        : !url
          ? "failed"
          : "succeeded";

  return {
    id: `${part.extra?.resource?.id ?? part.extra?.tool?.toolCallId ?? url ?? "resource"}:${part.extra?.tool?.outputIndex ?? index}`,
    resourceId,
    url,
    mime: part.mime,
    name,
    prompt,
    width,
    height,
    resourceType: resource?.type,
    toolCallRowId: part.extra?.tool?.toolCallRowId,
    outputIndex: part.extra?.tool?.outputIndex ?? index,
    state: galleryState,
    error: part.extra?.lifecycle?.error?.message ?? (galleryState === "failed" && !url ? missingUrlError : undefined),
    trace
  };
}

function toResourceTrace(part: ResourcePart, index: number): ToolTrace {
  const state = part.extra?.lifecycle?.state;
  const url = part.url;
  const prompt = part.extra?.generation?.prompt;
  const width = part.width;
  const height = part.height;
  const isVideo = isVideoPart(part);
  const isDocument = isDocumentPart(part);
  const missingUrlError = isDocument ? "文档资源缺少地址" : isVideo ? "视频资源缺少地址" : "图片资源缺少地址";

  return {
    id: part.extra?.tool?.toolCallId ?? `resource:${index}`,
    iteration: 0,
    toolName: part.extra?.tool?.name ?? "resource",
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
    result: url ? { [isDocument ? "documents" : isVideo ? "videoUrls" : "imageUrls"]: [url], prompt } : undefined,
    error: part.extra?.lifecycle?.error ?? (!url && state !== "pending" ? { code: "RESOURCE_URL_MISSING", message: missingUrlError } : undefined)
  };
}

function isVideoPart(part: ResourcePart) {
  return part.mime?.startsWith("video/") || part.extra?.tool?.name === "generate_video";
}

function isDocumentPart(part: ResourcePart, resource?: AgentResourceRecord) {
  return (
    resource?.type === "document" ||
    part.extra?.tool?.name === "generate_document" ||
    part.mime?.startsWith("text/") ||
    part.mime === "application/markdown" ||
    part.mime === "application/pdf" ||
    part.mime === "application/msword" ||
    part.mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}
