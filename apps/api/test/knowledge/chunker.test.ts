import { describe, expect, it } from "vitest";
import { splitKnowledgeText } from "../../src/modules/knowledge/chunker.js";

describe("splitKnowledgeText", () => {
  it("按最大长度切块并保留相邻重叠文本", () => {
    const chunks = splitKnowledgeText("abcdefghi", {
      maxCharacters: 4,
      overlapCharacters: 2
    });

    expect(chunks).toEqual([
      { content: "abcd", startOffset: 0, endOffset: 4 },
      { content: "cdef", startOffset: 2, endOffset: 6 },
      { content: "efgh", startOffset: 4, endOffset: 8 },
      { content: "ghi", startOffset: 6, endOffset: 9 }
    ]);
  });

  it("优先按空白和换行规整文本，避免生成空 chunk", () => {
    const chunks = splitKnowledgeText("第一段\n\n\n第二段   第三段", {
      maxCharacters: 8,
      overlapCharacters: 2
    });

    expect(chunks.map((chunk) => chunk.content)).toEqual(["第一段 第二段", "第二段 第三段"]);
  });
});
