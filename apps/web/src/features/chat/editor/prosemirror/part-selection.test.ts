import { EditorState, TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { partSchema } from "./part-schema";
import { getSelectedParts, partsToDoc, type RuntimePart } from "./part-serialization";

function resourcePart(name: string): RuntimePart {
  return {
    type: "resource",
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

describe("part selection serialization", () => {
  it("extracts selected text and resource parts without flattening resource to plain text", () => {
    const state = createState([{ type: "text", value: "看这个" }, resourcePart("a.png"), { type: "text", value: "然后继续" }]);
    const resourcePosition = findFirstResourcePosition(state);
    const selection = TextSelection.create(state.doc, 2, resourcePosition + 3);
    const selectedState = state.apply(state.tr.setSelection(selection));

    expect(getSelectedParts(selectedState.doc, selectedState.selection)).toEqual([
      { type: "text", value: "这个" },
      resourcePart("a.png"),
      { type: "text", value: "然后" }
    ]);
  });

  it("returns undefined for an empty selection so callers can fall back to the whole message", () => {
    const state = createState([{ type: "text", value: "只是文字" }]);

    expect(getSelectedParts(state.doc, state.selection)).toBeUndefined();
  });
});
