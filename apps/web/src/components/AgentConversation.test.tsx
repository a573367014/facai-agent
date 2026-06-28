import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConversation, type ChatMessage } from "./AgentConversation";

const stylesPath = join(process.cwd(), "src/styles.css");

afterEach(() => {
  cleanup();
});

describe("AgentConversation", () => {
  it("滚动到消息列表顶部附近时自动加载更早消息", () => {
    const onLoadOlderMessages = vi.fn();
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ type: "text", value: "最近回答" }],
        status: "completed"
      }
    ];

    const { container } = render(
      <AgentConversation
        messages={messages}
        isActive={false}
        hasMoreMessages
        isLoadingOlderMessages={false}
        onLoadOlderMessages={onLoadOlderMessages}
      />
    );
    const scrollElement = container.querySelector(".chat-scroll") as HTMLDivElement;

    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      value: 48
    });

    fireEvent.wheel(scrollElement, { deltaY: -120 });
    fireEvent.scroll(scrollElement);

    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
  });

  it("程序滚动到顶部附近时不会误触发加载更早消息", () => {
    const onLoadOlderMessages = vi.fn();
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ type: "text", value: "最近回答" }],
        status: "completed"
      }
    ];
    const { container } = render(
      <AgentConversation messages={messages} isActive={false} hasMoreMessages onLoadOlderMessages={onLoadOlderMessages} />
    );
    const scrollElement = container.querySelector(".chat-scroll") as HTMLDivElement;

    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      value: 48
    });

    fireEvent.scroll(scrollElement);

    expect(onLoadOlderMessages).not.toHaveBeenCalled();
  });

  it("加载更早消息后保持当前可视内容位置不变", async () => {
    const onLoadOlderMessages = vi.fn();
    const recentMessages: ChatMessage[] = [
      {
        id: "msg_3",
        role: "user",
        parts: [{ type: "text", value: "最近问题" }],
        status: "completed"
      },
      {
        id: "msg_4",
        role: "assistant",
        parts: [{ type: "text", value: "最近回答" }],
        status: "completed"
      }
    ];
    const olderMessages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "user",
        parts: [{ type: "text", value: "更早问题" }],
        status: "completed"
      },
      {
        id: "msg_2",
        role: "assistant",
        parts: [{ type: "text", value: "更早回答" }],
        status: "completed"
      }
    ];
    const { container, rerender } = render(
      <AgentConversation messages={recentMessages} isActive={false} hasMoreMessages onLoadOlderMessages={onLoadOlderMessages} />
    );
    const scrollElement = container.querySelector(".chat-scroll") as HTMLDivElement;
    let scrollHeight = 1000;
    let scrollTop = 120;

    Object.defineProperty(scrollElement, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight
    });
    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = Number(value);
      }
    });

    scrollTop = 48;
    fireEvent.wheel(scrollElement, { deltaY: -120 });
    fireEvent.scroll(scrollElement);

    scrollHeight = 1300;
    rerender(
      <AgentConversation
        messages={[...olderMessages, ...recentMessages]}
        isActive={false}
        hasMoreMessages
        onLoadOlderMessages={onLoadOlderMessages}
      />
    );

    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
    expect(scrollTop).toBe(348);
  });

  it("程序滚到底部时直接定位，不使用 smooth 滚动", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "user",
        parts: [{ type: "text", value: "问题" }],
        status: "completed"
      },
      {
        id: "msg_2",
        role: "assistant",
        parts: [{ type: "text", value: "回答" }],
        status: "completed"
      }
    ];
    const { container, rerender } = render(<AgentConversation messages={[]} isActive={false} />);
    const scrollElement = container.querySelector(".chat-scroll") as HTMLDivElement;
    const scrollTo = vi.fn();
    let scrollTop = 0;

    Object.defineProperty(scrollElement, "scrollHeight", {
      configurable: true,
      get: () => 1200
    });
    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = Number(value);
      }
    });
    Object.defineProperty(scrollElement, "scrollTo", {
      configurable: true,
      value: scrollTo
    });

    rerender(<AgentConversation messages={messages} isActive={false} />);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollTop).toBe(1200);
  });

  it("空状态建议项可以点击并回填输入框", async () => {
    const onSuggestionSelect = vi.fn();

    render(<AgentConversation messages={[]} isActive={false} onSuggestionSelect={onSuggestionSelect} />);

    await userEvent.click(screen.getByRole("button", { name: "现在上海时间是多少？" }));

    expect(onSuggestionSelect).toHaveBeenCalledWith("现在上海时间是多少？");
  });

  it("把 system 消息渲染成居中的轻量状态条，而不是普通气泡", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_system_summary",
        role: "system",
        parts: [{ type: "text", value: "上下文已自动压缩，后续会基于摘要和最近消息继续对话" }],
        status: "completed"
      }
    ];

    const { container } = render(<AgentConversation messages={messages} isActive={false} />);

    expect(screen.getByRole("status")).toHaveTextContent("上下文已自动压缩");
    expect(container.querySelector(".chat-system-row")).toBeInTheDocument();
    expect(container.querySelector(".chat-avatar")).toBeNull();
    expect(container.querySelector(".chat-bubble")).toBeNull();
  });

  it("普通消息不展示头像和昵称，assistant 以无气泡正文展示", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", value: "你好" }],
        status: "completed"
      },
      {
        id: "msg_assistant",
        role: "assistant",
        parts: [{ type: "text", value: "你好，我是回答正文。" }],
        status: "completed"
      }
    ];

    const { container } = render(<AgentConversation messages={messages} isActive={false} />);

    expect(container.querySelector(".chat-scroll > .chat-scroll-content")).toBeInTheDocument();
    expect(container.querySelector(".chat-avatar")).toBeNull();
    expect(container.querySelector(".chat-meta")).toBeNull();
    expect(container.querySelector(".chat-bubble.assistant")).toBeNull();
    expect(container.querySelector(".chat-answer.assistant")).toHaveTextContent("你好，我是回答正文。");
    expect(container.querySelector(".chat-bubble.user")).toHaveTextContent("你好");
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("你")).not.toBeInTheDocument();
  });

  it("renders assistant answers as Markdown", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [{ type: "text", value: "**重点**\n\n- 第一项\n\n```ts\nconst value = 1;\n```" }],
        status: "completed"
      }
    ];

    const { container } = render(<AgentConversation messages={messages} isActive={false} />);

    expect(screen.getByText("重点").tagName.toLowerCase()).toBe("strong");
    expect(screen.getByText("第一项").tagName.toLowerCase()).toBe("li");
    expect(container.querySelector("pre code")).toHaveTextContent("const value = 1;");
  });

  it("renders assistant text and media from message parts", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "**图片已生成。**" },
          {
            type: "media",
            mime: "image/png",
            url: "https://example.com/part-image.png",
            width: 1024,
            height: 768,
            extra: {
              lifecycle: { state: "succeeded" },
              tool: { name: "generate_image", toolCallId: "call_image", outputIndex: 0 },
              generation: { prompt: "田园小猪", provider: "test" }
            }
          }
        ],
        status: "completed"
      }
    ];

    render(<AgentConversation messages={messages} isActive={false} />);

    expect(screen.getByText("图片已生成。").tagName.toLowerCase()).toBe("strong");
    expect(screen.getByRole("img", { name: "田园小猪" })).toHaveAttribute("src", "https://example.com/part-image.png");
  });

  it("在回答主体展示图片预览，工具过程只保留技术轨迹", async () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "我查到了资料，也生成了图片。" },
          {
            type: "media",
            mime: "image/png",
            url: "https://example.com/generated.png",
            extra: {
              lifecycle: { state: "succeeded" },
              tool: { name: "generate_image", toolCallId: "call_image", outputIndex: 0 },
              generation: { prompt: "赛博茶馆", provider: "volcengine_seedream" }
            }
          }
        ],
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
    expect(screen.getByRole("img", { name: "赛博茶馆" })).toHaveAttribute("src", "https://example.com/generated.png");
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
    expect(mainAssetArea?.querySelector('img[alt="赛博茶馆"]')).not.toBeNull();
    expect(toolEventArea?.querySelector('img[alt="赛博茶馆"]')).toBeNull();
  });

  it("工具事件里的图片不会自动变成正文资源", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [{ type: "text", value: "图片已经生成。" }],
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

    const { container } = render(<AgentConversation messages={messages} isActive={false} />);

    expect(screen.getByText("图片已经生成。")).toBeInTheDocument();
    expect(container.querySelector(".message-image-assets")).toBeNull();
  });

  it("图片资源交互按钮浮在图片上并只在 hover 或 focus 时显示", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "图片已生成。" },
          {
            type: "media",
            mime: "image/png",
            url: "https://example.com/generated.png",
            extra: {
              lifecycle: { state: "succeeded" },
              tool: { name: "generate_image", toolCallId: "call_image", outputIndex: 0 },
              generation: { prompt: "小狗", provider: "volcengine_seedream" }
            }
          }
        ],
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
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "图片已生成。" },
          {
            type: "media",
            mime: "image/png",
            url: "https://example.com/generated.png",
            extra: {
              lifecycle: { state: "succeeded" },
              tool: { name: "generate_image", toolCallId: "call_image", outputIndex: 0 },
              generation: { prompt: "小狗", provider: "volcengine_seedream" }
            }
          }
        ],
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

  it("批量生图结果在回答主体展示 media parts", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_2:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "批量图片处理完成。" },
          {
            type: "media",
            mime: "image/png",
            url: "https://example.com/watercolor-pig.png",
            width: 1024,
            height: 1024,
            extra: {
              lifecycle: { state: "succeeded" },
              tool: { name: "generate_image", toolCallId: "call_batch_image", outputIndex: 0 },
              generation: { prompt: "水彩风格的小猪", provider: "volcengine_seedream" }
            }
          }
        ],
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

    expect(screen.getByText("批量图片处理完成。")).toBeInTheDocument();
    expect(screen.getByText("水彩风格的小猪")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "水彩风格的小猪" })).toHaveAttribute(
      "src",
      "https://example.com/watercolor-pig.png"
    );
  });

  it("图片生成成功后通过 media part 展示图片", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_3:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "图片已生成。" },
          {
            type: "media",
            mime: "image/png",
            url: "https://example.com/fast-pixel-pig.png",
            width: 1328,
            height: 1328,
            extra: {
              lifecycle: { state: "succeeded" },
              tool: { name: "generate_image", toolCallId: "call_batch_image", outputIndex: 1 },
              generation: { prompt: "像素小猪", provider: "volcengine_seedream" }
            }
          }
        ],
        status: "completed",
        events: []
      }
    ];

    render(<AgentConversation messages={messages} isActive={false} />);

    expect(screen.getByText("像素小猪")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "像素小猪" })).toHaveAttribute(
      "src",
      "https://example.com/fast-pixel-pig.png"
    );
  });

  it("图片生成中在回答主体展示固定占位 loading", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "我正在为你生成图片" },
          {
            type: "media",
            mime: "image/png",
            url: "",
            width: 1328,
            height: 1328,
            extra: {
              placeholder: { type: "image", label: "图片生成中" },
              lifecycle: { state: "pending" },
              tool: { name: "generate_image", toolCallId: "call_image", outputIndex: 0 },
              generation: { prompt: "粉色小猪", provider: "volcengine_seedream" }
            }
          }
        ],
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
