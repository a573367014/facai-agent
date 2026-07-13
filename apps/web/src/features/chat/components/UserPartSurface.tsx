import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { ResourcePart, MessagePart, PartExtra } from "@/features/chat/api/agent-types";
import {
  AGENT_MESSAGE_PARTS_MIME,
  messagePartsToPlainText,
  serializeMessagePartsForClipboard
} from "@/features/chat/lib/message-part-clipboard";
import { ResourcePreviewDialog, type ResourcePreviewItem } from "@/features/resources/components/ResourcePreviewDialog";

interface UserPartSurfaceProps {
  parts: MessagePart[];
}

export interface UserPartSurfaceHandle {
  getSelectedParts: () => MessagePart[] | undefined;
}

export const UserPartSurface = forwardRef<UserPartSurfaceHandle, UserPartSurfaceProps>(function UserPartSurface({ parts }, ref) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [previewResource, setPreviewResource] = useState<ResourcePreviewItem>();

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
      syncResourceRangeSelection(editor);
    };

    ownerDocument.addEventListener("selectionchange", refreshRangeSelection);
    refreshRangeSelection();

    return () => {
      ownerDocument.removeEventListener("selectionchange", refreshRangeSelection);
      clearResourceRangeSelection(editor);
    };
  }, [parts]);

  return (
    <div className="user-part-surface">
      <div
        className="part-composer-editor user-part-surface-editor"
        aria-label="用户消息内容"
        onClick={(event) => handleResourcePreviewClick(event, setPreviewResource)}
        onCopy={handleCopy}
        onKeyDown={(event) => handleResourcePreviewKeyDown(event, setPreviewResource)}
        ref={editorRef}
      >
        {parts.map((part, index) => renderUserPart(part, index))}
      </div>
      <ResourcePreviewDialog item={previewResource} onClose={() => setPreviewResource(undefined)} />
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

  const resourceLabel = getResourceLabel(part.mime);
  const label = part.name || resourceLabel;
  const resourceAttrs = createResourceDataAttrs(part, index);

  return (
    <span className="pm-part pm-part--resource" key={`resource-${index}`} {...resourceAttrs} role="button" tabIndex={0} title={`预览${resourceLabel}`}>
      {part.url && isImageMime(part.mime) ? (
        <img className="pm-part-resource-thumb" src={part.url} alt={label} draggable={false} />
      ) : (
        <span className="pm-part-resource-placeholder">{resourceLabel}</span>
      )}
      <span className="pm-part-resource-name">{label}</span>
    </span>
  );
}

function handleResourcePreviewClick(
  event: ReactMouseEvent<HTMLDivElement>,
  onPreview: (item: ResourcePreviewItem) => void
) {
  const resourceElement = closestUserResourceElement(event.target);

  if (!resourceElement || isResourceRangeSelected(resourceElement)) {
    return;
  }

  openResourcePreview(resourceElement, onPreview);
}

function handleResourcePreviewKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  onPreview: (item: ResourcePreviewItem) => void
) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  const resourceElement = closestUserResourceElement(event.target);

  if (!resourceElement) {
    return;
  }

  event.preventDefault();
  openResourcePreview(resourceElement, onPreview);
}

function openResourcePreview(resourceElement: HTMLElement, onPreview: (item: ResourcePreviewItem) => void) {
  const url = resourceElement.dataset.url?.trim();

  if (!url) {
    return;
  }

  onPreview({
    url,
    mime: resourceElement.dataset.mime ?? undefined,
    prompt: resourceElement.dataset.name ?? undefined
  });
}

function closestUserResourceElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof Element) {
    return target.closest<HTMLElement>("[data-user-part-kind='resource']");
  }

  if (target instanceof Text) {
    return target.parentElement?.closest<HTMLElement>("[data-user-part-kind='resource']") ?? null;
  }

  return null;
}

function createResourceDataAttrs(part: ResourcePart, index: number) {
  const resourceLabel = getResourceLabel(part.mime);

  return {
    "aria-label": part.name || resourceLabel,
    "data-height": typeof part.height === "number" ? String(part.height) : undefined,
    "data-extra": part.extra ? JSON.stringify(part.extra) : undefined,
    "data-mime": part.mime ?? "",
    "data-name": part.name ?? "",
    "data-size": typeof part.size === "number" ? String(part.size) : undefined,
    "data-url": part.url ?? "",
    "data-user-part-index": index,
    "data-user-part-kind": "resource",
    "data-width": typeof part.width === "number" ? String(part.width) : undefined
  };
}

function isVideoMime(value?: string) {
  return value?.startsWith("video/") ?? false;
}

function isImageMime(value?: string) {
  return value?.startsWith("image/") ?? false;
}

function isDocumentMime(value?: string) {
  return (
    value?.startsWith("text/") ||
    value === "application/markdown" ||
    value === "application/pdf" ||
    value === "application/msword" ||
    value === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

function getResourceLabel(mime?: string) {
  if (isVideoMime(mime)) {
    return "视频";
  }

  if (isDocumentMime(mime)) {
    return "文档";
  }

  return "图片";
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

    if (kind === "resource" && ranges.some((range) => range.intersectsNode(element))) {
      selectedParts.push(resourceElementToPart(element));
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

function resourceElementToPart(element: HTMLElement): ResourcePart {
  const extra = parsePartExtra(element.dataset.extra);

  return {
    type: "resource",
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

function syncResourceRangeSelection(root: HTMLElement) {
  const selection = root.ownerDocument.getSelection();

  root.querySelectorAll<HTMLElement>(".pm-part--resource").forEach((element) => {
    element.classList.toggle("is-range-selected", isRangeSelectionIntersectingNode(selection, element));
  });
}

function clearResourceRangeSelection(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>(".pm-part--resource").forEach((element) => {
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

function isResourceRangeSelected(element: HTMLElement) {
  return isRangeSelectionIntersectingNode(element.ownerDocument.getSelection(), element);
}
