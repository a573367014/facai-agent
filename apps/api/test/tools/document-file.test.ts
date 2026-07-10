import { dirname } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createDocumentFileTool, DOCX_MIME } from "../../src/modules/tools/document-file.js";
import type { ToolOutput } from "../../src/modules/tools/types.js";

function asToolOutput(value: unknown): ToolOutput {
  return value as ToolOutput;
}

describe("generate_document tool", () => {
  it("generates markdown documents as local file references without embedding base64 payloads", async () => {
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
    const document = (output.data as { documents: Array<{ name: string; mime: string; source: { type: string; path: string }; contentBase64?: string; size: number }> })
      .documents[0]!;

    try {
      expect(output.llmContent).toContain("年度复盘.md");
      expect(document).toMatchObject({
        name: "年度复盘.md",
        mime: "text/markdown",
        source: {
          type: "local_file",
          path: expect.any(String)
        },
        size: Buffer.byteLength("# 年度复盘\n\n- 收入增长 20%", "utf8")
      });
      expect(document.contentBase64).toBeUndefined();
      expect(await readFile(document.source.path, "utf8")).toBe("# 年度复盘\n\n- 收入增长 20%");
    } finally {
      await rm(dirname(document.source.path), { recursive: true, force: true });
    }
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
    const document = (output.data as { documents: Array<{ name: string; mime: string; source: { type: string; path: string } }> })
      .documents[0]!;

    try {
      expect(document.name).toBe("notes.txt");
      expect(document.mime).toBe("text/plain");
      expect(await readFile(document.source.path, "utf8")).toBe("纯文本内容");
    } finally {
      await rm(dirname(document.source.path), { recursive: true, force: true });
    }
  });

  it("generates docx documents as Office Open XML zip files", async () => {
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
    const document = (output.data as { documents: Array<{ name: string; mime: string; source: { type: string; path: string }; size: number }> })
      .documents[0]!;

    try {
      const bytes = await readFile(document.source.path);

      expect(document.name).toBe("analysis.docx");
      expect(document.mime).toBe(DOCX_MIME);
      expect(document.size).toBe(bytes.length);
      expect(bytes.subarray(0, 2).toString("utf8")).toBe("PK");
    } finally {
      await rm(dirname(document.source.path), { recursive: true, force: true });
    }
  });
});
