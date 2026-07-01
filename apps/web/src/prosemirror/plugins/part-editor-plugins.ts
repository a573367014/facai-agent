import { Fragment, Slice, type Node as ProseMirrorNode } from "prosemirror-model";
import { NodeSelection, Plugin, Selection, TextSelection } from "prosemirror-state";
import { dropPoint } from "prosemirror-transform";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import type { MessagePart } from "../../api/agent-client";
import { AGENT_MESSAGE_PARTS_MIME, parseMessagePartsFromClipboard } from "../../utils/message-part-clipboard";

export interface InlineBoundaryCaretPluginOptions {
  beforeNodeNames?: string[];
}

export interface AtomicMediaDeletePluginOptions {
  nodeNames?: string[];
}

export interface InlineAtomArrowNavigationPluginOptions {
  nodeNames?: string[];
}

export interface InlineAtomSelectionHighlightPluginOptions {
  nodeNames?: string[];
  className?: string;
  domSelector?: string;
}

export interface ImageUploadEntryPluginOptions {
  onImageFile: (view: EditorView, file: File) => void;
}

export interface DropCursorOptions {
  width?: number;
  color?: string | false;
  className?: string;
}

const boundaryCaretKey = "agent-inline-boundary-caret";
const standardTextClipboardTypes = new Set(["text/plain", "text/html", "text/rtf", "Files"]);
export const inlineBoundaryCaretSelector = `img[data-${boundaryCaretKey}="true"]`;

function isTargetAtomNode(node: ProseMirrorNode | null, nodeNames?: string[]): node is ProseMirrorNode {
  if (!node || node.isText || !node.isAtom) {
    return false;
  }

  return !nodeNames?.length || nodeNames.includes(node.type.name);
}

function needsBoundaryCaret(nodeBefore: ProseMirrorNode | null, nodeAfter: ProseMirrorNode | null, nodeNames?: string[]) {
  // inline atom 后面紧跟非文本节点时，浏览器光标有时没有明显落点。
  // 插入一个不可见分隔元素，可以让用户知道光标在媒体后面。
  return isTargetAtomNode(nodeBefore, nodeNames) && Boolean(nodeAfter && !nodeAfter.isText);
}

function createBoundaryCaretElement() {
  const element = document.createElement("img");
  element.className = "ProseMirror-separator";
  element.alt = "";
  element.setAttribute("aria-hidden", "true");
  element.setAttribute(`data-${boundaryCaretKey}`, "true");
  return element;
}

export function createInlineBoundaryCaretPlugin(options: InlineBoundaryCaretPluginOptions = {}) {
  return new Plugin({
    props: {
      decorations(state) {
        const { selection, doc } = state;

        if (!selection.empty) {
          return DecorationSet.empty;
        }

        const { $from } = selection;

        if (!$from.parent.inlineContent || !needsBoundaryCaret($from.nodeBefore, $from.nodeAfter, options.beforeNodeNames)) {
          return DecorationSet.empty;
        }

        return DecorationSet.create(doc, [
          Decoration.widget(selection.from, createBoundaryCaretElement, {
            key: boundaryCaretKey,
            raw: true
          } as Parameters<typeof Decoration.widget>[2])
        ]);
      }
    }
  });
}

export function createDropSelectionPlugin() {
  return new Plugin({
    appendTransaction(transactions, _oldState, newState) {
      // 拖拽图片/atom 后，ProseMirror 可能保留 NodeSelection。
      // 这里把选择移动到被拖拽节点后面，让用户可以继续输入文字。
      const hasDropTransaction = transactions.some((transaction) => transaction.getMeta("uiEvent") === "drop");

      if (!hasDropTransaction) {
        return null;
      }

      const { selection } = newState;
      let nextSelection: Selection | null = null;

      if (selection instanceof NodeSelection) {
        const afterPosition = selection.from + selection.node.nodeSize;

        if (afterPosition > newState.doc.content.size) {
          return null;
        }

        nextSelection = TextSelection.near(newState.doc.resolve(afterPosition), 1);
      } else if (selection instanceof TextSelection && !selection.empty) {
        nextSelection = TextSelection.near(newState.doc.resolve(selection.to), 1);
      }

      if (!nextSelection || selection.eq(nextSelection)) {
        return null;
      }

      return newState.tr.setSelection(nextSelection).setMeta("addToHistory", false).setMeta("actionType", "selection.drop.after-node");
    }
  });
}

export function createAtomicMediaDeletePlugin(options: AtomicMediaDeletePluginOptions = {}) {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        // media_part 是 atom 节点，删除时应该整体删掉。
        // 否则 Backspace/Delete 可能只移动光标，看起来像按键失效。
        if (event.key !== "Backspace" && event.key !== "Delete") {
          return false;
        }

        const range = resolveAtomicDeleteRange(view, event.key, options.nodeNames);

        if (!range) {
          return false;
        }

        event.preventDefault();
        const transaction = view.state.tr.delete(range.from, range.to).scrollIntoView();
        view.dispatch(transaction);
        return true;
      }
    }
  });
}

export function createInlineAtomArrowNavigationPlugin(options: InlineAtomArrowNavigationPluginOptions = {}) {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        // 左右方向键遇到 inline atom 时，显式跳过整个节点。
        // 这比让浏览器猜光标位置更稳定，尤其是图片前后混排文字时。
        const direction = getPlainHorizontalDirection(view, event);

        if (!direction) {
          return false;
        }

        const targetPosition = resolveInlineAtomArrowTarget(view, direction, options.nodeNames);

        if (typeof targetPosition !== "number") {
          return false;
        }

        const handled = setTextSelection(view, targetPosition, `inline-atom.arrow-${direction}`);

        if (handled) {
          consumeKeyboardEvent(event);
        }

        return handled;
      }
    }
  });
}

export function createInlineAtomSelectionHighlightPlugin(options: InlineAtomSelectionHighlightPluginOptions = {}) {
  const className = options.className ?? "is-range-selected";
  const domSelector = options.domSelector ?? ".pm-part--media";

  return new Plugin({
    props: {
      decorations(state) {
        const { doc, selection } = state;

        if (selection.empty) {
          return DecorationSet.empty;
        }

        const decorations: Decoration[] = [];

        doc.nodesBetween(selection.from, selection.to, (node, position) => {
          if (!isTargetAtomNode(node, options.nodeNames)) {
            return true;
          }

          const nodeTo = position + node.nodeSize;
          if (selection.from < nodeTo && selection.to > position) {
            decorations.push(Decoration.node(position, nodeTo, { class: className }));
          }

          return false;
        });

        return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
      }
    },
    view(view) {
      const ownerDocument = view.dom.ownerDocument;
      const refreshDomSelectionState = () => {
        // 浏览器原生 DOM selection 和 ProseMirror state selection 不总是同步到 class。
        // 每次 selectionchange 主动刷新媒体节点高亮，让拖选/键盘选择的视觉反馈一致。
        syncInlineAtomDomRangeSelection(view, {
          className,
          domSelector,
          nodeNames: options.nodeNames
        });
      };

      ownerDocument.addEventListener("selectionchange", refreshDomSelectionState);
      refreshDomSelectionState();

      return {
        update() {
          refreshDomSelectionState();
        },
        destroy() {
          ownerDocument.removeEventListener("selectionchange", refreshDomSelectionState);
          clearInlineAtomDomRangeSelection(view.dom, domSelector, className);
        }
      };
    }
  });
}

function syncInlineAtomDomRangeSelection(
  view: EditorView,
  options: Required<Pick<InlineAtomSelectionHighlightPluginOptions, "className" | "domSelector">> &
    Pick<InlineAtomSelectionHighlightPluginOptions, "nodeNames">
) {
  const domSelection = view.dom.ownerDocument.getSelection();

  view.dom.querySelectorAll<HTMLElement>(options.domSelector).forEach((element) => {
    const isSelected =
      isDomRangeSelectionIntersectingNode(domSelection, element) ||
      isInlineAtomElementSelectedByState(view, element, options.nodeNames);

    element.classList.toggle(options.className, isSelected);
  });
}

function clearInlineAtomDomRangeSelection(root: HTMLElement, selector: string, className: string) {
  root.querySelectorAll<HTMLElement>(selector).forEach((element) => {
    element.classList.remove(className);
  });
}

function isDomRangeSelectionIntersectingNode(selection: globalThis.Selection | null, node: Node) {
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

function isInlineAtomElementSelectedByState(view: EditorView, element: HTMLElement, nodeNames?: string[]) {
  const { selection } = view.state;

  if (selection.empty) {
    return false;
  }

  const position = resolveInlineAtomElementPosition(view, element, nodeNames);

  if (typeof position !== "number") {
    return false;
  }

  const node = view.state.doc.nodeAt(position);

  if (!isTargetAtomNode(node, nodeNames)) {
    return false;
  }

  return selection.from < position + node.nodeSize && selection.to > position;
}

function resolveInlineAtomElementPosition(view: EditorView, element: HTMLElement, nodeNames?: string[]) {
  const candidates = [view.posAtDOM(element, 0), Math.max(0, view.posAtDOM(element, 0) - 1)];

  for (const position of new Set(candidates)) {
    const node = view.state.doc.nodeAt(position);

    if (isTargetAtomNode(node, nodeNames)) {
      return position;
    }
  }

  return undefined;
}

export function createClearSelectionOnOutsidePointerPlugin() {
  return new Plugin({
    view(view) {
      const ownerDocument = view.dom.ownerDocument;
      const handleClick = (event: MouseEvent) => {
        const target = event.target;

        if (!(target instanceof Node) || view.dom.contains(target) || view.state.selection.empty) {
          return;
        }

        // 用户点到编辑器外面后，把内部选区折叠掉。
        // 这样外部按钮获得焦点时，编辑器里不会还残留一块蓝色选中态。
        const position = Math.min(view.state.selection.to, view.state.doc.content.size);
        const nextSelection = TextSelection.near(view.state.doc.resolve(position), -1);

        if (view.state.selection.eq(nextSelection)) {
          return;
        }

        view.dispatch(
          view.state.tr
            .setSelection(nextSelection)
            .setMeta("addToHistory", false)
            .setMeta("actionType", "selection.clear.outside-pointer")
        );
      };

      ownerDocument.addEventListener("click", handleClick);

      return {
        destroy() {
          ownerDocument.removeEventListener("click", handleClick);
        }
      };
    }
  });
}

export function createImageUploadEntryPlugin(options: ImageUploadEntryPluginOptions) {
  return new Plugin({
    props: {
      handleDOMEvents: {
        paste(view, event) {
          // 粘贴/拖拽图片文件时直接进入上传流程；
          // 普通文本粘贴交给 createPlainTextPastePlugin 处理。
          const image = getFirstImageFile((event as ClipboardEvent).clipboardData?.files);

          if (!image) {
            return false;
          }

          event.preventDefault();
          options.onImageFile(view, image);
          return true;
        },
        dragover(_view, event) {
          if (!getFirstImageFile((event as DragEvent).dataTransfer?.files)) {
            return false;
          }

          event.preventDefault();
          return true;
        },
        drop(view, event) {
          const image = getFirstImageFile((event as DragEvent).dataTransfer?.files);

          if (!image) {
            return false;
          }

          event.preventDefault();
          syncSelectionToDropPoint(view, event as DragEvent);
          options.onImageFile(view, image);
          return true;
        }
      }
    }
  });
}

export function createPlainTextPastePlugin() {
  return new Plugin({
    props: {
      handleDOMEvents: {
        paste(view, event) {
          const clipboard = (event as ClipboardEvent).clipboardData;

          if (!clipboard) {
            return false;
          }

          const messageParts = parseMessagePartsFromClipboard(clipboard.getData(AGENT_MESSAGE_PARTS_MIME));

          if (messageParts?.length) {
            // 项目内部复制消息时会带自定义 MIME，粘贴回来可以保留媒体 part/extra 等结构化信息。
            const slice = createMessagePartsSlice(view, messageParts);

            if (!slice.content.size) {
              return false;
            }

            event.preventDefault();
            view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView().setMeta("actionType", "clipboard.paste.message-parts"));
            return true;
          }

          if (hasClipboardFiles(clipboard) || hasCustomClipboardTypes(clipboard) || hasProseMirrorClipboardHtml(clipboard)) {
            // 文件、自定义富文本、ProseMirror 自己的 HTML 都交给默认流程或其他插件。
            // 这里只兜底处理最普通的纯文本，避免把外部富文本误降级。
            return false;
          }

          const text = normalizePlainText(clipboard.getData("text/plain"));

          if (!text) {
            return false;
          }

          const slice = createPlainTextSlice(view, text);

          if (!slice.content.size) {
            return false;
          }

          event.preventDefault();
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView().setMeta("actionType", "clipboard.paste.plain-text"));
          return true;
        }
      }
    }
  });
}

export function dropCursor(options: DropCursorOptions = {}) {
  return new Plugin({
    view(editorView) {
      return new DropCursorView(editorView, options);
    }
  });
}

function getPlainHorizontalDirection(view: EditorView, event: KeyboardEvent): "left" | "right" | null {
  if (
    event.defaultPrevented ||
    view.composing ||
    event.isComposing ||
    event.shiftKey ||
    event.altKey ||
    event.metaKey ||
    event.ctrlKey
  ) {
    return null;
  }

  if (event.key === "ArrowLeft") {
    return "left";
  }

  if (event.key === "ArrowRight") {
    return "right";
  }

  return null;
}

function resolveInlineAtomArrowTarget(view: EditorView, direction: "left" | "right", nodeNames?: string[]) {
  const { selection } = view.state;

  if (selection instanceof NodeSelection && isTargetAtomNode(selection.node, nodeNames)) {
    return direction === "left" ? selection.from : selection.to;
  }

  if (!(selection instanceof TextSelection) || !selection.empty) {
    return null;
  }

  if (direction === "left" && isTargetAtomNode(selection.$from.nodeBefore, nodeNames)) {
    return selection.from - selection.$from.nodeBefore.nodeSize;
  }

  if (direction === "right" && isTargetAtomNode(selection.$from.nodeAfter, nodeNames)) {
    return selection.from + selection.$from.nodeAfter.nodeSize;
  }

  return null;
}

function setTextSelection(view: EditorView, position: number, actionType: string) {
  if (position < 0 || position > view.state.doc.content.size) {
    return false;
  }

  const resolvedPosition = view.state.doc.resolve(position);

  if (!resolvedPosition.parent.inlineContent) {
    return false;
  }

  const transaction = view.state.tr
    .setSelection(TextSelection.create(view.state.doc, position))
    .setMeta("addToHistory", false)
    .setMeta("actionType", actionType);
  view.dispatch(transaction);
  return true;
}

function consumeKeyboardEvent(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function resolveAtomicDeleteRange(view: EditorView, key: "Backspace" | "Delete", nodeNames?: string[]) {
  const { selection, doc } = view.state;

  if (selection instanceof NodeSelection && isTargetAtomNode(selection.node, nodeNames)) {
    return {
      from: selection.from,
      to: selection.to
    };
  }

  if (!(selection instanceof TextSelection) || !selection.empty) {
    return null;
  }

  const position = key === "Backspace" ? selection.from - 1 : selection.from;

  if (position < 0 || position > doc.content.size) {
    return null;
  }

  const node = doc.nodeAt(position);

  if (!isTargetAtomNode(node, nodeNames)) {
    return null;
  }

  return {
    from: position,
    to: position + node.nodeSize
  };
}

function getFirstImageFile(files?: FileList | File[] | null) {
  return Array.from(files ?? []).find((file) => file.type.startsWith("image/"));
}

function normalizePlainText(text: string) {
  return text.replace(/\r\n?/g, "\n");
}

function hasClipboardFiles(clipboard: DataTransfer) {
  return Array.from(clipboard.files || []).length > 0;
}

function hasCustomClipboardTypes(clipboard: DataTransfer) {
  return Array.from(clipboard.types || []).some((type) => !standardTextClipboardTypes.has(type));
}

function hasProseMirrorClipboardHtml(clipboard: DataTransfer) {
  return clipboard.getData("text/html").includes("data-pm-slice=");
}

function createPlainTextSlice(view: EditorView, text: string) {
  const nodes = text.split("\n").flatMap((line, index) => {
    const inlineNodes: ProseMirrorNode[] = [];

    if (index > 0) {
      inlineNodes.push(view.state.schema.nodes.hard_break.create());
    }

    if (line) {
      inlineNodes.push(view.state.schema.text(line));
    }

    return inlineNodes;
  });

  return new Slice(Fragment.fromArray(nodes), 0, 0);
}

function createMessagePartsSlice(view: EditorView, parts: MessagePart[]) {
  const nodes = parts.flatMap((part) => {
    if (part.type === "text") {
      return createTextInlineNodes(view, part.value);
    }

    return [
      view.state.schema.nodes.media_part.create({
        mime: part.mime ?? "",
        url: part.url ?? "",
        name: part.name ?? "",
        size: part.size ?? null,
        width: part.width ?? null,
        height: part.height ?? null,
        extra: part.extra ?? null
      })
    ];
  });

  return new Slice(Fragment.fromArray(nodes), 0, 0);
}

function createTextInlineNodes(view: EditorView, text: string) {
  return text.split("\n").flatMap((line, index) => {
    const inlineNodes: ProseMirrorNode[] = [];

    if (index > 0) {
      inlineNodes.push(view.state.schema.nodes.hard_break.create());
    }

    if (line) {
      inlineNodes.push(view.state.schema.text(line));
    }

    return inlineNodes;
  });
}

function syncSelectionToDropPoint(view: EditorView, event: DragEvent) {
  const position = view.posAtCoords({ left: event.clientX, top: event.clientY });

  if (!position) {
    return;
  }

  const transaction = view.state.tr
    .setSelection(TextSelection.near(view.state.doc.resolve(position.pos)))
    .setMeta("addToHistory", false);
  view.dispatch(transaction);
}

class DropCursorView {
  private cursorPosition: number | null = null;
  private element: HTMLDivElement | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | undefined;
  private readonly handlers: Array<{ name: string; handler: EventListener }>;

  constructor(private editorView: EditorView, private options: DropCursorOptions) {
    this.handlers = ["dragover", "dragend", "drop", "dragleave"].map((name) => {
      const handler = (event: Event) => {
        this.handleEvent(name, event);
      };
      this.editorView.dom.addEventListener(name, handler);
      return { name, handler };
    });
  }

  destroy() {
    for (const { name, handler } of this.handlers) {
      this.editorView.dom.removeEventListener(name, handler);
    }

    this.removeElement();
  }

  update(editorView: EditorView, previousState: EditorView["state"]) {
    this.editorView = editorView;

    if (this.cursorPosition !== null && previousState.doc !== editorView.state.doc) {
      if (this.cursorPosition > editorView.state.doc.content.size) {
        this.setCursor(null);
        return;
      }

      this.updateOverlay();
    }
  }

  private handleEvent(name: string, event: Event) {
    if (name === "dragover") {
      this.handleDragOver(event as DragEvent);
      return;
    }

    if (name === "dragleave" && this.editorView.dom.contains((event as DragEvent).relatedTarget as Node | null)) {
      return;
    }

    this.scheduleRemoval(name === "dragend" || name === "drop" ? 20 : 0);
  }

  private handleDragOver(event: DragEvent) {
    if (!this.editorView.editable) {
      return;
    }

    const position = this.editorView.posAtCoords({ left: event.clientX, top: event.clientY });

    if (!position) {
      this.setCursor(null);
      return;
    }

    let targetPosition = position.pos;

    if (this.editorView.dragging?.slice) {
      const droppedPoint = dropPoint(this.editorView.state.doc, targetPosition, this.editorView.dragging.slice);
      if (droppedPoint !== null) {
        targetPosition = droppedPoint;
      }
    }

    if (!this.editorView.state.doc.resolve(targetPosition).parent.inlineContent) {
      this.setCursor(null);
      return;
    }

    this.setCursor(targetPosition);
    this.scheduleRemoval(5000);
  }

  private scheduleRemoval(timeout: number) {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }

    this.timeoutId = setTimeout(() => this.setCursor(null), timeout);
  }

  private setCursor(position: number | null) {
    if (position === this.cursorPosition) {
      return;
    }

    this.cursorPosition = position;

    if (position === null) {
      this.removeElement();
      return;
    }

    this.updateOverlay();
  }

  private updateOverlay() {
    if (this.cursorPosition === null) {
      return;
    }

    const resolvedPosition = this.editorView.state.doc.resolve(this.cursorPosition);

    if (!resolvedPosition.parent.inlineContent) {
      this.setCursor(null);
      return;
    }

    const editorElement = this.editorView.dom as HTMLElement;
    const editorRect = editorElement.getBoundingClientRect();
    // 页面可能有 CSS transform/zoom，coordsAtPos 返回的是视口坐标。
    // 用真实 rect 和 offsetWidth 计算缩放比例，拖拽光标才能贴在正确位置。
    const scaleX = editorRect.width / editorElement.offsetWidth || 1;
    const scaleY = editorRect.height / editorElement.offsetHeight || 1;
    const coords = this.editorView.coordsAtPos(this.cursorPosition);
    const width = this.options.width ?? 2;
    const parent = (editorElement.offsetParent as HTMLElement | null) ?? document.body;
    const parentRect = parent.getBoundingClientRect();

    if (!this.element) {
      this.element = document.createElement("div");
      this.element.className = this.options.className ?? "part-composer-drop-cursor";
      this.element.style.position = "absolute";
      this.element.style.zIndex = "50";
      this.element.style.pointerEvents = "none";
      if (this.options.color !== false) {
        this.element.style.backgroundColor = this.options.color ?? "#247a73";
      }
      parent.appendChild(this.element);
    }

    this.element.style.left = `${(coords.left - parentRect.left - width / 2) / scaleX}px`;
    this.element.style.top = `${(coords.top - parentRect.top) / scaleY}px`;
    this.element.style.width = `${width / scaleX}px`;
    this.element.style.height = `${(coords.bottom - coords.top) / scaleY}px`;
  }

  private removeElement() {
    this.element?.parentNode?.removeChild(this.element);
    this.element = null;
  }
}
