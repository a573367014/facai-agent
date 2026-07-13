import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAppStyles } from "@/test/read-app-styles";
import { AgentConversation, type ChatMessage } from "./AgentConversation";

const componentPath = join(process.cwd(), "src/features/chat/components/AgentConversation.tsx");
const originalClipboard = navigator.clipboard;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard
  });
  vi.restoreAllMocks();
});

describe("AgentConversation", () => {
  it("在助手消息顶部展示产品化任务进度", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_assistant",
        role: "assistant",
        parts: [{ type: "text", value: "图片已生成。" }],
        status: "running",
        processSteps: [
          {
            id: "step_thinking",
            sessionId: "session_1",
            messageId: "msg_assistant",
            kind: "thinking",
            title: "已理解需求",
            summary: "需要执行 1 项任务",
            status: "succeeded",
            orderIndex: 0,
            startedAt: "2026-06-30T03:00:00.000Z",
            updatedAt: "2026-06-30T03:00:01.000Z"
          },
          {
            id: "step_tool",
            sessionId: "session_1",
            messageId: "msg_assistant",
            kind: "tool",
            title: "正在生成图片",
            summary: "小猪",
            status: "running",
            orderIndex: 1,
            startedAt: "2026-06-30T03:00:01.000Z",
            updatedAt: "2026-06-30T03:00:02.000Z"
          }
        ]
      }
    ];

    render(<AgentConversation messages={messages} isActive />);

    expect(screen.getByText("任务进度")).toBeInTheDocument();
    expect(screen.getByText("已理解需求")).toBeInTheDocument();
    expect(screen.getByText("正在生成图片")).toBeInTheDocument();
    expect(screen.getByText("需要执行 1 项任务")).toBeInTheDocument();
    expect(screen.getByText("小猪")).toBeInTheDocument();
    expect(screen.queryByText("思考过程")).not.toBeInTheDocument();
  });

  it("有任务进度时隐藏重复的状态和工具过程", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_assistant",
        role: "assistant",
        parts: [{ type: "text", value: "正在生成中" }],
        status: "running",
        processSteps: [
          {
            id: "step_tool",
            sessionId: "session_1",
            messageId: "msg_assistant",
            kind: "tool",
            title: "正在生成视频",
            summary: "小动物相遇",
            status: "running",
            orderIndex: 0,
            startedAt: "2026-06-30T03:00:00.000Z",
            updatedAt: "2026-06-30T03:00:01.000Z"
          }
        ],
        events: [
          {
            type: "agent_state",
            iteration: 0,
            state: "calling_tool",
            label: "调用工具 generate_video"
          },
          {
            type: "tool_start",
            iteration: 0,
            toolCallId: "call_video",
            toolName: "generate_video",
            arguments: { prompt: "小动物相遇" }
          }
        ]
      }
    ];

    render(<AgentConversation messages={messages} isActive />);

    expect(screen.getByText("任务进度")).toBeInTheDocument();
    expect(screen.getByText("正在生成视频")).toBeInTheDocument();
    expect(screen.queryByText("工具过程")).not.toBeInTheDocument();
    expect(screen.queryByText("调用工具")).not.toBeInTheDocument();
  });

  it("完成后的助手消息仍保留任务进度摘要", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_assistant",
        role: "assistant",
        parts: [{ type: "text", value: "最终答案" }],
        status: "completed",
        processSteps: [
          {
            id: "step_thinking",
            sessionId: "session_1",
            messageId: "msg_assistant",
            kind: "thinking",
            title: "已生成回答",
            status: "succeeded",
            orderIndex: 0,
            startedAt: "2026-06-30T03:00:00.000Z",
            updatedAt: "2026-06-30T03:00:01.000Z",
            completedAt: "2026-06-30T03:00:01.000Z"
          }
        ]
      }
    ];

    render(<AgentConversation messages={messages} isActive={false} />);

    expect(screen.getByText("任务进度")).toBeInTheDocument();
    expect(screen.getByText("已完成 1 步")).toBeInTheDocument();
    expect(screen.getByText("最终答案")).toBeInTheDocument();
  });

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

  it("流式输出更新前不在底部时，后续更新不自动滚到底部", () => {
    const runningMessage: ChatMessage = {
      id: "msg_assistant_running",
      role: "assistant",
      parts: [{ type: "text", value: "第一段" }],
      status: "running"
    };
    const { container, rerender } = render(<AgentConversation messages={[runningMessage]} isActive />);
    const scrollElement = container.querySelector(".chat-scroll") as HTMLDivElement;
    let scrollHeight = 900;
    let scrollTop = 0;
    let clientHeight = 300;

    Object.defineProperty(scrollElement, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight
    });
    Object.defineProperty(scrollElement, "clientHeight", {
      configurable: true,
      get: () => clientHeight
    });
    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = Number(value);
      }
    });

    scrollTop = 500;
    scrollHeight = 1000;
    fireEvent.scroll(scrollElement);

    scrollHeight = 1500;
    rerender(
      <AgentConversation
        messages={[{ ...runningMessage, parts: [{ type: "text", value: "第一段，第二段" }], version: 2 }]}
        isActive
      />
    );

    expect(scrollTop).toBe(500);
  });

  it("用户重新回到底部后，流式输出会继续自动滚到底部", () => {
    const runningMessage: ChatMessage = {
      id: "msg_assistant_running",
      role: "assistant",
      parts: [{ type: "text", value: "第一段" }],
      status: "running"
    };
    const { container, rerender } = render(<AgentConversation messages={[runningMessage]} isActive />);
    const scrollElement = container.querySelector(".chat-scroll") as HTMLDivElement;
    let scrollHeight = 1000;
    let scrollTop = 0;
    const clientHeight = 300;

    Object.defineProperty(scrollElement, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight
    });
    Object.defineProperty(scrollElement, "clientHeight", {
      configurable: true,
      get: () => clientHeight
    });
    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = Number(value);
      }
    });

    scrollTop = 520;
    scrollHeight = 1300;
    fireEvent.scroll(scrollElement);

    expect(scrollTop).toBe(520);

    scrollTop = 1000;
    fireEvent.scroll(scrollElement);
    scrollHeight = 1700;
    rerender(
      <AgentConversation
        messages={[{ ...runningMessage, parts: [{ type: "text", value: "第一段，第二段" }], version: 2 }]}
        isActive
      />
    );

    expect(scrollTop).toBe(1700);
  });

  it("空状态建议项可以点击并回填输入框", async () => {
    const onSuggestionSelect = vi.fn();

    render(<AgentConversation messages={[]} isActive={false} onSuggestionSelect={onSuggestionSelect} />);

    expect(screen.getAllByRole("button")).toHaveLength(4);
    await userEvent.click(screen.getByRole("button", { name: "查资料：搜索并整理关键信息" }));

    expect(onSuggestionSelect).toHaveBeenCalledWith("帮我搜索并整理一项主题的关键信息");
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

  it("按相对日期规则展示消息时间", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T11:00:00+08:00"));
    const messages: ChatMessage[] = [
      {
        id: "msg_today",
        role: "user",
        parts: [{ type: "text", value: "今天" }],
        status: "completed",
        createdAt: "2026-06-29T10:15:00+08:00"
      },
      {
        id: "msg_month",
        role: "assistant",
        parts: [{ type: "text", value: "本月" }],
        status: "completed",
        createdAt: "2026-06-12T08:05:00+08:00"
      },
      {
        id: "msg_year",
        role: "user",
        parts: [{ type: "text", value: "本年" }],
        status: "completed",
        createdAt: "2026-05-02T09:06:00+08:00"
      },
      {
        id: "msg_old",
        role: "assistant",
        parts: [{ type: "text", value: "跨年" }],
        status: "completed",
        createdAt: "2025-12-31T23:59:00+08:00"
      }
    ];

    render(<AgentConversation messages={messages} isActive={false} />);

    expect(screen.getByText("10:15")).toBeInTheDocument();
    expect(screen.getByText("12日 08:05")).toBeInTheDocument();
    expect(screen.getByText("5月2日 09:06")).toBeInTheDocument();
    expect(screen.getByText("2025年12月31日 23:59")).toBeInTheDocument();
  });

  it("消息时间展示在底部 meta 行，和 hover 动作按钮同层", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T11:00:00+08:00"));
    const messages: ChatMessage[] = [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", value: "问题" }],
        status: "completed",
        createdAt: "2026-06-29T10:15:00+08:00"
      },
      {
        id: "msg_assistant",
        role: "assistant",
        parts: [{ type: "text", value: "回答" }],
        status: "completed",
        createdAt: "2026-06-29T10:16:00+08:00"
      }
    ];

    const { container } = render(<AgentConversation messages={messages} isActive={false} onRegenerateMessage={vi.fn()} />);
    const userMeta = container.querySelector(".chat-row.user .message-meta-row");
    const assistantMeta = container.querySelector(".chat-row.assistant .message-meta-row");
    const styles = readAppStyles();
    const componentSource = readFileSync(componentPath, "utf8");

    expect(userMeta?.querySelector(".message-timestamp")).toHaveTextContent("10:15");
    expect(userMeta?.querySelector(".message-actions.user-actions")).toBeInTheDocument();
    expect(assistantMeta?.querySelector(".message-timestamp")).toHaveTextContent("10:16");
    expect(assistantMeta?.querySelector(".message-actions.assistant-actions")).toContainElement(
      screen.getByRole("button", { name: "重新生成" })
    );
    expect(styles).toMatch(/\.message-meta-row\s*{[^}]*top:\s*100%;[^}]*padding-top:\s*6px;[^}]*opacity:\s*0;[^}]*pointer-events:\s*auto;[^}]*transform:\s*translateY\(-4px\);/s);
    expect(styles).toMatch(/\.message-action-button\.message-action-button\.MuiIconButton-root\s*{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
    expect(componentSource).toContain("offset: [0, -8]");
    expect(componentSource.match(/slotProps={messageActionTooltipSlotProps}/g)).toHaveLength(3);
    expect(styles).toMatch(/\.chat-row\.assistant:hover\s+\.message-meta-row/s);
    expect(styles).toMatch(/\.chat-row\.user:hover\s+\.message-meta-row/s);
  });

  it("user 消息支持复制文本", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    const messages: ChatMessage[] = [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", value: "原理是啥，怎么拿到这些爆款的" }],
        status: "completed"
      }
    ];

    render(<AgentConversation messages={messages} isActive={false} />);

    await userEvent.click(screen.getByRole("button", { name: "复制消息" }));

    expect(writeText).toHaveBeenCalledWith("原理是啥，怎么拿到这些爆款的");
  });

  it("user 消息点击复制时把完整 parts 交给底部输入框复用", async () => {
    const onReuseUserMessage = vi.fn();
    const messages: ChatMessage[] = [
      {
        id: "msg_user",
        role: "user",
        parts: [
          { type: "text", value: "你能告诉我这是什么吗 " },
          {
            type: "resource",
            mime: "image/png",
            url: "https://example.com/screenshot.png",
            name: "截图2026-06-29.png",
            size: 123,
            width: 640,
            height: 480,
            extra: {
              lifecycle: { state: "succeeded" }
            }
          }
        ],
        status: "completed"
      }
    ];

    render(<AgentConversation messages={messages} isActive={false} onReuseUserMessage={onReuseUserMessage} />);

    await userEvent.click(screen.getByRole("button", { name: "复制消息" }));

    expect(onReuseUserMessage).toHaveBeenCalledWith(messages[0].parts);
  });

  it("user resource part 使用输入框同款 chip 渲染，不进入 assistant 图片画廊", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_user",
        role: "user",
        parts: [
          { type: "text", value: "你能告诉我这是什么吗 " },
          {
            type: "resource",
            mime: "image/png",
            url: "https://example.com/screenshot.png",
            name: "截图2026-06-29.png",
            size: 123
          }
        ],
        status: "completed"
      }
    ];

    const { container } = render(<AgentConversation messages={messages} isActive={false} />);

    expect(container.querySelector(".chat-row.user .pm-part--resource")).toHaveTextContent("截图2026-06-29.png");
    expect(container.querySelector(".chat-row.user .message-resource-gallery")).toBeNull();
    expect(container.querySelector(".chat-row.user .user-part-surface")).toBeInTheDocument();
  });

  it("消息块之间保留足够的垂直间距", () => {
    const styles = readAppStyles();

    expect(styles).toMatch(/\.chat-scroll-content\s*{[^}]*gap:\s*65px;/s);
  });

  it("已结束的 assistant 消息可以触发重新生成", async () => {
    const onRegenerateMessage = vi.fn();
    const messages: ChatMessage[] = [
      {
        id: "msg_assistant",
        role: "assistant",
        parts: [{ type: "text", value: "旧回答" }],
        status: "completed"
      }
    ];

    render(<AgentConversation messages={messages} isActive={false} onRegenerateMessage={onRegenerateMessage} />);

    await userEvent.click(screen.getByRole("button", { name: "重新生成" }));

    expect(onRegenerateMessage).toHaveBeenCalledWith("msg_assistant");
  });

  it("assistant 重新生成入口沿用消息 hover 动作条并放在底部左下角", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_assistant",
        role: "assistant",
        parts: [{ type: "text", value: "旧回答" }],
        status: "completed"
      }
    ];
    const styles = readAppStyles();

    const { container } = render(<AgentConversation messages={messages} isActive={false} onRegenerateMessage={vi.fn()} />);
    const assistantActions = container.querySelector(".chat-row.assistant .message-actions.assistant-actions");

    expect(assistantActions).toContainElement(screen.getByRole("button", { name: "重新生成" }));
    expect(styles).toMatch(/\.chat-row\.assistant\s+\.message-meta-row\s*{[^}]*left:\s*0;[^}]*justify-content:\s*flex-start;/s);
    expect(styles).toMatch(/\.chat-row\.assistant:hover\s+\.message-meta-row/s);
  });

  it("运行中的 assistant 消息不展示重新生成入口", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_assistant",
        role: "assistant",
        parts: [{ type: "text", value: "" }],
        status: "running"
      }
    ];

    render(<AgentConversation messages={messages} isActive onRegenerateMessage={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "重新生成" })).not.toBeInTheDocument();
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

  it("renders assistant text and resource from message parts", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "**图片已生成。**" },
          {
            type: "resource",
            mime: "image/png",
            url: "https://example.com/part-image.png",
            width: 1024,
            height: 768,
            extra: {
              lifecycle: { state: "succeeded" },
              resource: { id: "res_image" },
              tool: { name: "generate_image", toolCallId: "call_image", toolCallRowId: "tool_call_image", outputIndex: 0 },
              generation: { prompt: "田园小猪", provider: "test" }
            }
          }
        ],
        status: "completed"
      }
    ];

    render(
      <AgentConversation
        messages={messages}
        resourcesById={{
          res_image: {
            id: "res_image",
            sessionId: "session_1",
            messageId: "msg_1:assistant",
            toolCallId: "call_image",
            toolCallRowId: "tool_call_image",
            type: "image",
            mime: "image/png",
            status: "succeeded",
            url: "https://example.com/part-image.png",
            width: 1024,
            height: 768,
            metadata: { prompt: "田园小猪", provider: "test" },
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:01.000Z"
          }
        }}
        isActive={false}
      />
    );

    expect(screen.getByText("图片已生成。").tagName.toLowerCase()).toBe("strong");
    expect(screen.getByRole("img", { name: "田园小猪" })).toHaveAttribute("src", "https://example.com/part-image.png");
  });

  it("resource part 缺少 URL 时不从 resources 兜底展示图片", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "图片已生成。" },
          {
            type: "resource",
            mime: "image/png",
            extra: {
              lifecycle: { state: "succeeded" },
              resource: { id: "res_image" },
              tool: { name: "generate_image", toolCallId: "call_image", toolCallRowId: "tool_call_image", outputIndex: 0 },
              generation: { prompt: "田园小猪", provider: "test" }
            }
          }
        ],
        status: "completed"
      }
    ];

    const { container } = render(
      <AgentConversation
        messages={messages}
        resourcesById={{
          res_image: {
            id: "res_image",
            sessionId: "session_1",
            messageId: "msg_1:assistant",
            toolCallId: "call_image",
            toolCallRowId: "tool_call_image",
            type: "image",
            mime: "image/png",
            status: "succeeded",
            url: "https://example.com/resource-only-image.png",
            width: 1024,
            height: 768,
            metadata: { prompt: "田园小猪", provider: "test" },
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:01.000Z"
          }
        }}
        isActive={false}
      />
    );

    const gallery = container.querySelector(".message-resource-gallery");

    expect(screen.queryByRole("img", { name: "田园小猪" })).not.toBeInTheDocument();
    expect(gallery).toHaveTextContent("生成失败");
    expect(gallery).not.toHaveTextContent("图片资源缺少地址");
  });

  it("resource part 失败卡片不展示具体错误原因", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "如果需要，我可以帮你重新调整提示词。原因：HTTP 429: Request Has Reached API Concurrent Limit" },
          {
            type: "resource",
            mime: "image/png",
            width: 1024,
            height: 1024,
            extra: {
              lifecycle: {
                state: "failed",
                error: { code: "IMAGE_GENERATION_FAILED", message: "HTTP 429: Request Has Reached API Concurrent Limit" }
              },
              tool: { name: "generate_image", toolCallId: "call_image", outputIndex: 0 },
              generation: { prompt: "水彩风格的小猪", provider: "test" }
            }
          }
        ],
        status: "completed"
      }
    ];

    const { container } = render(<AgentConversation messages={messages} isActive={false} />);
    const markdown = container.querySelector(".markdown-body");
    const gallery = container.querySelector(".message-resource-gallery");

    expect(markdown).not.toBeNull();
    expect(within(markdown as HTMLElement).getByText(/HTTP 429: Request Has Reached API Concurrent Limit/)).toBeInTheDocument();
    expect(gallery).not.toBeNull();
    expect(gallery?.querySelector(".message-resource-failed-icon")).not.toBeNull();
    expect(within(gallery as HTMLElement).getByText("生成失败")).toBeInTheDocument();
    expect(gallery).not.toHaveTextContent("HTTP 429");
    expect(gallery).not.toHaveTextContent("Request Has Reached API Concurrent Limit");
  });

  it("renders assistant video resource from message parts", async () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "视频已生成。" },
          {
            type: "resource",
            mime: "video/mp4",
            url: "https://example.com/part-video.mp4",
            extra: {
              lifecycle: { state: "succeeded" },
              resource: { id: "res_video" },
              tool: { name: "generate_video", toolCallId: "call_video", toolCallRowId: "tool_call_video", outputIndex: 0 },
              generation: { prompt: "田园小猪视频", provider: "test" }
            }
          }
        ],
        status: "completed"
      }
    ];

    render(
      <AgentConversation
        messages={messages}
        resourcesById={{
          res_video: {
            id: "res_video",
            sessionId: "session_1",
            messageId: "msg_1:assistant",
            toolCallId: "call_video",
            toolCallRowId: "tool_call_video",
            type: "video",
            mime: "video/mp4",
            status: "succeeded",
            url: "https://example.com/part-video.mp4",
            metadata: { prompt: "田园小猪视频", provider: "test" },
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:01.000Z"
          }
        }}
        isActive={false}
      />
    );

    expect(screen.getByText("视频已生成。")).toBeInTheDocument();
    const thumbnailVideo = screen.getByLabelText("田园小猪视频") as HTMLVideoElement;

    expect(thumbnailVideo).toHaveAttribute("src", "https://example.com/part-video.mp4");
    expect(thumbnailVideo.closest(".message-resource-tile")).toHaveClass("video");
    expect(thumbnailVideo.autoplay).toBe(true);
    expect(thumbnailVideo.muted).toBe(true);
    expect(thumbnailVideo.loop).toBe(true);
    expect(thumbnailVideo.playsInline).toBe(true);
    expect(screen.getByRole("link", { name: "下载视频 1" })).toHaveAttribute("href", "https://example.com/part-video.mp4");

    await userEvent.click(screen.getByRole("button", { name: "更多视频操作 1" }));

    expect(screen.getByRole("menuitem", { name: "复制视频链接 1" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "引用视频 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "打开原视频 1" })).toHaveAttribute("href", "https://example.com/part-video.mp4");
  });

  it("generated video resource opens a large autoplay preview", async () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          {
            type: "resource",
            mime: "video/mp4",
            url: "https://example.com/part-video.mp4",
            extra: {
              lifecycle: { state: "succeeded" },
              resource: { id: "res_video" },
              tool: { name: "generate_video", toolCallId: "call_video", toolCallRowId: "tool_call_video", outputIndex: 0 },
              generation: { prompt: "田园小猪视频", provider: "test" }
            }
          }
        ],
        status: "completed"
      }
    ];

    render(<AgentConversation messages={messages} isActive={false} />);

    await userEvent.click(screen.getByRole("button", { name: "预览视频 1" }));

    const dialog = screen.getByRole("dialog", { name: "视频预览" });
    const previewVideo = within(dialog).getByLabelText("田园小猪视频预览") as HTMLVideoElement;

    expect(previewVideo).toHaveAttribute("src", "https://example.com/part-video.mp4");
    expect(previewVideo.controls).toBe(true);
    expect(previewVideo.autoplay).toBe(true);
    expect(previewVideo.muted).toBe(true);
    expect(previewVideo.playsInline).toBe(true);
  });

  it("renders generated document resource as a file card with preview and download actions", async () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "文档已生成。" },
          {
            type: "resource",
            mime: "text/markdown",
            url: "https://example.com/resources/documents/review.md",
            name: "年度复盘.md",
            extra: {
              lifecycle: { state: "succeeded" },
              resource: { id: "res_doc" },
              tool: { name: "generate_document", toolCallId: "call_doc", toolCallRowId: "tool_call_doc", outputIndex: 0 },
              generation: { provider: "agent_document" }
            }
          }
        ],
        status: "completed"
      }
    ];

    render(
      <AgentConversation
        messages={messages}
        resourcesById={{
          res_doc: {
            id: "res_doc",
            sessionId: "session_1",
            messageId: "msg_1:assistant",
            toolCallId: "call_doc",
            toolCallRowId: "tool_call_doc",
            type: "document",
            mime: "text/markdown",
            status: "succeeded",
            url: "https://example.com/resources/documents/review.md",
            name: "年度复盘.md",
            metadata: { provider: "agent_document" },
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:01.000Z"
          }
        }}
        isActive={false}
      />
    );

    expect(screen.getByText("文档已生成。")).toBeInTheDocument();
    expect(screen.getByText("年度复盘.md")).toBeInTheDocument();
    expect(screen.getByText("Markdown")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览文档 1" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载文档 1" })).toHaveAttribute(
      "href",
      "https://example.com/resources/documents/review.md"
    );

    await userEvent.click(screen.getByRole("button", { name: "预览文档 1" }));

    expect(screen.getByRole("dialog", { name: "资源预览" })).toBeInTheDocument();
  });

  it("按 assistant message parts 原始顺序渲染资源和后续文本", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          {
            type: "resource",
            mime: "image/png",
            url: "https://example.com/generated.png",
            extra: {
              lifecycle: { state: "succeeded" },
              generation: { prompt: "先生成的图片", provider: "test" }
            }
          },
          { type: "text", value: "后续总结文本" }
        ],
        status: "completed"
      }
    ];

    const { container } = render(<AgentConversation messages={messages} isActive={false} />);
    const body = container.querySelector(".chat-answer");
    const children = Array.from(body?.children ?? []);
    const galleryIndex = children.findIndex((child) => child.classList.contains("message-resource-gallery"));
    const markdownIndex = children.findIndex((child) => child.classList.contains("markdown-body"));

    expect(galleryIndex).toBeGreaterThanOrEqual(0);
    expect(markdownIndex).toBeGreaterThanOrEqual(0);
    expect(galleryIndex).toBeLessThan(markdownIndex);
    expect(screen.getByText("后续总结文本")).toBeInTheDocument();
  });

  it("在回答主体展示图片预览，不再展示工具过程兜底", async () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "我查到了资料，也生成了图片。" },
          {
            type: "resource",
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

    expect(screen.getByRole("img", { name: "赛博茶馆" })).toHaveAttribute("src", "https://example.com/generated.png");
    expect(screen.getByRole("button", { name: "预览图片 1" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载图片 1" })).toHaveAttribute("href", "https://example.com/generated.png");
    expect(screen.getByRole("button", { name: "更多图片操作 1" })).toBeInTheDocument();
    expect(screen.queryByText("工具过程")).not.toBeInTheDocument();
    expect(container.querySelector(".MuiAccordion-root.tool-events")).toBeNull();
    expect(screen.queryByText("web_search")).not.toBeInTheDocument();
    expect(screen.queryByText("来源 1 条")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Fastify" })).not.toBeInTheDocument();
    expect(screen.queryByText("generate_image")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "更多图片操作 1" }));

    expect(document.body.querySelector(".MuiMenu-root")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "复制图片链接 1" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "引用图片 1" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "打开原图 1" })).toHaveAttribute("href", "https://example.com/generated.png");

    const mainAssetArea = container.querySelector(".message-resource-gallery");

    expect(mainAssetArea).not.toBeNull();
    expect(mainAssetArea?.querySelector('img[alt="赛博茶馆"]')).not.toBeNull();
  });

  it("关闭正文图片更多菜单后不会把焦点还给更多按钮", async () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "图片已生成。" },
          {
            type: "resource",
            mime: "image/png",
            url: "https://example.com/generated.png",
            extra: {
              lifecycle: { state: "succeeded" },
              tool: { name: "generate_image", toolCallId: "call_image", outputIndex: 0 },
              generation: { prompt: "赛博茶馆" }
            }
          }
        ],
        status: "completed"
      }
    ];

    render(<AgentConversation messages={messages} isActive={false} />);
    const moreButton = screen.getByRole("button", { name: "更多图片操作 1" });

    await userEvent.click(moreButton);
    expect(screen.getByRole("menuitem", { name: "复制图片链接 1" })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "复制图片链接 1" })).not.toBeInTheDocument());

    expect(document.activeElement).not.toBe(moreButton);
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
    expect(container.querySelector(".message-resource-gallery")).toBeNull();
  });

  it("正文图片使用左对齐的固定上限画廊，长边铺满且短边自适应", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "图片已生成。" },
          {
            type: "resource",
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
    const gallery = container.querySelector(".message-resource-gallery");
    const tile = container.querySelector(".message-resource-tile");
    const frame = container.querySelector(".message-resource-frame");
    const actions = screen.getByRole("link", { name: "下载图片 1" }).closest(".message-resource-actions");

    expect(gallery).toHaveClass("single");
    expect(tile).not.toBeNull();
    expect(frame).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(frame?.contains(actions)).toBe(true);

    const styles = readAppStyles();
    expect(styles).toMatch(/\.message-resource-gallery\s*{[^}]*justify-content:\s*start;/s);
    expect(styles).toMatch(/\.message-resource-tile\s*{[^}]*max-width:\s*300px;/s);
    expect(styles).toMatch(/\.message-resource-frame\s*{[^}]*max-width:\s*300px;[^}]*max-height:\s*300px;/s);
    expect(styles).toMatch(/\.message-resource-frame img\s*{[^}]*object-fit:\s*contain;/s);
    expect(styles).toMatch(/\.message-resource-actions\s*{[^}]*position:\s*absolute;[^}]*opacity:\s*0;/s);
    expect(styles).toMatch(/\.message-resource-tile:hover\s+\.message-resource-actions/s);
    expect(styles).toMatch(/\.message-resource-tile:focus-within\s+\.message-resource-actions/s);
    expect(screen.getByRole("button", { name: "更多图片操作 1" })).toHaveClass("MuiIconButton-root");
  });

  it("正文视频操作按钮默认可见，避免点击视频只触发播放", () => {
    const styles = readAppStyles();

    expect(styles).toMatch(/\.message-resource-tile\.video\s+\.message-resource-actions\s*{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s);
  });

  it("多张正文图片复用同一套左对齐画廊布局", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "图片已生成。" },
          {
            type: "resource",
            mime: "image/png",
            url: "https://example.com/landscape.png",
            width: 1024,
            height: 768,
            extra: {
              lifecycle: { state: "succeeded" },
              tool: { name: "generate_image", toolCallId: "call_image", outputIndex: 0 },
              generation: { prompt: "横图", provider: "volcengine_seedream" }
            }
          },
          {
            type: "resource",
            mime: "image/png",
            url: "https://example.com/portrait.png",
            width: 768,
            height: 1024,
            extra: {
              lifecycle: { state: "succeeded" },
              tool: { name: "generate_image", toolCallId: "call_image", outputIndex: 1 },
              generation: { prompt: "竖图", provider: "volcengine_seedream" }
            }
          }
        ],
        status: "completed"
      }
    ];

    const { container } = render(<AgentConversation messages={messages} isActive={false} />);

    expect(container.querySelector(".message-resource-gallery")).toHaveClass("multi");
    expect(container.querySelectorAll(".message-resource-tile")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "横图" })).toHaveAttribute("src", "https://example.com/landscape.png");
    expect(screen.getByRole("img", { name: "竖图" })).toHaveAttribute("src", "https://example.com/portrait.png");
  });

  it("图片点击预览使用 MUI Dialog 承载", async () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "图片已生成。" },
          {
            type: "resource",
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
    const styles = readAppStyles();
    const imageRule = styles.match(/\n\.message-resource-frame img\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const mainImageRule = styles.match(/\.message-resource-frame\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";

    expect(imageRule).not.toContain("aspect-ratio: 1 / 1");
    expect(mainImageRule).not.toContain("object-fit: cover");
    expect(imageRule).toContain("height: auto");
    expect(imageRule).toContain("object-fit: contain");
  });

  it("批量生图结果在回答主体展示 resource parts", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_2:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "批量图片处理完成。" },
          {
            type: "resource",
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

    const { container } = render(<AgentConversation messages={messages} isActive={false} />);

    expect(screen.getByText("批量图片处理完成。")).toBeInTheDocument();
    expect(container.querySelector(".message-resource-gallery")).not.toHaveTextContent("水彩风格的小猪");
    expect(container.querySelector(".message-resource-caption")).toBeNull();
    expect(screen.getByRole("img", { name: "水彩风格的小猪" })).toHaveAttribute(
      "src",
      "https://example.com/watercolor-pig.png"
    );
  });

  it("图片生成成功后通过 resource part 展示图片", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_3:assistant",
        role: "assistant",
        parts: [
          { type: "text", value: "图片已生成。" },
          {
            type: "resource",
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

    const { container } = render(<AgentConversation messages={messages} isActive={false} />);

    expect(container.querySelector(".message-resource-gallery")).not.toHaveTextContent("像素小猪");
    expect(container.querySelector(".message-resource-caption")).toBeNull();
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
            type: "resource",
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

    const mainAssetArea = container.querySelector(".message-resource-gallery");
    const toolEventArea = container.querySelector(".tool-events");

    expect(mainAssetArea).not.toBeNull();
    expect(mainAssetArea?.textContent).toContain("正在生成图片");
    expect(mainAssetArea).not.toHaveTextContent("粉色小猪");
    expect(container.querySelector(".message-resource-caption")).toBeNull();
    expect(container.textContent).not.toContain("Seedream");
    expect(toolEventArea).toBeNull();
  });
});
