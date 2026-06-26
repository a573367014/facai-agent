import { useEffect, useRef, type MutableRefObject } from "react";
import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { docToParts, partsToDoc, stripRuntimeFields, type RuntimePart } from "../prosemirror/part-serialization";
import { partSchema } from "../prosemirror/part-schema";

interface PartComposerProps {
  parts: RuntimePart[];
  disabled?: boolean;
  focusToken?: number;
  onChange: (parts: RuntimePart[]) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function PartComposer({ parts, disabled = false, focusToken = 0, onChange, onSubmit, onCancel }: PartComposerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onCancelRef = useRef(onCancel);
  const disabledRef = useRef(disabled);

  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;
  onCancelRef.current = onCancel;
  disabledRef.current = disabled;

  useEffect(() => {
    if (!rootRef.current || viewRef.current) {
      return;
    }

    const view = new EditorView(rootRef.current, {
      state: createEditorState(parts, onSubmitRef, onCancelRef),
      editable: () => !disabledRef.current,
      attributes: {
        role: "textbox",
        "aria-label": "发消息",
        placeholder: "发消息...",
        class: "part-composer-editor"
      },
      dispatchTransaction(transaction) {
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

    if (currentParts === nextParts) {
      return;
    }

    view.updateState(createEditorState(parts, onSubmitRef, onCancelRef));
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

  return <div className="part-composer" ref={rootRef} />;
}

function createEditorState(
  parts: RuntimePart[],
  onSubmitRef: MutableRefObject<() => void>,
  onCancelRef: MutableRefObject<() => void>
) {
  return EditorState.create({
    schema: partSchema,
    doc: partsToDoc(parts),
    plugins: [
      history(),
      keymap({
        Enter: () => {
          onSubmitRef.current();
          return true;
        },
        "Shift-Enter": insertHardBreak,
        "Mod-z": undo,
        "Mod-y": redo,
        "Mod-Shift-z": redo,
        Escape: () => {
          onCancelRef.current();
          return true;
        }
      }),
      keymap(baseKeymap)
    ]
  });
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
