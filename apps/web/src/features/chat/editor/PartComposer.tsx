import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MutableRefObject } from "react";
import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { docToParts, partsToDoc, stripRuntimeFields, type RuntimePart } from "./prosemirror/part-serialization";
import { partSchema } from "./prosemirror/part-schema";
import {
  createAtomicResourceDeletePlugin,
  createAttachmentUploadEntryPlugin,
  createClearSelectionOnOutsidePointerPlugin,
  createDropSelectionPlugin,
  createInlineAtomSelectionHighlightPlugin,
  createInlineAtomArrowNavigationPlugin,
  createInlineBoundaryCaretPlugin,
  createPlainTextPastePlugin,
  dropCursor
} from "./prosemirror/plugins/part-editor-plugins";
import {
  getAttachmentUploadKind,
  getAttachmentValidationMessage,
  getAttachmentSizeValidationMessage,
  type AttachmentUploadKind
} from "@/features/resources/lib/attachment-upload";
import { ResourcePreviewDialog, type ResourcePreviewItem } from "@/features/resources/components/ResourcePreviewDialog";

interface PartComposerProps {
  parts: RuntimePart[];
  disabled?: boolean;
  focusToken?: number;
  onChange: (parts: RuntimePart[]) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onUploadResource?: (file: File) => Promise<RuntimePart>;
  onUploadImage?: (file: File) => Promise<RuntimePart>;
  onUploadDocument?: (file: File) => Promise<RuntimePart>;
  onUploadError?: (message: string | null) => void;
}

export interface PartComposerHandle {
  openResourcePicker: () => void;
  openImagePicker: () => void;
  openDocumentPicker: () => void;
}

interface ReplacementRange {
  from: number;
  to: number;
}

type RuntimeResourcePart = Extract<RuntimePart, { type: "resource" }> & {
  $uploading?: unknown;
  $uploadId?: unknown;
};

type UploadTaskRecord =
  | { status: "pending"; previousNode?: ProseMirrorNode }
  | { status: "completed"; part: RuntimeResourcePart; previousNode?: ProseMirrorNode }
  | { status: "failed"; previousNode?: ProseMirrorNode };

type UploadTaskRegistry = Map<string, UploadTaskRecord>;

let uploadSequence = 0;

export const PartComposer = forwardRef<PartComposerHandle, PartComposerProps>(function PartComposer(
  {
    parts,
    disabled = false,
    focusToken = 0,
    onChange,
    onSubmit,
    onCancel,
    onUploadResource,
    onUploadImage,
    onUploadDocument,
    onUploadError
  },
  ref
) {
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const documentInputRef = useRef<HTMLInputElement | null>(null);
  const resourceInputRef = useRef<HTMLInputElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onCancelRef = useRef(onCancel);
  const onUploadImageRef = useRef(onUploadImage);
  const onUploadDocumentRef = useRef(onUploadDocument);
  const onUploadResourceRef = useRef(onUploadResource);
  const onUploadErrorRef = useRef(onUploadError);
  const disabledRef = useRef(disabled);
  const pendingReplacementRangeRef = useRef<ReplacementRange>();
  const previewReplacementRangeRef = useRef<ReplacementRange>();
  const uploadTasksRef = useRef<UploadTaskRegistry>(new Map());
  const onPreviewResourceRef = useRef<(item: ResourcePreviewItem, replacementRange?: ReplacementRange) => void>(() => undefined);
  const [previewResource, setPreviewResource] = useState<ResourcePreviewItem>();

  onPreviewResourceRef.current = (item, replacementRange) => {
    previewReplacementRangeRef.current = replacementRange;
    setPreviewResource(item);
  };

  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;
  onCancelRef.current = onCancel;
  onUploadImageRef.current = onUploadImage;
  onUploadDocumentRef.current = onUploadDocument;
  onUploadResourceRef.current = onUploadResource;
  onUploadErrorRef.current = onUploadError;
  disabledRef.current = disabled;

  // 回调和 disabled 都放到 ref 里，是为了让 ProseMirror 插件始终读到最新值。
  // EditorView 只初始化一次，如果直接闭包捕获 props，很容易拿到旧的 onSubmit/onUploadImage。
  useImperativeHandle(ref, () => ({
    openResourcePicker: () => {
      pendingReplacementRangeRef.current = undefined;
      resourceInputRef.current?.click();
    },
    openImagePicker: () => {
      pendingReplacementRangeRef.current = undefined;
      imageInputRef.current?.click();
    },
    openDocumentPicker: () => {
      pendingReplacementRangeRef.current = undefined;
      documentInputRef.current?.click();
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
        onUploadDocumentRef,
        onUploadResourceRef,
        onUploadErrorRef,
        imageInputRef,
        documentInputRef,
        resourceInputRef,
        onPreviewResourceRef,
        pendingReplacementRangeRef,
        uploadTasksRef
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
      onUploadDocumentRef,
      onUploadResourceRef,
      onUploadErrorRef,
      imageInputRef,
      documentInputRef,
      resourceInputRef,
      onPreviewResourceRef,
      pendingReplacementRangeRef,
      uploadTasksRef
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

    await uploadAndInsertAttachment(
      file,
      viewRef,
      { onUploadImageRef, onUploadDocumentRef, onUploadResourceRef, onUploadErrorRef },
      uploadTasksRef.current,
      "image",
      pendingReplacementRangeRef.current
    );
    pendingReplacementRangeRef.current = undefined;

    if (imageInputRef.current) {
      imageInputRef.current.value = "";
    }
  }

  async function handleDocumentInputChange() {
    const file = documentInputRef.current?.files?.[0];

    if (!file) {
      return;
    }

    await uploadAndInsertAttachment(
      file,
      viewRef,
      { onUploadImageRef, onUploadDocumentRef, onUploadResourceRef, onUploadErrorRef },
      uploadTasksRef.current,
      "document"
    );

    if (documentInputRef.current) {
      documentInputRef.current.value = "";
    }
  }

  async function handleResourceInputChange() {
    const file = resourceInputRef.current?.files?.[0];

    if (!file) {
      return;
    }

    await uploadAndInsertAttachment(
      file,
      viewRef,
      { onUploadImageRef, onUploadDocumentRef, onUploadResourceRef, onUploadErrorRef },
      uploadTasksRef.current,
      undefined,
      pendingReplacementRangeRef.current
    );
    pendingReplacementRangeRef.current = undefined;

    if (resourceInputRef.current) {
      resourceInputRef.current.value = "";
    }
  }

  return (
    <div className="part-composer">
      <div ref={editorRootRef} />
      <input
        ref={resourceInputRef}
        aria-label="选择资源"
        className="part-composer-image-input"
        type="file"
        onChange={() => {
          void handleResourceInputChange();
        }}
      />
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
      <input
        ref={documentInputRef}
        aria-label="选择文档"
        accept=".txt,.md,.markdown,.doc,.docx,text/plain,text/markdown,application/markdown,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="part-composer-image-input"
        type="file"
        onChange={() => {
          void handleDocumentInputChange();
        }}
      />
      <ResourcePreviewDialog
        item={previewResource}
        onReplace={() => {
          const replacementRange = previewReplacementRangeRef.current;
          setPreviewResource(undefined);
          previewReplacementRangeRef.current = undefined;

          if (replacementRange) {
            pendingReplacementRangeRef.current = replacementRange;
            resourceInputRef.current?.click();
          }
        }}
        onClose={() => {
          previewReplacementRangeRef.current = undefined;
          setPreviewResource(undefined);
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
  onUploadDocumentRef: MutableRefObject<((file: File) => Promise<RuntimePart>) | undefined>;
  onUploadResourceRef: MutableRefObject<((file: File) => Promise<RuntimePart>) | undefined>;
  onUploadErrorRef: MutableRefObject<((message: string | null) => void) | undefined>;
  imageInputRef: MutableRefObject<HTMLInputElement | null>;
  documentInputRef: MutableRefObject<HTMLInputElement | null>;
  resourceInputRef: MutableRefObject<HTMLInputElement | null>;
  onPreviewResourceRef: MutableRefObject<(item: ResourcePreviewItem, replacementRange?: ReplacementRange) => void>;
  pendingReplacementRangeRef: MutableRefObject<ReplacementRange | undefined>;
  uploadTasksRef: MutableRefObject<UploadTaskRegistry>;
}) {
  const doc = partsToDoc(input.parts);

  // 一个消息编辑器里同时混有普通文本和 resource atom。
  // 文本走 ProseMirror 默认编辑能力，resource 通过自定义插件处理上传、删除、选择和方向键导航。
  return EditorState.create({
    schema: partSchema,
    doc,
    selection: TextSelection.atEnd(doc),
    plugins: [
      history(),
      createUploadTaskReconciliationPlugin(input.uploadTasksRef),
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
      createAttachmentUploadEntryPlugin({
        onAttachmentFile: (view, file) => {
          void uploadAndInsertAttachment(file, { current: view }, {
            onUploadImageRef: input.onUploadImageRef,
            onUploadDocumentRef: input.onUploadDocumentRef,
            onUploadResourceRef: input.onUploadResourceRef,
            onUploadErrorRef: input.onUploadErrorRef
          }, input.uploadTasksRef.current);
        }
      }),
      createPlainTextPastePlugin(),
      new Plugin({
        props: {
          handleDOMEvents: {
            mousedown(view, event) {
              const replaceButton = closestResourceReplaceButtonElement(event.target);

              if (replaceButton) {
                event.preventDefault();
                return true;
              }

              const removeButton = closestResourceRemoveButtonElement(event.target);

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
              const replaceButton = closestResourceReplaceButtonElement(event.target);

              if (replaceButton) {
                event.preventDefault();
                replaceResourcePartFromReplaceButton(view, replaceButton, input);
                return true;
              }

              const removeButton = closestResourceRemoveButtonElement(event.target);

              if (removeButton) {
                event.preventDefault();
                deleteResourcePartFromRemoveButton(view, removeButton);
                return true;
              }

              const target = closestResourcePartElement(event.target);

              if (!(target instanceof HTMLElement)) {
                if (event.target === view.dom) {
                  moveSelectionToEndWhenAtDocumentStart(view);
                }

                return false;
              }

              const replacementRange = findResourceReplacementRange(view, target);
              input.pendingReplacementRangeRef.current = undefined;
              clearResourceClickSelection(view, replacementRange);
              const url = target.dataset.url?.trim();

              if (url) {
                input.onPreviewResourceRef.current({
                  url,
                  mime: target.dataset.mime ?? undefined,
                  prompt: target.dataset.name ?? undefined
                }, replacementRange);
              }
              event.preventDefault();
              return true;
            }
          }
        }
      }),
      createInlineBoundaryCaretPlugin({ beforeNodeNames: ["resource_part"] }),
      createInlineAtomSelectionHighlightPlugin({ nodeNames: ["resource_part"] }),
      createClearSelectionOnOutsidePointerPlugin(),
      createDropSelectionPlugin(),
      createAtomicResourceDeletePlugin({ nodeNames: ["resource_part"] }),
      createInlineAtomArrowNavigationPlugin({ nodeNames: ["resource_part"] }),
      keymap(baseKeymap)
    ]
  });
}

async function uploadAndInsertAttachment(
  file: File,
  viewRef: MutableRefObject<EditorView | null>,
  uploadRefs: {
    onUploadImageRef: MutableRefObject<((file: File) => Promise<RuntimePart>) | undefined>;
    onUploadDocumentRef: MutableRefObject<((file: File) => Promise<RuntimePart>) | undefined>;
    onUploadResourceRef: MutableRefObject<((file: File) => Promise<RuntimePart>) | undefined>;
    onUploadErrorRef: MutableRefObject<((message: string | null) => void) | undefined>;
  },
  uploadTasks: UploadTaskRegistry,
  expectedKind?: AttachmentUploadKind,
  replacementRange?: ReplacementRange
) {
  const view = viewRef.current;

  if (!view) {
    return;
  }

  const validationMessage = uploadRefs.onUploadResourceRef.current
    ? getAttachmentSizeValidationMessage(file)
    : getAttachmentValidationMessage(file, expectedKind);

  if (validationMessage) {
    uploadRefs.onUploadErrorRef.current?.(validationMessage);
    return;
  }

  const kind = getAttachmentUploadKind(file);
  const onUpload =
    uploadRefs.onUploadResourceRef.current ?? (kind === "image" ? uploadRefs.onUploadImageRef.current : uploadRefs.onUploadDocumentRef.current);

  if (!onUpload) {
    return;
  }

  const uploadId = createUploadId();
  const previousNode = replacementRange ? view.state.doc.nodeAt(replacementRange.from) ?? undefined : undefined;
  uploadTasks.set(uploadId, { status: "pending", previousNode });
  insertUploadingResourceNode(view, createUploadingPart(file, kind, uploadId), replacementRange);

  let part: RuntimePart;
  try {
    uploadRefs.onUploadErrorRef.current?.(null);
    part = await onUpload(file);
  } catch (error) {
    uploadTasks.set(uploadId, { status: "failed", previousNode });
    restoreOrRemoveUploadingResourceNode(view, uploadId, previousNode);
    uploadRefs.onUploadErrorRef.current?.(formatUploadError(error));
    return;
  }

  if (part.type !== "resource") {
    uploadTasks.set(uploadId, { status: "failed", previousNode });
    restoreOrRemoveUploadingResourceNode(view, uploadId, previousNode);
    return;
  }

  const completedPart = stripUploadRuntimeFields(part);
  uploadTasks.set(uploadId, { status: "completed", part: completedPart, previousNode });
  const node = createResourceNode(completedPart);
  replaceUploadingResourceNode(view, uploadId, node);
}

function createUploadTaskReconciliationPlugin(uploadTasksRef: MutableRefObject<UploadTaskRegistry>) {
  return new Plugin({
    appendTransaction(_transactions, _oldState, newState) {
      const replacements: Array<{ from: number; to: number; node?: ProseMirrorNode }> = [];

      newState.doc.descendants((node, position) => {
        if (node.type.name !== "resource_part" || node.attrs.uploading !== true) {
          return true;
        }

        const uploadId = typeof node.attrs.uploadId === "string" ? node.attrs.uploadId : "";
        const uploadTask = uploadId ? uploadTasksRef.current.get(uploadId) : undefined;

        if (!uploadTask || uploadTask.status === "pending") {
          return true;
        }

        replacements.push({
          from: position,
          to: position + node.nodeSize,
          node: uploadTask.status === "completed" ? createResourceNode(uploadTask.part) : uploadTask.previousNode
        });
        return true;
      });

      if (!replacements.length) {
        return null;
      }

      let transaction = newState.tr;
      for (const replacement of replacements.reverse()) {
        transaction = replacement.node
          ? transaction.replaceWith(replacement.from, replacement.to, replacement.node)
          : transaction.delete(replacement.from, replacement.to);
      }

      return transaction
        .setMeta("addToHistory", false)
        .setMeta("actionType", "resource.upload.reconcile");
    }
  });
}

function insertUploadingResourceNode(
  view: EditorView,
  part: RuntimeResourcePart,
  replacementRange?: ReplacementRange
) {
  const node = createResourceNode(part);
  const transaction = replacementRange
    ? view.state.tr.replaceWith(replacementRange.from, replacementRange.to, node)
    : view.state.tr.replaceSelectionWith(node);

  view.dispatch(transaction.scrollIntoView());
  updateEmptyClass(view);
  view.focus();
}

function replaceUploadingResourceNode(view: EditorView, uploadId: string, node: ReturnType<typeof createResourceNode>) {
  const found = findUploadingResourceNode(view, uploadId);

  if (!found) {
    return;
  }

  view.dispatch(
    view.state.tr
      .replaceWith(found.position, found.position + found.node.nodeSize, node)
      .setMeta("addToHistory", false)
      .setMeta("actionType", "resource.upload.completed")
      .scrollIntoView()
  );
  updateEmptyClass(view);
  view.focus();
}

function restoreOrRemoveUploadingResourceNode(view: EditorView, uploadId: string, previousNode?: ReturnType<typeof createResourceNode>) {
  const found = findUploadingResourceNode(view, uploadId);

  if (!found) {
    return;
  }

  const transaction = previousNode
    ? view.state.tr.replaceWith(found.position, found.position + found.node.nodeSize, previousNode)
    : view.state.tr.delete(found.position, found.position + found.node.nodeSize);
  view.dispatch(
    transaction
      .setMeta("addToHistory", false)
      .setMeta("actionType", "resource.upload.failed")
      .scrollIntoView()
  );
  updateEmptyClass(view);
  view.focus();
}

function findUploadingResourceNode(view: EditorView, uploadId: string) {
  let found: { position: number; node: ReturnType<typeof createResourceNode> } | undefined;

  view.state.doc.descendants((node, position) => {
    if (found || node.type.name !== "resource_part") {
      return !found;
    }

    if (node.attrs.uploadId === uploadId) {
      found = { position, node };
      return false;
    }

    return true;
  });

  return found;
}

function createUploadingPart(file: File, kind: AttachmentUploadKind | undefined, uploadId: string): RuntimeResourcePart {
  return {
    type: "resource",
    mime: getUploadingPartMime(file, kind),
    name: file.name || "附件",
    size: file.size,
    $uploading: true,
    $uploadId: uploadId
  };
}

function getUploadingPartMime(file: File, kind: AttachmentUploadKind | undefined) {
  if (file.type.trim()) {
    return file.type;
  }

  if (kind === "image") {
    return "image/*";
  }

  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) {
    return "text/markdown";
  }

  if (lowerName.endsWith(".txt")) {
    return "text/plain";
  }

  if (lowerName.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  if (lowerName.endsWith(".doc")) {
    return "application/msword";
  }

  return "application/octet-stream";
}

function createUploadId() {
  uploadSequence += 1;
  return `upload_${Date.now()}_${uploadSequence}`;
}

function stripUploadRuntimeFields(part: RuntimeResourcePart): RuntimeResourcePart {
  const { $uploading: _uploading, $uploadId: _uploadId, ...stablePart } = part;
  return stablePart as RuntimeResourcePart;
}

function createResourceNode(part: RuntimeResourcePart) {
  const runtimePart = part as RuntimeResourcePart;
  return partSchema.nodes.resource_part.create({
    mime: part.mime ?? "",
    url: part.url ?? "",
    name: part.name ?? "",
    size: part.size ?? null,
    width: part.width ?? null,
    height: part.height ?? null,
    extra: part.extra ?? null,
    uploading: runtimePart.$uploading === true,
    uploadId: typeof runtimePart.$uploadId === "string" ? runtimePart.$uploadId : null
  });
}

function formatUploadError(error: unknown): string {
  return error instanceof Error ? error.message : "附件上传失败";
}

function closestResourcePartElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof Element) {
    return target.closest(".pm-part--resource") as HTMLElement | null;
  }

  if (target instanceof Text) {
    return target.parentElement?.closest(".pm-part--resource") as HTMLElement | null;
  }

  return null;
}

function closestResourceReplaceButtonElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof Element) {
    return target.closest(".pm-part-resource-replace") as HTMLElement | null;
  }

  if (target instanceof Text) {
    return target.parentElement?.closest(".pm-part-resource-replace") as HTMLElement | null;
  }

  return null;
}

function closestResourceRemoveButtonElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof Element) {
    return target.closest(".pm-part-resource-remove") as HTMLElement | null;
  }

  if (target instanceof Text) {
    return target.parentElement?.closest(".pm-part-resource-remove") as HTMLElement | null;
  }

  return null;
}

function deleteResourcePartFromRemoveButton(view: EditorView, button: HTMLElement) {
  const resourceElement = button.closest(".pm-part--resource");

  if (!(resourceElement instanceof HTMLElement)) {
    return;
  }

  const range = findResourceReplacementRange(view, resourceElement);

  if (!range) {
    return;
  }

  view.dispatch(view.state.tr.delete(range.from, range.to).scrollIntoView());
  updateEmptyClass(view);
  view.focus();
}

function replaceResourcePartFromReplaceButton(
  view: EditorView,
  button: HTMLElement,
  input: Parameters<typeof createEditorState>[0]
) {
  const resourceElement = button.closest(".pm-part--resource");

  if (!(resourceElement instanceof HTMLElement)) {
    return;
  }

  const range = findResourceReplacementRange(view, resourceElement);

  if (!range) {
    return;
  }

  input.pendingReplacementRangeRef.current = range;
  clearResourceClickSelection(view, range);
  input.resourceInputRef.current?.click();
}

function moveSelectionToEndWhenAtDocumentStart(view: EditorView) {
  const selection = view.state.selection;

  if (!selection.empty || selection.from !== 1) {
    return;
  }

  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
}

function findResourceReplacementRange(view: EditorView, element: HTMLElement): ReplacementRange | undefined {
  // ProseMirror 的 posAtDOM 对 atom 节点有时会落在节点前后边界。
  // 同时检查当前位置和前一位，能稳定找到 resource_part 的真实范围。
  const candidatePositions = [view.posAtDOM(element, 0), Math.max(0, view.posAtDOM(element, 0) - 1)];

  for (const from of candidatePositions) {
    const node = view.state.doc.nodeAt(from);

    if (node?.type.name === "resource_part") {
      return { from, to: from + node.nodeSize };
    }
  }

  return undefined;
}

function clearResourceClickSelection(view: EditorView, replacementRange?: ReplacementRange) {
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
      .setMeta("actionType", "resource.click.clear-selection")
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
