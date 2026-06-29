import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "../../src/tools/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";

describe("ToolRegistry", () => {
  it("注册工具并暴露模型可用定义", () => {
    const registry = new ToolRegistry();
    const tool = {
      name: "echo",
      description: "Echo input",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      },
      execute: async (args) => ({ text: String(args.text) })
    };

    registry.register(tool);

    expect(registry.getTool("echo")).toBe(tool);
    expect(registry.getDefinitions()).toEqual([
      {
        name: "echo",
        description: "Echo input",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"]
        }
      }
    ]);
  });

  it("配置 Tavily Key 后注册 web_search 工具", () => {
    const withoutSearch = createDefaultToolRegistry();
    const withSearch = createDefaultToolRegistry({
      tavilyApiKey: "tvly-test",
      searchMaxResults: 5
    });

    expect(withoutSearch.getTool("web_search")).toBeUndefined();
    expect(withSearch.getTool("web_search")).toBeDefined();
    expect(withSearch.getDefinitions().map((tool) => tool.name)).toContain("web_search");
  });

  it("配置火山 AK/SK 后注册 generate_image 和 edit_image 工具", () => {
    const withoutImage = createDefaultToolRegistry();
    const withImage = createDefaultToolRegistry({
      jimengImage: {
        accessKeyId: "ak-test",
        secretAccessKey: "sk-test"
      },
      jimengImageEdit: {
        accessKeyId: "ak-test",
        secretAccessKey: "sk-test"
      }
    });

    expect(withoutImage.getTool("generate_image")).toBeUndefined();
    expect(withoutImage.getTool("edit_image")).toBeUndefined();
    expect(withImage.getTool("generate_image")).toBeDefined();
    expect(withImage.getTool("edit_image")).toBeDefined();
    expect(withImage.getDefinitions().map((tool) => tool.name)).toContain("generate_image");
    expect(withImage.getDefinitions().map((tool) => tool.name)).toContain("edit_image");
  });
});
