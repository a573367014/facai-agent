import { describe, expect, it } from "vitest";
import { SYSTEM_INSTRUCTIONS } from "../../src/agent/instructions.js";

describe("SYSTEM_INSTRUCTIONS", () => {
  it("要求图片资源由界面展示，不让 LLM 在正文输出图片链接", () => {
    expect(SYSTEM_INSTRUCTIONS).toContain("不要输出图片链接");
    expect(SYSTEM_INSTRUCTIONS).not.toContain("图片链接原样提供给用户");
  });

  it("要求多张图片使用 items 一次调用 generate_image", () => {
    expect(SYSTEM_INSTRUCTIONS).toContain("items");
    expect(SYSTEM_INSTRUCTIONS).toContain("最多 5 项");
    expect(SYSTEM_INSTRUCTIONS).toContain("不要拆成多个 generate_image 调用");
  });
});
