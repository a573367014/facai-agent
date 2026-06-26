import { describe, expect, it } from "vitest";
import {
  appendTextDelta,
  createTextPart,
  legacyContentToParts,
  partsToLegacyContent,
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

  it("converts legacy content into one text part", () => {
    expect(legacyContentToParts("你好")).toEqual([{ type: "text", value: "你好" }]);
    expect(legacyContentToParts("")).toEqual([]);
  });

  it("keeps a legacy text mirror for sqlite compatibility", () => {
    expect(partsToLegacyContent([{ type: "text", value: "你好" }])).toBe("你好");
    expect(
      partsToLegacyContent([
        { type: "text", value: "图在这里" },
        { type: "media", mime: "image/png", url: "https://example.com/pig.png", name: "小猪" }
      ])
    ).toBe("图在这里\n小猪：https://example.com/pig.png");
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

  it("appends text delta to the addressed text part", () => {
    expect(appendTextDelta([createTextPart("")], 0, "你好")).toEqual([{ type: "text", value: "你好" }]);
  });

  it("creates and updates generated image parts by tool call id and output index", () => {
    const pending = upsertGeneratedImageParts([], {
      state: "pending",
      toolName: "generate_image",
      toolCallId: "call_1",
      outputIndex: 0,
      mime: "image/png"
    });

    expect(pending).toEqual([
      {
        type: "media",
        mime: "image/png",
        url: "",
        extra: {
          placeholder: { type: "image", label: "图片生成中" },
          lifecycle: { state: "pending" },
          tool: { name: "generate_image", toolCallId: "call_1", outputIndex: 0 }
        }
      }
    ]);

    const completed = upsertGeneratedImageParts(pending, {
      state: "succeeded",
      toolName: "generate_image",
      toolCallId: "call_1",
      outputIndex: 0,
      mime: "image/png",
      url: "https://example.com/pig.png",
      width: 1024,
      height: 1024,
      generation: { prompt: "小猪", provider: "volcengine", model: "seedream" }
    });

    expect(completed[0]).toMatchObject({
      type: "media",
      mime: "image/png",
      url: "https://example.com/pig.png",
      width: 1024,
      height: 1024,
      extra: {
        lifecycle: { state: "succeeded" },
        tool: { name: "generate_image", toolCallId: "call_1", outputIndex: 0 },
        generation: { prompt: "小猪", provider: "volcengine", model: "seedream" }
      }
    });
  });
});
