import { forwardRef, useEffect, useImperativeHandle, useRef, type MutableRefObject } from "react";
import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { docToParts, partsToDoc, stripRuntimeFields, type RuntimePart } from "../prosemirror/part-serialization";
import { partSchema } from "../prosemirror/part-schema";
import {
  createAtomicMediaDeletePlugin,
  createClearSelectionOnOutsidePointerPlugin,
  createDropSelectionPlugin,
  createImageUploadEntryPlugin,
  createInlineAtomSelectionHighlightPlugin,
  createInlineAtomArrowNavigationPlugin,
  createInlineBoundaryCaretPlugin,
  createPlainTextPastePlugin,
  dropCursor
} from "../prosemirror/plugins/part-editor-plugins";

interface PartComposerProps {
  parts: RuntimePart[];
  disabled?: boolean;
  focusToken?: number;
  onChange: (parts: RuntimePart[]) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onUploadImage?: (file: File) => Promise<RuntimePart>;
}

export interface PartComposerHandle {
  openImagePicker: () => void;
}

interface ReplacementRange {
  from: number;
  to: number;
}

export const PartComposer = forwardRef<PartComposerHandle, PartComposerProps>(function PartComposer(
  { parts, disabled = false, focusToken = 0, onChange, onSubmit, onCancel, onUploadImage },
  ref
) {
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onCancelRef = useRef(onCancel);
  const onUploadImageRef = useRef(onUploadImage);
  const disabledRef = useRef(disabled);
  const pendingReplacementRangeRef = useRef<ReplacementRange>();

  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;
  onCancelRef.current = onCancel;
  onUploadImageRef.current = onUploadImage;
  disabledRef.current = disabled;

  // 回调和 disabled 都放到 ref 里，是为了让 ProseMirror 插件始终读到最新值。
  // EditorView 只初始化一次，如果直接闭包捕获 props，很容易拿到旧的 onSubmit/onUploadImage。
  useImperativeHandle(ref, () => ({
    openImagePicker: () => {
      pendingReplacementRangeRef.current = undefined;
      imageInputRef.current?.click();
    }
  }));

  useEffect(() => {
    if (!editorRootRef.current || viewRef.current) {
      return;
    }

    const view = new EditorView(editorRootRef.current, {
      state: createEditorState({
        parts,
        onSubmitRef,
        onCancelRef,
        onUploadImageRef,
        imageInputRef,
        pendingReplacementRangeRef
      }),
      editable: () => !disabledRef.current,
      attributes: {
        role: "textbox",
        "aria-label": "发消息",
        placeholder: "发消息...",
        class: "part-composer-editor"
      },
      dispatchTransaction(transaction) {
        // ProseMirror 自己维护 doc/selection；React 只保存序列化后的 parts。
        // 每个事务先更新 EditorView，再把 doc 转回 MessagePart 通知外层。
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        updateEmptyClass(view);
        onChangeRef.current(docToParts(nextState.doc) as RuntimePart[]);
      }
    });

    viewRef.current = view;
    updateEmptyClass(view);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;

    if (!view) {
      return;
    }

    const currentParts = JSON.stringify(docToParts(view.state.doc));
    const nextParts = JSON.stringify(stripRuntimeFields(parts));

    // 外层可能因为“引用图片/选择建议/发送后清空”主动改 parts。
    // 如果编辑器内容已经一致，就不要重建 EditorState，避免光标跳到末尾。
    if (currentParts === nextParts) {
      return;
    }

    view.updateState(createEditorState({
      parts,
      onSubmitRef,
      onCancelRef,
      onUploadImageRef,
      imageInputRef,
      pendingReplacementRangeRef
    }));
    updateEmptyClass(view);
  }, [parts]);

  useEffect(() => {
    viewRef.current?.setProps({ editable: () => !disabledRef.current });
  }, [disabled]);

  useEffect(() => {
    if (focusToken > 0) {
      viewRef.current?.focus();
    }
  }, [focusToken]);

  async function handleImageInputChange() {
    const file = imageInputRef.current?.files?.[0];

    if (!file) {
      return;
    }

    await uploadAndInsertImage(file, viewRef, onUploadImageRef, pendingReplacementRangeRef.current);
    pendingReplacementRangeRef.current = undefined;

    if (imageInputRef.current) {
      imageInputRef.current.value = "";
    }
  }

  return (
    <div className="part-composer">
      <div ref={editorRootRef} />
      <input
        ref={imageInputRef}
        aria-label="选择图片"
        accept="image/*"
        className="part-composer-image-input"
        type="file"
        onChange={() => {
          void handleImageInputChange();
        }}
      />
    </div>
  );
});

function createEditorState(input: {
  parts: RuntimePart[];
  onSubmitRef: MutableRefObject<() => void>;
  onCancelRef: MutableRefObject<() => void>;
  onUploadImageRef: MutableRefObject<((file: File) => Promise<RuntimePart>) | undefined>;
  imageInputRef: MutableRefObject<HTMLInputElement | null>;
  pendingReplacementRangeRef: MutableRefObject<ReplacementRange | undefined>;
}) {
  const doc = partsToDoc(input.parts);

  // 一个消息编辑器里同时混有普通文本和媒体 atom。
  // 文本走 ProseMirror 默认编辑能力，媒体通过自定义插件处理上传、删除、选择和方向键导航。
  return EditorState.create({
    schema: partSchema,
    doc,
    selection: TextSelection.atEnd(doc),
    plugins: [
      history(),
      keymap({
        Enter: () => {
          input.onSubmitRef.current();
          return true;
        },
        "Shift-Enter": insertHardBreak,
        "Mod-z": undo,
        "Mod-y": redo,
        "Mod-Shift-z": redo,
        Escape: () => {
          input.onCancelRef.current();
          return true;
        }
      }),
      dropCursor({
        color: "#247a73",
        width: 2
      }),
      createImageUploadEntryPlugin({
        onImageFile: (view, file) => {
          void uploadAndInsertImage(file, { current: view }, input.onUploadImageRef);
        }
      }),
      createPlainTextPastePlugin(),
      new Plugin({
        props: {
          handleDOMEvents: {
            mousedown(view, event) {
              const removeButton = closestMediaRemoveButtonElement(event.target);

              if (removeButton) {
                event.preventDefault();
                return true;
              }

              if (event.target !== view.dom) {
                return false;
              }

              event.preventDefault();
              view.focus();
              moveSelectionToEndWhenAtDocumentStart(view);
              return true;
            },
            focus(view) {
              moveSelectionToEndWhenAtDocumentStart(view);
              return false;
            },
            click(view, event) {
              const removeButton = closestMediaRemoveButtonElement(event.target);

              if (removeButton) {
                event.preventDefault();
                deleteMediaPartFromRemoveButton(view, removeButton);
                return true;
              }

              const target = closestMediaPartElement(event.target);

              if (!(target instanceof HTMLElement)) {
                if (event.target === view.dom) {
                  moveSelectionToEndWhenAtDocumentStart(view);
                }

                return false;
              }

              const replacementRange = findMediaReplacementRange(view, target);
              input.pendingReplacementRangeRef.current = replacementRange;
              clearMediaClickSelection(view, replacementRange);

              if (isVideoMediaElement(target)) {
                event.preventDefault();
                return true;
              }

              input.imageInputRef.current?.click();
              event.preventDefault();
              return true;
            }
          }
        }
      }),
      createInlineBoundaryCaretPlugin({ beforeNodeNames: ["media_part"] }),
      createInlineAtomSelectionHighlightPlugin({ nodeNames: ["media_part"] }),
      createClearSelectionOnOutsidePointerPlugin(),
      createDropSelectionPlugin(),
      createAtomicMediaDeletePlugin({ nodeNames: ["media_part"] }),
      createInlineAtomArrowNavigationPlugin({ nodeNames: ["media_part"] }),
      keymap(baseKeymap)
    ]
  });
}

async function uploadAndInsertImage(
  file: File,
  viewRef: MutableRefObject<EditorView | null>,
  onUploadImageRef: MutableRefObject<((file: File) => Promise<RuntimePart>) | undefined>,
  replacementRange?: ReplacementRange
) {
  const view = viewRef.current;
  const onUploadImage = onUploadImageRef.current;

  if (!view || !onUploadImage || !file.type.startsWith("image/")) {
    return;
  }

  const part = await onUploadImage(file);
  if (part.type !== "media") {
    return;
  }

  // 点击已有图片会记录 replacementRange，此时上传完成后替换旧媒体；
  // 直接粘贴/拖拽/选择文件则插入到当前光标位置。
  const node = partSchema.nodes.media_part.create({
    mime: part.mime ?? "",
    url: part.url ?? "",
    name: part.name ?? "",
    size: part.size ?? null
  });
  const transaction = replacementRange
    ? view.state.tr.replaceWith(replacementRange.from, replacementRange.to, node)
    : view.state.tr.replaceSelectionWith(node);

  view.dispatch(transaction.scrollIntoView());
  updateEmptyClass(view);
  view.focus();
}

function closestMediaPartElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof Element) {
    return target.closest(".pm-part--media") as HTMLElement | null;
  }

  if (target instanceof Text) {
    return target.parentElement?.closest(".pm-part--media") as HTMLElement | null;
  }

  return null;
}

function isVideoMediaElement(element: HTMLElement) {
  return element.dataset.mime?.startsWith("video/") ?? false;
}

function closestMediaRemoveButtonElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof Element) {
    return target.closest(".pm-part-media-remove") as HTMLElement | null;
  }

  if (target instanceof Text) {
    return target.parentElement?.closest(".pm-part-media-remove") as HTMLElement | null;
  }

  return null;
}

function deleteMediaPartFromRemoveButton(view: EditorView, button: HTMLElement) {
  const mediaElement = button.closest(".pm-part--media");

  if (!(mediaElement instanceof HTMLElement)) {
    return;
  }

  const range = findMediaReplacementRange(view, mediaElement);

  if (!range) {
    return;
  }

  view.dispatch(view.state.tr.delete(range.from, range.to).scrollIntoView());
  updateEmptyClass(view);
  view.focus();
}

function moveSelectionToEndWhenAtDocumentStart(view: EditorView) {
  const selection = view.state.selection;

  if (!selection.empty || selection.from !== 1) {
    return;
  }

  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
}

function findMediaReplacementRange(view: EditorView, element: HTMLElement): ReplacementRange | undefined {
  // ProseMirror 的 posAtDOM 对 atom 节点有时会落在节点前后边界。
  // 同时检查当前位置和前一位，能稳定找到 media_part 的真实范围。
  const candidatePositions = [view.posAtDOM(element, 0), Math.max(0, view.posAtDOM(element, 0) - 1)];

  for (const from of candidatePositions) {
    const node = view.state.doc.nodeAt(from);

    if (node?.type.name === "media_part") {
      return { from, to: from + node.nodeSize };
    }
  }

  return undefined;
}

function clearMediaClickSelection(view: EditorView, replacementRange?: ReplacementRange) {
  if (!replacementRange) {
    return;
  }

  const position = Math.min(replacementRange.to, view.state.doc.content.size);
  const selection = TextSelection.near(view.state.doc.resolve(position), 1);

  if (view.state.selection.eq(selection)) {
    return;
  }

  view.dispatch(
    view.state.tr
      .setSelection(selection)
      .setMeta("addToHistory", false)
      .setMeta("actionType", "media.click.clear-selection")
  );
}

const insertHardBreak: Command = (state, dispatch) => {
  if (!dispatch) {
    return true;
  }

  const hardBreak = partSchema.nodes.hard_break.create();
  const transaction = state.tr.replaceSelectionWith(hardBreak).scrollIntoView();
  const nextSelection = TextSelection.near(transaction.doc.resolve(transaction.selection.from));
  dispatch(transaction.setSelection(nextSelection));
  return true;
};

function updateEmptyClass(view: EditorView) {
  const parts = docToParts(view.state.doc);
  const isEmpty = parts.every((part) => part.type === "text" && part.value.trim().length === 0);
  view.dom.classList.toggle("is-empty", parts.length === 0 || isEmpty);
}
