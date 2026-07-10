import { describe, expect, it } from "vitest";
import {
  appendTextDelta,
  createTextPart,
  ensureAppendableTextPart,
  partsToLlmText,
  stripRuntimePartFields,
  upsertGeneratedResourceParts,
  type MessagePart
} from "../../src/modules/agent/message-parts.js";

describe("message parts", () => {
  it("strips runtime fields that start with $", () => {
    const parts = stripRuntimePartFields([
      { type: "text", value: "hello", $id: "runtime_1", $uploadStatus: "success" } as MessagePart &
        Record<string, unknown>
    ]);

    expect(parts).toEqual([{ type: "text", value: "hello" }]);
  });

  it("projects select values to labels for LLM context", () => {
    const parts: MessagePart[] = [
      { type: "text", value: "帮我生成" },
      {
        type: "text",
        value: "warm_pastoral",
        extra: {
          placeholder: {
            type: "select",
            label: "风格",
            options: [{ label: "温馨田园风", value: "warm_pastoral" }]
          }
        }
      },
      { type: "text", value: "小猪图片" }
    ];

    expect(partsToLlmText(parts)).toBe("帮我生成\n风格：温馨田园风\n小猪图片");
  });

  it("does not project pending resource into LLM context", () => {
    const parts: MessagePart[] = [
      { type: "text", value: "正在生成图片" },
      {
        type: "resource",
        mime: "image/png",
        url: "",
        extra: { lifecycle: { state: "pending" } }
      }
    ];

    expect(partsToLlmText(parts)).toBe("正在生成图片");
  });

  it("projects resource URL into LLM context so image editing tools can reference it", () => {
    const parts: MessagePart[] = [
      { type: "text", value: "把这张图改成水彩风格" },
      {
        type: "resource",
        mime: "image/png",
        name: "小猪原图",
        url: "http://127.0.0.1:4001/uploads/images/source-pig.png"
      }
    ];

    expect(partsToLlmText(parts)).toBe(
      "把这张图改成水彩风格\n小猪原图：http://127.0.0.1:4001/uploads/images/source-pig.png"
    );
  });

  it("appends text delta to the addressed text part", () => {
    expect(appendTextDelta([createTextPart("")], 0, "你好")).toEqual([{ type: "text", value: "你好" }]);
  });

  it("appends a new text part after existing resource when text arrives later", () => {
    const parts: MessagePart[] = [
      {
        type: "resource",
        mime: "image/png",
        url: "https://example.com/generated.png",
        extra: { lifecycle: { state: "succeeded" } }
      }
    ];

    const result = ensureAppendableTextPart(parts);

    expect(result).toEqual({
      partIndex: 1,
      parts: [
        parts[0],
        { type: "text", value: "" }
      ]
    });
  });

  it("creates and updates generated resource parts by tool call id and output index", () => {
    const pending = upsertGeneratedResourceParts([], {
      state: "pending",
      resourceId: "res_1",
      toolName: "generate_image",
      toolCallId: "call_1",
      toolCallRowId: "tool_call_1",
      outputIndex: 0,
      mime: "image/png"
    });

    expect(pending).toEqual([
      {
        type: "resource",
        mime: "image/png",
        extra: {
          placeholder: { type: "image", label: "图片生成中" },
          lifecycle: { state: "pending" },
          resource: { id: "res_1" },
          tool: { name: "generate_image", toolCallId: "call_1", toolCallRowId: "tool_call_1", outputIndex: 0 }
        }
      }
    ]);

    const completed = upsertGeneratedResourceParts(pending, {
      state: "succeeded",
      resourceId: "res_1",
      toolName: "generate_image",
      toolCallId: "call_1",
      toolCallRowId: "tool_call_1",
      outputIndex: 0,
      mime: "image/png",
      url: "https://example.com/generated-pig.png",
      name: "温馨田园小猪",
      width: 1024,
      height: 768,
      generation: {
        prompt: "温馨田园小猪",
        provider: "test"
      }
    });

    expect(completed[0]).toEqual({
      type: "resource",
      mime: "image/png",
      url: "https://example.com/generated-pig.png",
      name: "温馨田园小猪",
      width: 1024,
      height: 768,
      extra: {
        lifecycle: { state: "succeeded" },
        resource: { id: "res_1" },
        tool: { name: "generate_image", toolCallId: "call_1", toolCallRowId: "tool_call_1", outputIndex: 0 },
        generation: {
          prompt: "温馨田园小猪",
          provider: "test"
        }
      }
    });
  });

  it("creates generated video parts with video placeholder", () => {
    const pending = upsertGeneratedResourceParts([], {
      state: "pending",
      resourceId: "res_video",
      toolName: "generate_video",
      toolCallId: "call_video",
      toolCallRowId: "tool_call_video",
      outputIndex: 0,
      mime: "video/mp4"
    });

    expect(pending).toEqual([
      {
        type: "resource",
        mime: "video/mp4",
        extra: {
          placeholder: { type: "video", label: "视频生成中" },
          lifecycle: { state: "pending" },
          resource: { id: "res_video" },
          tool: { name: "generate_video", toolCallId: "call_video", toolCallRowId: "tool_call_video", outputIndex: 0 }
        }
      }
    ]);
  });

  it("creates generated document parts with document placeholder", () => {
    const pending = upsertGeneratedResourceParts([], {
      state: "pending",
      resourceId: "res_doc",
      toolName: "generate_document",
      toolCallId: "call_doc",
      toolCallRowId: "tool_call_doc",
      outputIndex: 0,
      mime: "text/markdown",
      name: "年度复盘.md"
    });

    expect(pending).toEqual([
      {
        type: "resource",
        mime: "text/markdown",
        name: "年度复盘.md",
        extra: {
          placeholder: { type: "document", label: "文档生成中" },
          lifecycle: { state: "pending" },
          resource: { id: "res_doc" },
          tool: { name: "generate_document", toolCallId: "call_doc", toolCallRowId: "tool_call_doc", outputIndex: 0 }
        }
      }
    ]);
  });
});
