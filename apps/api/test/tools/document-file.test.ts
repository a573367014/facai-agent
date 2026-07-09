import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createDocumentFileTool, DOCX_MIME } from "../../src/tools/document-file.js";
import type { ToolOutput } from "../../src/tools/types.js";

function asToolOutput(value: unknown): ToolOutput {
  return value as ToolOutput;
}

describe("generate_document tool", () => {
  it("generates markdown documents as base64 payloads with a normalized file name", async () => {
    const tool = createDocumentFileTool();
    const output = asToolOutput(
      await tool.execute(
        {
          format: "markdown",
          fileName: "年度复盘",
          title: "年度复盘",
          content: "# 年度复盘\n\n- 收入增长 20%"
        },
        {}
      )
    );
    const document = (output.data as { documents: Array<{ name: string; mime: string; contentBase64: string; size: number }> })
      .documents[0]!;
    const bytes = Buffer.from(document.contentBase64, "base64");

    expect(output.llmContent).toContain("年度复盘.md");
    expect(document).toMatchObject({
      name: "年度复盘.md",
      mime: "text/markdown",
      size: Buffer.byteLength("# 年度复盘\n\n- 收入增长 20%", "utf8")
    });
    expect(bytes.toString("utf8")).toBe("# 年度复盘\n\n- 收入增长 20%");
  });

  it("normalizes txt extension even when the caller passes another suffix", async () => {
    const tool = createDocumentFileTool();
    const output = asToolOutput(
      await tool.execute(
        {
          format: "txt",
          fileName: "notes.md",
          content: "纯文本内容"
        },
        {}
      )
    );
    const document = (output.data as { documents: Array<{ name: string; mime: string; contentBase64: string }> })
      .documents[0]!;

    expect(document.name).toBe("notes.txt");
    expect(document.mime).toBe("text/plain");
    expect(Buffer.from(document.contentBase64, "base64").toString("utf8")).toBe("纯文本内容");
  });

  it("generates docx documents as Office Open XML zip bytes", async () => {
    const tool = createDocumentFileTool();
    const output = asToolOutput(
      await tool.execute(
        {
          format: "docx",
          fileName: "analysis",
          title: "分析报告",
          content: "第一段\n\n第二段"
        },
        {}
      )
    );
    const document = (output.data as { documents: Array<{ name: string; mime: string; contentBase64: string; size: number }> })
      .documents[0]!;
    const bytes = Buffer.from(document.contentBase64, "base64");

    expect(document.name).toBe("analysis.docx");
    expect(document.mime).toBe(DOCX_MIME);
    expect(document.size).toBe(bytes.length);
    expect(bytes.subarray(0, 2).toString("utf8")).toBe("PK");
  });
});
