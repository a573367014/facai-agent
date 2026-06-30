import { describe, expect, it } from "vitest";
import {
  appendTextDelta,
  createTextPart,
  partsToLlmText,
  stripRuntimePartFields,
  upsertGeneratedImageParts,
  type MessagePart
} from "../../src/agent/message-parts.js";

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

  it("does not project pending media into LLM context", () => {
    const parts: MessagePart[] = [
      { type: "text", value: "正在生成图片" },
      {
        type: "media",
        mime: "image/png",
        url: "",
        extra: { lifecycle: { state: "pending" } }
      }
    ];

    expect(partsToLlmText(parts)).toBe("正在生成图片");
  });

  it("projects media URL into LLM context so image editing tools can reference it", () => {
    const parts: MessagePart[] = [
      { type: "text", value: "把这张图改成水彩风格" },
      {
        type: "media",
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

  it("creates and updates generated image parts by tool call id and output index", () => {
    const pending = upsertGeneratedImageParts([], {
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
        type: "media",
        mime: "image/png",
        extra: {
          placeholder: { type: "image", label: "图片生成中" },
          lifecycle: { state: "pending" },
          resource: { id: "res_1" },
          tool: { name: "generate_image", toolCallId: "call_1", toolCallRowId: "tool_call_1", outputIndex: 0 }
        }
      }
    ]);

    const completed = upsertGeneratedImageParts(pending, {
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
      type: "media",
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
    const pending = upsertGeneratedImageParts([], {
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
        type: "media",
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
});
