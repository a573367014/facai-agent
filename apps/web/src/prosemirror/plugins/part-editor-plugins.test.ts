import { describe, expect, it } from "vitest";
import { AllSelection, EditorState, NodeSelection, TextSelection, type Transaction } from "prosemirror-state";
import type { DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import { partSchema } from "../part-schema";
import { docToParts, partsToDoc, type RuntimePart } from "../part-serialization";
import {
  createAtomicMediaDeletePlugin,
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

function handlePluginKeyDown(plugin: ReturnType<typeof createAtomicMediaDeletePlugin>, view: EditorView, event: KeyboardEvent) {
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

function createPasteEvent(input: { text: string; html?: string; types?: string[]; files?: File[] }) {
  const event = new Event("paste", { cancelable: true }) as ClipboardEvent;
  const clipboardData = {
    files: input.files ?? [],
    types: input.types ?? ["text/plain"],
    getData: (type: string) => {
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

function mediaPart(name: string): RuntimePart {
  return {
    type: "media",
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

function findFirstMediaPosition(state: EditorState) {
  let found: number | undefined;

  state.doc.descendants((node, pos) => {
    if (typeof found !== "number" && node.type.name === "media_part") {
      found = pos;
      return false;
    }

    return true;
  });

  if (typeof found !== "number") {
    throw new Error("未找到 media_part");
  }

  return found;
}

describe("part editor plugins", () => {
  it("在两个 inline atom 中间补充边界光标锚点", () => {
    const plugin = createInlineBoundaryCaretPlugin({ beforeNodeNames: ["media_part"] });
    const baseState = createState([mediaPart("a.png"), mediaPart("b.png")]);
    const firstMediaPosition = findFirstMediaPosition(baseState);
    const state = createState([mediaPart("a.png"), mediaPart("b.png")], firstMediaPosition + 1);

    const decorations = getPluginDecorations(plugin, state);

    expect(decorations?.find()).toHaveLength(1);
  });

  it("media part 后面是文本时不插入额外边界光标锚点", () => {
    const plugin = createInlineBoundaryCaretPlugin({ beforeNodeNames: ["media_part"] });
    const baseState = createState([mediaPart("a.png"), { type: "text", value: "继续" }]);
    const firstMediaPosition = findFirstMediaPosition(baseState);
    const state = createState([mediaPart("a.png"), { type: "text", value: "继续" }], firstMediaPosition + 1);

    const decorations = getPluginDecorations(plugin, state);

    expect(decorations?.find()).toHaveLength(0);
  });

  it("drop 后如果残留 NodeSelection，会把光标收敛到节点后方", () => {
    const plugin = createDropSelectionPlugin();
    const oldState = createState([{ type: "text", value: "看" }, mediaPart("a.png"), { type: "text", value: "这张" }]);
    const mediaPosition = findFirstMediaPosition(oldState);
    const dropTransaction = oldState.tr.setSelection(NodeSelection.create(oldState.doc, mediaPosition)).setMeta("uiEvent", "drop");
    const newState = oldState.apply(dropTransaction);

    const appended = plugin.spec.appendTransaction?.([dropTransaction], oldState, newState);

    expect(appended?.selection).toBeInstanceOf(TextSelection);
    expect(appended?.selection.from).toBe(mediaPosition + 1);
  });

  it("Backspace 会删除光标前面的 media part", () => {
    const plugin = createAtomicMediaDeletePlugin({ nodeNames: ["media_part"] });
    const state = createState([{ type: "text", value: "看" }, mediaPart("a.png"), { type: "text", value: "这张" }]);
    const mediaPosition = findFirstMediaPosition(state);
    const cursorAfterMediaState = state.apply(state.tr.setSelection(TextSelection.create(state.doc, mediaPosition + 1)));
    let nextState: EditorState | undefined;

    const handled = handlePluginKeyDown(
      plugin,
      {
        state: cursorAfterMediaState,
        dispatch: (transaction: Transaction) => {
          nextState = cursorAfterMediaState.apply(transaction);
        }
      } as unknown as EditorView,
      new KeyboardEvent("keydown", { key: "Backspace" })
    );

    expect(handled).toBe(true);
    expect(docToParts(nextState?.doc ?? cursorAfterMediaState.doc)).toEqual([
      { type: "text", value: "看这张" }
    ]);
  });

  it("Delete 会删除光标后面的 media part", () => {
    const plugin = createAtomicMediaDeletePlugin({ nodeNames: ["media_part"] });
    const state = createState([{ type: "text", value: "看" }, mediaPart("a.png"), { type: "text", value: "这张" }]);
    const mediaPosition = findFirstMediaPosition(state);
    const cursorBeforeMediaState = state.apply(state.tr.setSelection(TextSelection.create(state.doc, mediaPosition)));
    let nextState: EditorState | undefined;

    const handled = handlePluginKeyDown(
      plugin,
      {
        state: cursorBeforeMediaState,
        dispatch: (transaction: Transaction) => {
          nextState = cursorBeforeMediaState.apply(transaction);
        }
      } as unknown as EditorView,
      new KeyboardEvent("keydown", { key: "Delete" })
    );

    expect(handled).toBe(true);
    expect(docToParts(nextState?.doc ?? cursorBeforeMediaState.doc)).toEqual([
      { type: "text", value: "看这张" }
    ]);
  });

  it("ArrowRight 在 media part 前面时跳到 part 后面", () => {
    const plugin = createInlineAtomArrowNavigationPlugin({ nodeNames: ["media_part"] });
    const state = createState([{ type: "text", value: "看" }, mediaPart("a.png"), { type: "text", value: "这张" }]);
    const mediaPosition = findFirstMediaPosition(state);
    const cursorBeforeMediaState = state.apply(state.tr.setSelection(TextSelection.create(state.doc, mediaPosition)));
    let nextState: EditorState | undefined;

    const handled = handleArrowKeyDown(
      plugin,
      {
        state: cursorBeforeMediaState,
        dispatch: (transaction: Transaction) => {
          nextState = cursorBeforeMediaState.apply(transaction);
        }
      } as unknown as EditorView,
      new KeyboardEvent("keydown", { key: "ArrowRight" })
    );

    expect(handled).toBe(true);
    expect(nextState?.selection.from).toBe(mediaPosition + 1);
  });

  it("ArrowLeft 在 media part 后面时跳到 part 前面", () => {
    const plugin = createInlineAtomArrowNavigationPlugin({ nodeNames: ["media_part"] });
    const state = createState([{ type: "text", value: "看" }, mediaPart("a.png"), { type: "text", value: "这张" }]);
    const mediaPosition = findFirstMediaPosition(state);
    const cursorAfterMediaState = state.apply(state.tr.setSelection(TextSelection.create(state.doc, mediaPosition + 1)));
    let nextState: EditorState | undefined;

    const handled = handleArrowKeyDown(
      plugin,
      {
        state: cursorAfterMediaState,
        dispatch: (transaction: Transaction) => {
          nextState = cursorAfterMediaState.apply(transaction);
        }
      } as unknown as EditorView,
      new KeyboardEvent("keydown", { key: "ArrowLeft" })
    );

    expect(handled).toBe(true);
    expect(nextState?.selection.from).toBe(mediaPosition);
  });

  it("NodeSelection 选中 media part 时方向键会收敛到 part 两侧", () => {
    const plugin = createInlineAtomArrowNavigationPlugin({ nodeNames: ["media_part"] });
    const state = createState([{ type: "text", value: "看" }, mediaPart("a.png"), { type: "text", value: "这张" }]);
    const mediaPosition = findFirstMediaPosition(state);
    const selectedMediaState = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, mediaPosition)));
    let nextState: EditorState | undefined;

    const handled = handleArrowKeyDown(
      plugin,
      {
        state: selectedMediaState,
        dispatch: (transaction: Transaction) => {
          nextState = selectedMediaState.apply(transaction);
        }
      } as unknown as EditorView,
      new KeyboardEvent("keydown", { key: "ArrowRight" })
    );

    expect(handled).toBe(true);
    expect(nextState?.selection).toBeInstanceOf(TextSelection);
    expect(nextState?.selection.from).toBe(mediaPosition + 1);
  });

  it("拖选范围经过 media part 时会给 part 添加选中态 class", () => {
    const plugin = createInlineAtomSelectionHighlightPlugin({ nodeNames: ["media_part"] });
    const baseState = createState([{ type: "text", value: "看" }, mediaPart("a.png"), { type: "text", value: "这张" }]);
    const mediaPosition = findFirstMediaPosition(baseState);
    const selectedState = baseState.apply(
      baseState.tr.setSelection(TextSelection.create(baseState.doc, mediaPosition, mediaPosition + 1))
    );

    const decorations = getPluginDecorations(plugin, selectedState);

    expect(decorations?.find()).toHaveLength(1);
    expect((decorations?.find()[0] as any)?.type.attrs.class).toContain("is-range-selected");
  });

  it("全选后粘贴纯文本时不会保留额外换行", () => {
    const plugin = createPlainTextPastePlugin();
    const state = createState([{ type: "text", value: "旧" }, mediaPart("a.png"), { type: "text", value: "内容" }]);
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
