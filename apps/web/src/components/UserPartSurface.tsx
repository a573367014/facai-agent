import { forwardRef, useEffect, useImperativeHandle, useRef, type ClipboardEvent as ReactClipboardEvent } from "react";
import type { MediaPart, MessagePart, PartExtra } from "../api/agent-client";
import {
  AGENT_MESSAGE_PARTS_MIME,
  messagePartsToPlainText,
  serializeMessagePartsForClipboard
} from "../utils/message-part-clipboard";

interface UserPartSurfaceProps {
  parts: MessagePart[];
}

export interface UserPartSurfaceHandle {
  getSelectedParts: () => MessagePart[] | undefined;
}

export const UserPartSurface = forwardRef<UserPartSurfaceHandle, UserPartSurfaceProps>(function UserPartSurface({ parts }, ref) {
  const editorRef = useRef<HTMLDivElement | null>(null);

  useImperativeHandle(ref, () => ({
    getSelectedParts: () => getSelectedDomParts(editorRef.current)
  }));

  useEffect(() => {
    const editor = editorRef.current;

    if (!editor) {
      return;
    }

    const ownerDocument = editor.ownerDocument;
    const refreshRangeSelection = () => {
      syncMediaRangeSelection(editor);
    };

    ownerDocument.addEventListener("selectionchange", refreshRangeSelection);
    refreshRangeSelection();

    return () => {
      ownerDocument.removeEventListener("selectionchange", refreshRangeSelection);
      clearMediaRangeSelection(editor);
    };
  }, [parts]);

  return (
    <div className="user-part-surface">
      <div className="part-composer-editor user-part-surface-editor" aria-label="用户消息内容" onCopy={handleCopy} ref={editorRef}>
        {parts.map((part, index) => renderUserPart(part, index))}
      </div>
    </div>
  );
});

function handleCopy(event: ReactClipboardEvent<HTMLDivElement>) {
  const selectedParts = getSelectedDomParts(event.currentTarget);

  if (!selectedParts?.length) {
    return;
  }

  event.preventDefault();
  event.clipboardData.setData("text/plain", messagePartsToPlainText(selectedParts));
  event.clipboardData.setData(AGENT_MESSAGE_PARTS_MIME, serializeMessagePartsForClipboard(selectedParts));
}

function renderUserPart(part: MessagePart, index: number) {
  if (part.type === "text") {
    return (
      <span className="user-part-text" data-user-part-index={index} data-user-part-kind="text" key={`text-${index}`}>
        {part.value}
      </span>
    );
  }

  const mediaLabel = getMediaLabel(part.mime);
  const label = part.name || mediaLabel;
  const mediaAttrs = createMediaDataAttrs(part, index);

  return (
    <span className="pm-part pm-part--media" key={`media-${index}`} {...mediaAttrs}>
      {part.url && !isVideoMime(part.mime) ? (
        <img className="pm-part-media-thumb" src={part.url} alt={label} draggable={false} />
      ) : (
        <span className="pm-part-media-placeholder">{mediaLabel}</span>
      )}
      <span className="pm-part-media-name">{label}</span>
    </span>
  );
}

function createMediaDataAttrs(part: MediaPart, index: number) {
  const mediaLabel = getMediaLabel(part.mime);

  return {
    "aria-label": part.name || mediaLabel,
    "data-height": typeof part.height === "number" ? String(part.height) : undefined,
    "data-extra": part.extra ? JSON.stringify(part.extra) : undefined,
    "data-mime": part.mime ?? "",
    "data-name": part.name ?? "",
    "data-size": typeof part.size === "number" ? String(part.size) : undefined,
    "data-url": part.url ?? "",
    "data-user-part-index": index,
    "data-user-part-kind": "media",
    "data-width": typeof part.width === "number" ? String(part.width) : undefined
  };
}

function isVideoMime(value?: string) {
  return value?.startsWith("video/") ?? false;
}

function getMediaLabel(mime?: string) {
  return isVideoMime(mime) ? "视频" : "图片";
}

function getSelectedDomParts(root: HTMLElement | null): MessagePart[] | undefined {
  if (!root) {
    return undefined;
  }

  const selection = root.ownerDocument.getSelection();

  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return undefined;
  }

  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  const selectedParts: MessagePart[] = [];

  root.querySelectorAll<HTMLElement>("[data-user-part-kind]").forEach((element) => {
    const kind = element.dataset.userPartKind;

    if (kind === "text") {
      pushTextPart(selectedParts, getSelectedText(element, ranges));
      return;
    }

    if (kind === "media" && ranges.some((range) => range.intersectsNode(element))) {
      selectedParts.push(mediaElementToPart(element));
    }
  });

  return selectedParts.length > 0 ? selectedParts : undefined;
}

function pushTextPart(parts: MessagePart[], value: string) {
  if (!value) {
    return;
  }

  const previous = parts[parts.length - 1];

  if (previous?.type === "text") {
    previous.value += value;
    return;
  }

  parts.push({ type: "text", value });
}

function getSelectedText(element: HTMLElement, ranges: Range[]) {
  return ranges
    .filter((range) => range.intersectsNode(element))
    .map((range) => getSelectedTextFromRange(element, range))
    .join("");
}

function getSelectedTextFromRange(element: HTMLElement, range: Range) {
  const scopedRange = range.cloneRange();
  scopedRange.selectNodeContents(element);

  if (element.contains(range.startContainer)) {
    scopedRange.setStart(range.startContainer, range.startOffset);
  }

  if (element.contains(range.endContainer)) {
    scopedRange.setEnd(range.endContainer, range.endOffset);
  }

  return scopedRange.toString();
}

function mediaElementToPart(element: HTMLElement): MediaPart {
  const extra = parsePartExtra(element.dataset.extra);

  return {
    type: "media",
    mime: element.dataset.mime ?? "",
    url: element.dataset.url ?? "",
    ...(element.dataset.name ? { name: element.dataset.name } : {}),
    ...(element.dataset.size ? { size: Number(element.dataset.size) } : {}),
    ...(element.dataset.width ? { width: Number(element.dataset.width) } : {}),
    ...(element.dataset.height ? { height: Number(element.dataset.height) } : {}),
    ...(extra ? { extra } : {})
  };
}

function parsePartExtra(value?: string): PartExtra | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function syncMediaRangeSelection(root: HTMLElement) {
  const selection = root.ownerDocument.getSelection();

  root.querySelectorAll<HTMLElement>(".pm-part--media").forEach((element) => {
    element.classList.toggle("is-range-selected", isRangeSelectionIntersectingNode(selection, element));
  });
}

function clearMediaRangeSelection(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>(".pm-part--media").forEach((element) => {
    element.classList.remove("is-range-selected");
  });
}

function isRangeSelectionIntersectingNode(selection: Selection | null, node: Node) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  if (
    selection.anchorNode &&
    selection.focusNode &&
    node.contains(selection.anchorNode) &&
    node.contains(selection.focusNode)
  ) {
    return false;
  }

  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(node)) {
      return true;
    }
  }

  return false;
}
