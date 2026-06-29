import { Fragment, Slice, type Node as ProseMirrorNode } from "prosemirror-model";
import { NodeSelection, Plugin, Selection, TextSelection } from "prosemirror-state";
import { dropPoint } from "prosemirror-transform";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";

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
    }
  });
}

export function createImageUploadEntryPlugin(options: ImageUploadEntryPluginOptions) {
  return new Plugin({
    props: {
      handleDOMEvents: {
        paste(view, event) {
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

          if (!clipboard || hasClipboardFiles(clipboard) || hasCustomClipboardTypes(clipboard) || hasProseMirrorClipboardHtml(clipboard)) {
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
