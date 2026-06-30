import { EditorState, TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { partSchema } from "./part-schema";
import { getSelectedParts, partsToDoc, type RuntimePart } from "./part-serialization";

function mediaPart(name: string): RuntimePart {
  return {
    type: "media",
    mime: "image/png",
    url: `http://localhost:4001/uploads/images/${name}`,
    name,
    width: 640,
    height: 480,
    extra: {
      lifecycle: { state: "succeeded" }
    }
  };
}

function createState(parts: RuntimePart[]) {
  return EditorState.create({
    schema: partSchema,
    doc: partsToDoc(parts)
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

describe("part selection serialization", () => {
  it("extracts selected text and media parts without flattening media to plain text", () => {
    const state = createState([{ type: "text", value: "看这个" }, mediaPart("a.png"), { type: "text", value: "然后继续" }]);
    const mediaPosition = findFirstMediaPosition(state);
    const selection = TextSelection.create(state.doc, 2, mediaPosition + 3);
    const selectedState = state.apply(state.tr.setSelection(selection));

    expect(getSelectedParts(selectedState.doc, selectedState.selection)).toEqual([
      { type: "text", value: "这个" },
      mediaPart("a.png"),
      { type: "text", value: "然后" }
    ]);
  });

  it("returns undefined for an empty selection so callers can fall back to the whole message", () => {
    const state = createState([{ type: "text", value: "只是文字" }]);

    expect(getSelectedParts(state.doc, state.selection)).toBeUndefined();
  });
});
