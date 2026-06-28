import { describe, expect, it } from "vitest";
import { docToParts, partsToDoc, stripRuntimeFields, type RuntimePart } from "./part-serialization";

describe("part prosemirror serialization", () => {
  it("round trips text parts", () => {
    const parts: RuntimePart[] = [{ type: "text", value: "你好", $id: "part_1" }];
    const doc = partsToDoc(parts);

    expect(docToParts(doc)).toEqual([{ type: "text", value: "你好" }]);
  });

  it("keeps line breaks in text parts", () => {
    const parts: RuntimePart[] = [{ type: "text", value: "第一行\n第二行" }];
    const doc = partsToDoc(parts);

    expect(docToParts(doc)).toEqual([{ type: "text", value: "第一行\n第二行" }]);
  });

  it("strips runtime fields before submit", () => {
    expect(stripRuntimeFields([{ type: "text", value: "你好", $id: "part_1" }])).toEqual([
      { type: "text", value: "你好" }
    ]);
  });
});
