import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AllSelection, EditorState, NodeSelection, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView, type DecorationSet } from "prosemirror-view";
import { partSchema } from "../part-schema";
import { docToParts, partsToDoc, type RuntimePart } from "../part-serialization";
import {
  AGENT_MESSAGE_PARTS_MIME,
  serializeMessagePartsForClipboard
} from "@/features/chat/lib/message-part-clipboard";
import {
  createAtomicResourceDeletePlugin,
  createClearSelectionOnOutsidePointerPlugin,
  createDropSelectionPlugin,
  createInlineAtomSelectionHighlightPlugin,
  createInlineAtomArrowNavigationPlugin,
  createInlineBoundaryCaretPlugin,
  createPlainTextPastePlugin
} from "./part-editor-plugins";

function getPluginDecorations(plugin: ReturnType<typeof createInlineBoundaryCaretPlugin>, state: EditorState): DecorationSet | undefined {
  const getDecorations = plugin.props.decorations as unknown as ((state: EditorState) => DecorationSet) | undefined;

  return getDecorations?.(state);
}

function handlePluginKeyDown(plugin: ReturnType<typeof createAtomicResourceDeletePlugin>, view: EditorView, event: KeyboardEvent) {
  const handleKeyDown = plugin.props.handleKeyDown as unknown as ((view: EditorView, event: KeyboardEvent) => boolean) | undefined;

  return handleKeyDown?.(view, event);
}

function handleArrowKeyDown(plugin: ReturnType<typeof createInlineAtomArrowNavigationPlugin>, view: EditorView, event: KeyboardEvent) {
  const handleKeyDown = plugin.props.handleKeyDown as unknown as ((view: EditorView, event: KeyboardEvent) => boolean) | undefined;

  return handleKeyDown?.(view, event);
}

function handlePaste(plugin: ReturnType<typeof createPlainTextPastePlugin>, view: EditorView, event: ClipboardEvent) {
  const handlePaste = plugin.props.handleDOMEvents?.paste as unknown as ((view: EditorView, event: ClipboardEvent) => boolean) | undefined;

  return handlePaste?.(view, event);
}

function createPasteEvent(input: { text: string; html?: string; types?: string[]; files?: File[]; data?: Record<string, string> }) {
  const event = new Event("paste", { cancelable: true }) as ClipboardEvent;
  const clipboardData = {
    files: input.files ?? [],
    types: input.types ?? ["text/plain"],
    getData: (type: string) => {
      if (input.data?.[type]) {
        return input.data[type];
      }

      if (type === "text/plain") {
        return input.text;
      }

      if (type === "text/html") {
        return input.html ?? "";
      }

      return "";
    }
  };

  Object.defineProperty(event, "clipboardData", {
    value: clipboardData
  });

  return event;
}

function resourcePart(name: string): RuntimePart {
  return {
    type: "resource",
    mime: "image/png",
    url: `http://localhost:4001/uploads/images/${name}`,
    name
  };
}

function createState(parts: RuntimePart[], selectionPos?: number) {
  const doc = partsToDoc(parts);
  return EditorState.create({
    schema: partSchema,
    doc,
    selection: typeof selectionPos === "number" ? TextSelection.create(doc, selectionPos) : undefined
  });
}

function findFirstResourcePosition(state: EditorState) {
  let found: number | undefined;

  state.doc.descendants((node, pos) => {
    if (typeof found !== "number" && node.type.name === "resource_part") {
      found = pos;
      return false;
    }

    return true;
  });

  if (typeof found !== "number") {
    throw new Error("未找到 resource_part");
  }

  return found;
}

describe("part editor plugins", () => {
  it("在两个 inline atom 中间补充边界光标锚点", () => {
    const plugin = createInlineBoundaryCaretPlugin({ beforeNodeNames: ["resource_part"] });
    const baseState = createState([resourcePart("a.png"), resourcePart("b.png")]);
    const firstResourcePosition = findFirstResourcePosition(baseState);
    const state = createState([resourcePart("a.png"), resourcePart("b.png")], firstResourcePosition + 1);

    const decorations = getPluginDecorations(plugin, state);

    expect(decorations?.find()).toHaveLength(1);
  });

  it("resource part 后面是文本时不插入额外边界光标锚点", () => {
    const plugin = createInlineBoundaryCaretPlugin({ beforeNodeNames: ["resource_part"] });
    const baseState = createState([resourcePart("a.png"), { type: "text", value: "继续" }]);
    const firstResourcePosition = findFirstResourcePosition(baseState);
    const state = createState([resourcePart("a.png"), { type: "text", value: "继续" }], firstResourcePosition + 1);

    const decorations = getPluginDecorations(plugin, state);

    expect(decorations?.find()).toHaveLength(0);
  });

  it("drop 后如果残留 NodeSelection，会把光标收敛到节点后方", () => {
    const plugin = createDropSelectionPlugin();
    const oldState = createState([{ type: "text", value: "看" }, resourcePart("a.png"), { type: "text", value: "这张" }]);
    const resourcePosition = findFirstResourcePosition(oldState);
    const dropTransaction = oldState.tr.setSelection(NodeSelection.create(oldState.doc, resourcePosition)).setMeta("uiEvent", "drop");
    const newState = oldState.apply(dropTransaction);

    const appended = plugin.spec.appendTransaction?.([dropTransaction], oldState, newState);

    expect(appended?.selection).toBeInstanceOf(TextSelection);
    expect(appended?.selection.from).toBe(resourcePosition + 1);
  });

  it("Backspace 会删除光标前面的 resource part", () => {
    const plugin = createAtomicResourceDeletePlugin({ nodeNames: ["resource_part"] });
    const state = createState([{ type: "text", value: "看" }, resourcePart("a.png"), { type: "text", value: "这张" }]);
    const resourcePosition = findFirstResourcePosition(state);
    const cursorAfterResourceState = state.apply(state.tr.setSelection(TextSelection.create(state.doc, resourcePosition + 1)));
    let nextState: EditorState | undefined;

    const handled = handlePluginKeyDown(
      plugin,
      {
        state: cursorAfterResourceState,
        dispatch: (transaction: Transaction) => {
          nextState = cursorAfterResourceState.apply(transaction);
        }
      } as unknown as EditorView,
      new KeyboardEvent("keydown", { key: "Backspace" })
    );

    expect(handled).toBe(true);
    expect(docToParts(nextState?.doc ?? cursorAfterResourceState.doc)).toEqual([
      { type: "text", value: "看这张" }
    ]);
  });

  it("Delete 会删除光标后面的 resource part", () => {
    const plugin = createAtomicResourceDeletePlugin({ nodeNames: ["resource_part"] });
    const state = createState([{ type: "text", value: "看" }, resourcePart("a.png"), { type: "text", value: "这张" }]);
    const resourcePosition = findFirstResourcePosition(state);
    const cursorBeforeResourceState = state.apply(state.tr.setSelection(TextSelection.create(state.doc, resourcePosition)));
    let nextState: EditorState | undefined;

    const handled = handlePluginKeyDown(
      plugin,
      {
        state: cursorBeforeResourceState,
        dispatch: (transaction: Transaction) => {
          nextState = cursorBeforeResourceState.apply(transaction);
        }
      } as unknown as EditorView,
      new KeyboardEvent("keydown", { key: "Delete" })
    );

    expect(handled).toBe(true);
    expect(docToParts(nextState?.doc ?? cursorBeforeResourceState.doc)).toEqual([
      { type: "text", value: "看这张" }
    ]);
  });

  it("ArrowRight 在 resource part 前面时跳到 part 后面", () => {
    const plugin = createInlineAtomArrowNavigationPlugin({ nodeNames: ["resource_part"] });
    const state = createState([{ type: "text", value: "看" }, resourcePart("a.png"), { type: "text", value: "这张" }]);
    const resourcePosition = findFirstResourcePosition(state);
    const cursorBeforeResourceState = state.apply(state.tr.setSelection(TextSelection.create(state.doc, resourcePosition)));
    let nextState: EditorState | undefined;

    const handled = handleArrowKeyDown(
      plugin,
      {
        state: cursorBeforeResourceState,
        dispatch: (transaction: Transaction) => {
          nextState = cursorBeforeResourceState.apply(transaction);
        }
      } as unknown as EditorView,
      new KeyboardEvent("keydown", { key: "ArrowRight" })
    );

    expect(handled).toBe(true);
    expect(nextState?.selection.from).toBe(resourcePosition + 1);
  });

  it("ArrowLeft 在 resource part 后面时跳到 part 前面", () => {
    const plugin = createInlineAtomArrowNavigationPlugin({ nodeNames: ["resource_part"] });
    const state = createState([{ type: "text", value: "看" }, resourcePart("a.png"), { type: "text", value: "这张" }]);
    const resourcePosition = findFirstResourcePosition(state);
    const cursorAfterResourceState = state.apply(state.tr.setSelection(TextSelection.create(state.doc, resourcePosition + 1)));
    let nextState: EditorState | undefined;

    const handled = handleArrowKeyDown(
      plugin,
      {
        state: cursorAfterResourceState,
        dispatch: (transaction: Transaction) => {
          nextState = cursorAfterResourceState.apply(transaction);
        }
      } as unknown as EditorView,
      new KeyboardEvent("keydown", { key: "ArrowLeft" })
    );

    expect(handled).toBe(true);
    expect(nextState?.selection.from).toBe(resourcePosition);
  });

  it("NodeSelection 选中 resource part 时方向键会收敛到 part 两侧", () => {
    const plugin = createInlineAtomArrowNavigationPlugin({ nodeNames: ["resource_part"] });
    const state = createState([{ type: "text", value: "看" }, resourcePart("a.png"), { type: "text", value: "这张" }]);
    const resourcePosition = findFirstResourcePosition(state);
    const selectedResourceState = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, resourcePosition)));
    let nextState: EditorState | undefined;

    const handled = handleArrowKeyDown(
      plugin,
      {
        state: selectedResourceState,
        dispatch: (transaction: Transaction) => {
          nextState = selectedResourceState.apply(transaction);
        }
      } as unknown as EditorView,
      new KeyboardEvent("keydown", { key: "ArrowRight" })
    );

    expect(handled).toBe(true);
    expect(nextState?.selection).toBeInstanceOf(TextSelection);
    expect(nextState?.selection.from).toBe(resourcePosition + 1);
  });

  it("拖选范围经过 resource part 时会给 part 添加选中态 class", () => {
    const plugin = createInlineAtomSelectionHighlightPlugin({ nodeNames: ["resource_part"] });
    const baseState = createState([{ type: "text", value: "看" }, resourcePart("a.png"), { type: "text", value: "这张" }]);
    const resourcePosition = findFirstResourcePosition(baseState);
    const selectedState = baseState.apply(
      baseState.tr.setSelection(TextSelection.create(baseState.doc, resourcePosition, resourcePosition + 1))
    );

    const decorations = getPluginDecorations(plugin, selectedState);

    expect(decorations?.find()).toHaveLength(1);
    expect((decorations?.find()[0] as any)?.type.attrs.class).toContain("is-range-selected");
  });

  it("浏览器 DOM 选区经过 resource part 时会同步保持 part 选中态", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema: partSchema,
        doc: partsToDoc([{ type: "text", value: "看" }, resourcePart("a.png"), { type: "text", value: "这张" }]),
        plugins: [createInlineAtomSelectionHighlightPlugin({ nodeNames: ["resource_part"] })]
      })
    });
    const paragraph = view.dom.querySelector("p");
    const resourceElement = view.dom.querySelector(".pm-part--resource");
    const firstTextNode = paragraph?.firstChild;

    expect(resourceElement).toBeInstanceOf(HTMLElement);
    expect(firstTextNode).toBeInstanceOf(Text);

    const range = document.createRange();
    range.setStart(firstTextNode as Text, 0);
    range.setEndAfter(resourceElement as HTMLElement);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    document.dispatchEvent(new Event("selectionchange"));

    expect(resourceElement).toHaveClass("is-range-selected");

    selection?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));

    expect(resourceElement).not.toHaveClass("is-range-selected");

    view.destroy();
    host.remove();
  });

  it("点击编辑器外部会把非空选区收敛到光标，避免 resource part 高亮残留", () => {
    const host = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(host, outside);
    const doc = partsToDoc([{ type: "text", value: "看" }, resourcePart("a.png"), { type: "text", value: "这张" }]);
    const baseState = EditorState.create({ schema: partSchema, doc });
    const resourcePosition = findFirstResourcePosition(baseState);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema: partSchema,
        doc,
        selection: TextSelection.create(doc, resourcePosition, resourcePosition + 1),
        plugins: [createClearSelectionOnOutsidePointerPlugin()]
      })
    });

    expect(view.state.selection.empty).toBe(false);

    fireEvent.click(outside);

    expect(view.state.selection.empty).toBe(true);
    expect(view.state.selection.from).toBe(resourcePosition + 1);

    view.destroy();
    host.remove();
    outside.remove();
  });

  it("全选后粘贴纯文本时不会保留额外换行", () => {
    const plugin = createPlainTextPastePlugin();
    const state = createState([{ type: "text", value: "旧" }, resourcePart("a.png"), { type: "text", value: "内容" }]);
    const selectedState = state.apply(state.tr.setSelection(new AllSelection(state.doc)));
    let nextState: EditorState | undefined;
    const event = createPasteEvent({ text: "新内容" });

    const handled = handlePaste(
      plugin,
      {
        state: selectedState,
        dispatch: (transaction: Transaction) => {
          nextState = selectedState.apply(transaction);
        }
      } as unknown as EditorView,
      event
    );

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(docToParts(nextState?.doc ?? selectedState.doc)).toEqual([{ type: "text", value: "新内容" }]);
  });

  it("粘贴 agent message parts 剪贴板时会还原 resource part，而不是粘成文件名文本", () => {
    const plugin = createPlainTextPastePlugin();
    const pastedParts = [{ type: "text" as const, value: "看这个 " }, resourcePart("a.png"), { type: "text" as const, value: " 继续" }];
    const state = createState([{ type: "text", value: "" }]);
    let nextState: EditorState | undefined;
    const event = createPasteEvent({
      text: "看这个  继续",
      types: [AGENT_MESSAGE_PARTS_MIME, "text/plain"],
      data: {
        [AGENT_MESSAGE_PARTS_MIME]: serializeMessagePartsForClipboard(pastedParts)
      }
    });

    const handled = handlePaste(
      plugin,
      {
        state,
        dispatch: (transaction: Transaction) => {
          nextState = state.apply(transaction);
        }
      } as unknown as EditorView,
      event
    );

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(docToParts(nextState?.doc ?? state.doc)).toEqual(pastedParts);
  });

  it("粘贴纯文本时会归一化 CRLF，但不额外制造段落", () => {
    const plugin = createPlainTextPastePlugin();
    const state = createState([{ type: "text", value: "" }]);
    let nextState: EditorState | undefined;
    const event = createPasteEvent({ text: "第一行\r\n第二行" });

    const handled = handlePaste(
      plugin,
      {
        state,
        dispatch: (transaction: Transaction) => {
          nextState = state.apply(transaction);
        }
      } as unknown as EditorView,
      event
    );

    expect(handled).toBe(true);
    expect(docToParts(nextState?.doc ?? state.doc)).toEqual([{ type: "text", value: "第一行\n第二行" }]);
  });
});
