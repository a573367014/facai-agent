import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConversation, type ChatMessage } from "./AgentConversation";

const stylesPath = join(process.cwd(), "src/styles.css");

afterEach(() => {
  cleanup();
});

describe("AgentConversation", () => {
  it("空状态建议项可以点击并回填输入框", async () => {
    const onSuggestionSelect = vi.fn();

    render(<AgentConversation messages={[]} isActive={false} onSuggestionSelect={onSuggestionSelect} />);

    await userEvent.click(screen.getByRole("button", { name: "现在上海时间是多少？" }));

    expect(onSuggestionSelect).toHaveBeenCalledWith("现在上海时间是多少？");
  });

  it("renders assistant answers as Markdown", () => {
    const messages: ChatMessage[] = [
      {
        id: "run_1:assistant",
        role: "assistant",
        content: "**重点**\n\n- 第一项\n\n```ts\nconst value = 1;\n```",
        status: "completed"
      }
    ];

    const { container } = render(<AgentConversation messages={messages} isActive={false} />);

    expect(screen.getByText("重点").tagName.toLowerCase()).toBe("strong");
    expect(screen.getByText("第一项").tagName.toLowerCase()).toBe("li");
    expect(container.querySelector("pre code")).toHaveTextContent("const value = 1;");
  });

  it("在回答主体展示图片预览，工具过程只保留技术轨迹", async () => {
    const messages: ChatMessage[] = [
      {
        id: "run_1:assistant",
        role: "assistant",
        content: "我查到了资料，也生成了图片。",
        status: "completed",
        events: [
          {
            type: "tool_call_ready",
            iteration: 0,
            toolCallId: "call_search",
            toolName: "web_search",
            arguments: { query: "Fastify 最新版本" }
          },
          {
            type: "tool_result",
            iteration: 0,
            toolCallId: "call_search",
            toolName: "web_search",
            durationMs: 812,
            result: {
              provider: "tavily",
              query: "Fastify 最新版本",
              answer: "Fastify 是一个高性能 Node.js Web 框架。",
              resultCount: 1,
              results: [
                {
                  title: "Fastify",
                  url: "https://fastify.dev/",
                  snippet: "Fast and low overhead web framework."
                }
              ]
            }
          },
          {
            type: "tool_start",
            iteration: 0,
            toolCallId: "call_image",
            toolName: "generate_image",
            arguments: { prompt: "赛博茶馆" }
          },
          {
            type: "tool_result",
            iteration: 0,
            toolCallId: "call_image",
            toolName: "generate_image",
            durationMs: 18200,
            result: {
              provider: "volcengine_seedream",
              prompt: "赛博茶馆",
              size: "2K",
              imageUrls: ["https://example.com/generated.png"],
              binaryDataBase64: [],
              revisedPrompts: ["赛博茶馆，电影感"]
            }
          }
        ]
      }
    ];

    const { container } = render(<AgentConversation messages={messages} isActive={false} />);

    expect(screen.getByText("工具过程")).toBeInTheDocument();
    expect(container.querySelector(".MuiAccordion-root.tool-events")).toBeInTheDocument();
    expect(screen.getByText("web_search")).toBeInTheDocument();
    expect(screen.getAllByText("Fastify 最新版本").length).toBeGreaterThan(0);
    expect(screen.getByText("来源 1 条")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fastify" })).toHaveAttribute("href", "https://fastify.dev/");
    expect(screen.getByText("generate_image")).toBeInTheDocument();
    expect(screen.getAllByText("赛博茶馆").length).toBeGreaterThan(0);
    expect(screen.getByRole("img", { name: "生成图片 1" })).toHaveAttribute("src", "https://example.com/generated.png");
    expect(screen.getByRole("button", { name: "预览图片 1" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载图片 1" })).toHaveAttribute("href", "https://example.com/generated.png");
    expect(screen.getByRole("button", { name: "更多图片操作 1" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "更多图片操作 1" }));

    expect(document.body.querySelector(".MuiMenu-root")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "复制图片链接 1" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "引用图片 1" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "打开原图 1" })).toHaveAttribute("href", "https://example.com/generated.png");

    const mainAssetArea = container.querySelector(".message-image-assets");
    const toolEventArea = container.querySelector(".tool-events");

    expect(mainAssetArea).not.toBeNull();
    expect(mainAssetArea?.querySelector('img[alt="生成图片 1"]')).not.toBeNull();
    expect(toolEventArea?.querySelector('img[alt="生成图片 1"]')).toBeNull();
  });

  it("渲染正文时过滤当前图片资源链接", () => {
    const messages: ChatMessage[] = [
      {
        id: "run_1:assistant",
        role: "assistant",
        content:
          "图片已经生成。\n\n[点击查看生成的小狗图片](https://example.com/generated.png)\n\n画面中是一只可爱的小狗。",
        status: "completed",
        events: [
          {
            type: "tool_result",
            iteration: 0,
            toolCallId: "call_image",
            toolName: "generate_image",
            durationMs: 18200,
            result: {
              provider: "volcengine_seedream",
              prompt: "小狗",
              imageUrls: ["https://example.com/generated.png"],
              binaryDataBase64: []
            }
          }
        ]
      }
    ];

    render(<AgentConversation messages={messages} isActive={false} />);

    expect(screen.getByText("图片已经生成。")).toBeInTheDocument();
    expect(screen.getByText("画面中是一只可爱的小狗。")).toBeInTheDocument();
    expect(screen.queryByText("点击查看生成的小狗图片")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "生成图片 1" })).toHaveAttribute("src", "https://example.com/generated.png");
  });

  it("图片资源交互按钮浮在图片上并只在 hover 或 focus 时显示", () => {
    const messages: ChatMessage[] = [
      {
        id: "run_1:assistant",
        role: "assistant",
        content: "图片已生成。",
        status: "completed",
        events: [
          {
            type: "tool_result",
            iteration: 0,
            toolCallId: "call_image",
            toolName: "generate_image",
            result: {
              provider: "volcengine_seedream",
              prompt: "小狗",
              imageUrls: ["https://example.com/generated.png"],
              binaryDataBase64: []
            }
          }
        ]
      }
    ];

    const { container } = render(<AgentConversation messages={messages} isActive={false} />);
    const imageStage = container.querySelector(".tool-image-stage");
    const actions = screen.getByRole("link", { name: "下载图片 1" }).closest(".tool-image-actions");

    expect(imageStage).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(imageStage?.contains(actions)).toBe(true);

    const styles = readFileSync(stylesPath, "utf8");
    expect(styles).toMatch(/\.tool-image-stage\s*{[^}]*position:\s*relative;/s);
    expect(styles).toMatch(/\.tool-image-actions\s*{[^}]*position:\s*absolute;[^}]*opacity:\s*0;/s);
    expect(styles).toMatch(/\.tool-image-preview:hover\s+\.tool-image-actions/s);
    expect(styles).toMatch(/\.tool-image-preview:focus-within\s+\.tool-image-actions/s);
    expect(screen.getByRole("button", { name: "更多图片操作 1" })).toHaveClass("MuiIconButton-root");
  });

  it("图片点击预览使用 MUI Dialog 承载", async () => {
    const messages: ChatMessage[] = [
      {
        id: "run_1:assistant",
        role: "assistant",
        content: "图片已生成。",
        status: "completed",
        events: [
          {
            type: "tool_result",
            iteration: 0,
            toolCallId: "call_image",
            toolName: "generate_image",
            result: {
              provider: "volcengine_seedream",
              prompt: "小狗",
              imageUrls: ["https://example.com/generated.png"],
              binaryDataBase64: []
            }
          }
        ]
      }
    ];

    render(<AgentConversation messages={messages} isActive={false} />);

    await userEvent.click(screen.getByRole("button", { name: "预览图片 1" }));

    expect(document.body.querySelector(".MuiDialog-root")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "图片预览" })).toBeInTheDocument();
  });

  it("图片预览按原图比例展示，不做 1:1 裁切", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const imageRule = styles.match(/\n\.tool-image-preview img\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const mainImageRule = styles.match(/\.message-image-assets \.tool-image-preview img\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";

    expect(imageRule).not.toContain("aspect-ratio: 1 / 1");
    expect(mainImageRule).not.toContain("object-fit: cover");
    expect(imageRule).toContain("height: auto");
    expect(imageRule).toContain("object-fit: contain");
  });

  it("批量生图结果在回答主体展示每个子任务的图片和失败原因", () => {
    const messages: ChatMessage[] = [
      {
        id: "run_2:assistant",
        role: "assistant",
        content: "批量图片处理完成。",
        status: "completed",
        events: [
          {
            type: "tool_result",
            iteration: 0,
            toolCallId: "call_batch_image",
            toolName: "generate_image",
            durationMs: 42000,
            result: {
              provider: "volcengine_seedream",
              status: "partial_failed",
              total: 2,
              succeeded: 1,
              failed: 1,
              imageUrls: ["https://example.com/watercolor-pig.png"],
              binaryDataBase64: [],
              items: [
                {
                  index: 0,
                  status: "success",
                  prompt: "水彩风格的小猪",
                  width: 1024,
                  height: 1024,
                  seed: 11,
                  taskId: "task_watercolor",
                  imageUrls: ["https://example.com/watercolor-pig.png"],
                  binaryDataBase64: []
                },
                {
                  index: 1,
                  status: "failed",
                  prompt: "像素风格的小猪",
                  width: 1536,
                  height: 1024,
                  seed: 22,
                  error: "火山通用文生图任务未在限定时间内完成"
                }
              ]
            }
          }
        ]
      }
    ];

    render(<AgentConversation messages={messages} isActive={false} />);

    expect(screen.getByText("批量 2 项，成功 1 项，失败 1 项")).toBeInTheDocument();
    expect(screen.getByText("水彩风格的小猪")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "水彩风格的小猪" })).toHaveAttribute(
      "src",
      "https://example.com/watercolor-pig.png"
    );
    expect(screen.getByText("像素风格的小猪")).toBeInTheDocument();
    expect(screen.getByText("火山通用文生图任务未在限定时间内完成")).toBeInTheDocument();
  });

  it("批量生图进度事件会在最终结果前先展示已完成图片", () => {
    const messages: ChatMessage[] = [
      {
        id: "run_3:assistant",
        role: "assistant",
        content: "",
        status: "running",
        events: [
          {
            type: "tool_start",
            iteration: 0,
            toolCallId: "call_batch_image",
            toolName: "generate_image",
            arguments: {
              items: [{ prompt: "水彩小猪" }, { prompt: "像素小猪" }]
            }
          },
          {
            type: "tool_progress",
            iteration: 0,
            toolCallId: "call_batch_image",
            toolName: "generate_image",
            progress: {
              kind: "image_batch_item",
              total: 2,
              item: {
                index: 1,
                status: "success",
                prompt: "像素小猪",
                width: 1328,
                height: 1328,
                seed: -1,
                taskId: "task_fast",
                imageUrls: ["https://example.com/fast-pixel-pig.png"],
                binaryDataBase64: []
              }
            }
          }
        ] as unknown as ChatMessage["events"]
      }
    ];

    render(<AgentConversation messages={messages} isActive />);

    expect(screen.getByText("批量 2 项，成功 1 项，失败 0 项")).toBeInTheDocument();
    expect(screen.getByText("像素小猪")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "像素小猪" })).toHaveAttribute(
      "src",
      "https://example.com/fast-pixel-pig.png"
    );
  });

  it("图片生成中在回答主体展示固定占位 loading", () => {
    const messages: ChatMessage[] = [
      {
        id: "run_1:assistant",
        role: "assistant",
        content: "",
        status: "running",
        events: [
          {
            type: "tool_start",
            iteration: 0,
            toolCallId: "call_image",
            toolName: "generate_image",
            arguments: { prompt: "粉色小猪", width: 1328, height: 1328 }
          }
        ]
      }
    ];

    const { container } = render(<AgentConversation messages={messages} isActive />);

    expect(screen.getByText("我正在为你生成图片")).toBeInTheDocument();
    expect(screen.getByText("正在生成图片")).toBeInTheDocument();
    expect(screen.getByText("1328 x 1328")).toBeInTheDocument();
    expect(screen.getAllByText("粉色小猪").length).toBeGreaterThan(0);

    const mainAssetArea = container.querySelector(".message-image-assets");
    const toolEventArea = container.querySelector(".tool-events");

    expect(mainAssetArea).not.toBeNull();
    expect(mainAssetArea?.textContent).toContain("正在生成图片");
    expect(container.textContent).not.toContain("Seedream");
    expect(toolEventArea?.textContent).not.toContain("Seedream 正在处理");
  });
});
