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

  it("round trips media parts", () => {
    const parts: RuntimePart[] = [
      { type: "text", value: "看" },
      {
        type: "media",
        mime: "image/png",
        url: "http://localhost:4001/uploads/images/a.png",
        name: "a.png",
        size: 123,
        width: 640,
        height: 480,
        extra: {
          lifecycle: { state: "succeeded" },
          generation: { prompt: "截图", provider: "upload" }
        }
      },
      { type: "text", value: "这张" }
    ];
    const doc = partsToDoc(parts);

    expect(docToParts(doc)).toEqual(parts);
  });

  it("strips runtime fields before submit", () => {
    expect(stripRuntimeFields([{ type: "text", value: "你好", $id: "part_1" }])).toEqual([
      { type: "text", value: "你好" }
    ]);
  });
});
