import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const originalFetch = globalThis.fetch;
const stylesPath = join(process.cwd(), "src/styles.css");

function createSseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(events.map((event) => `data: ${event}\n\n`).join("")));
        controller.close();
      }
    })
  } as Response;
}

const timestamp = "2026-06-22T00:00:00.000Z";

function createUserMessage(sessionId: string, content: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `msg_user_${sessionId}`,
    sessionId,
    role: "user",
    status: "completed",
    parts: [{ type: "text", value: content }],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function createAssistantMessage(
  sessionId: string,
  content: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: `msg_assistant_${sessionId}`,
    sessionId,
    role: "assistant",
    status: "completed",
    parts: [{ type: "text", value: content }],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function createSystemMessage(sessionId: string, content: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `msg_system_${sessionId}`,
    sessionId,
    role: "system",
    status: "completed",
    parts: [{ type: "text", value: content }],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function createStartMessageResponse({
  sessionId = "session_1",
  input,
  assistantMessageId = "msg_1"
}: {
  sessionId?: string;
  input: string;
  assistantMessageId?: string;
}) {
  const userMessage = createUserMessage(sessionId, input, { id: `${assistantMessageId}:user` });

  return {
    session: { id: sessionId },
    run: {
      id: assistantMessageId,
      sessionId,
      status: "running",
      phase: "compressing",
      userMessageId: userMessage.id,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    userMessage,
    assistantMessage: createAssistantMessage(sessionId, "", {
      id: assistantMessageId,
      status: "running",
      updatedAt: timestamp
    })
  };
}

function createStoredSseResponse(messageId: string, events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        const hasAssistantCreated = events.some(
          (event) =>
            event.type === "session.message.created" &&
            typeof event.message === "object" &&
            event.message !== null &&
            "id" in event.message &&
            event.message.id === messageId
        );
        const eventsWithAssistant = hasAssistantCreated
          ? events
          : [
              {
                type: "session.message.created",
                message: createAssistantMessage("session_1", "", { id: messageId, status: "running" })
              },
              ...events
            ];
        const blocks = eventsWithAssistant
          .map((event, index) => {
            const seq = index + 1;
            const storedEvent = {
              id: `event_${seq}`,
              seq,
              runId: messageId,
              messageId,
              event,
              createdAt: "2026-06-22T00:00:00.000Z"
            };
            return `id: ${seq}\ndata: ${JSON.stringify(storedEvent)}\n\n`;
          })
          .join("");
        controller.enqueue(encoder.encode(blocks));
        controller.close();
      }
    })
  } as Response;
}

function createControlledStoredSseResponse(messageId: string) {
  const encoder = new TextEncoder();
  let seq = 0;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const writeEvent = (event: Record<string, unknown>) => {
    seq += 1;
    const storedEvent = {
      id: `event_${seq}`,
      seq,
      runId: messageId,
      messageId,
      event,
      createdAt: "2026-06-22T00:00:00.000Z"
    };
    streamController?.enqueue(encoder.encode(`id: ${seq}\ndata: ${JSON.stringify(storedEvent)}\n\n`));
  };
  const response = {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        writeEvent({
          type: "session.message.created",
          message: createAssistantMessage("session_1", "", { id: messageId, status: "running" })
        });
      }
    })
  } as Response;

  return {
    response,
    emit(event: Record<string, unknown>) {
      writeEvent(event);
    },
    close() {
      streamController?.close();
    }
  };
}

function createOpenSseResponse(): Response {
  return {
    ok: true,
    body: new ReadableStream()
  } as Response;
}

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    json: async () => payload
  } as Response;
}

function okResponse(): Response {
  return {
    ok: true
  } as Response;
}

function mockAppFetch(handler?: (url: string, init?: RequestInit) => Response | undefined) {
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const customResponse = handler?.(url, init);

    if (customResponse) {
      return Promise.resolve(customResponse);
    }

    if (url.endsWith("/health")) {
      return Promise.resolve(okResponse());
    }

    if (url.endsWith("/agents/sessions") && (!init?.method || init.method === "GET")) {
      return Promise.resolve(jsonResponse({ sessions: [] }));
    }

    return Promise.reject(new Error(`未 mock 的请求：${url}`));
  });
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("App", () => {
  it("消息列使用顶部标题、消息区、底部输入框的三段式布局", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).toMatch(/\.chat-main,\s*\.response-column\s*{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto;/s);
    expect(styles).toMatch(/\.chat-scroll\s*{[^}]*overflow:\s*auto;/s);
    expect(styles).toMatch(/\.chat-composer\s*{[^}]*margin:\s*5px auto 12px;/s);
  });

  it("使用全屏三栏工作台布局", () => {
    mockAppFetch();

    const { container } = render(<App />);

    expect(container.querySelector(".fullscreen-shell")).toBeInTheDocument();
    expect(container.querySelector(".session-sidebar")).toBeInTheDocument();
    expect(container.querySelector(".chat-main")).toBeInTheDocument();
    expect(container.querySelector(".response-column")).toBeInTheDocument();
    expect(container.querySelector(".trace-column")).toBeInTheDocument();
    expect(container.querySelector(".chat-composer")).toBeInTheDocument();
    expect(screen.queryByText("Runtime")).not.toBeInTheDocument();
  });

  it("左右侧栏可以折叠和展开", async () => {
    mockAppFetch();

    const user = userEvent.setup();
    const { container } = render(<App />);
    const workspace = container.querySelector(".workspace");
    const header = container.querySelector(".chat-main-header");

    expect(workspace).not.toHaveClass("sidebar-collapsed");
    expect(workspace).not.toHaveClass("trace-collapsed");
    expect(header).toContainElement(screen.getByRole("button", { name: "收起会话栏" }));
    expect(header).toContainElement(screen.getByRole("button", { name: "收起事件时间线" }));

    await user.click(screen.getByRole("button", { name: "收起会话栏" }));
    expect(workspace).toHaveClass("sidebar-collapsed");
    expect(screen.getByRole("button", { name: "展开会话栏" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "收起事件时间线" }));
    expect(workspace).toHaveClass("trace-collapsed");
    expect(screen.getByRole("button", { name: "展开事件时间线" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开会话栏" }));
    await user.click(screen.getByRole("button", { name: "展开事件时间线" }));

    expect(workspace).not.toHaveClass("sidebar-collapsed");
    expect(workspace).not.toHaveClass("trace-collapsed");
  });

  it("刷新进入页面时输入框不预填示例任务", () => {
    mockAppFetch();

    const { container } = render(<App />);

    expect(screen.getByLabelText("发消息")).toHaveTextContent("");
    expect(screen.getByPlaceholderText("发消息...")).toBeInTheDocument();
  });

  it("左侧展示会话入口和后端会话记录，输入框固定在中间主区", async () => {
    window.history.replaceState(null, "", "/?sessionId=session_from_url");
    mockAppFetch((url) => {
      if (url.endsWith("/agents/sessions/session_from_url")) {
        return jsonResponse({
          session: {
            id: "session_from_url",
            title: "URL 会话",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:00.000Z"
          },
          messages: [
            createUserMessage("session_from_url", "从 URL 恢复", { id: "msg_user_from_url" }),
            createAssistantMessage("session_from_url", "URL 会话回答", {
              id: "msg_assistant_from_url",
              completedAt: "2026-06-22T00:00:01.000Z"
            })
          ]
        });
      }

      if (url.endsWith("/agents/sessions")) {
        return jsonResponse({
          sessions: [
            {
              id: "session_from_url",
              title: "URL 会话",
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:01.000Z"
            },
            {
              id: "session_other",
              title: "另一个会话",
              createdAt: "2026-06-21T00:00:00.000Z",
              updatedAt: "2026-06-21T00:00:01.000Z"
            }
          ]
        });
      }

      return undefined;
    });

    const { container } = render(<App />);

    await waitFor(() => expect(screen.getByRole("button", { name: "URL 会话" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "另一个会话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeInTheDocument();
    expect(screen.getByLabelText("搜索会话")).toBeInTheDocument();
    expect(container.querySelector(".chat-composer")).toContainElement(screen.getByLabelText("发消息"));
    expect(container.querySelector(".session-sidebar")).not.toContainElement(screen.getByLabelText("发消息"));
  });

  it("点击左侧会话会恢复对应消息并同步 URL", async () => {
    mockAppFetch((url) => {
      if (url.endsWith("/agents/sessions/session_a")) {
        return jsonResponse({
          session: {
            id: "session_a",
            title: "产品方案",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:01.000Z"
          },
          messages: [
            createUserMessage("session_a", "整理产品方案", { id: "msg_user_a" }),
            createAssistantMessage("session_a", "产品方案内容", {
              id: "msg_assistant_a",
              completedAt: "2026-06-22T00:00:01.000Z"
            })
          ]
        });
      }

      if (url.endsWith("/agents/sessions")) {
        return jsonResponse({
          sessions: [
            {
              id: "session_a",
              title: "产品方案",
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:01.000Z"
            }
          ]
        });
      }

      return undefined;
    });

    const { container } = render(<App />);

    await waitFor(() => expect(screen.getByRole("button", { name: "产品方案" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "产品方案" }));

    await waitFor(() => expect(screen.getByText("产品方案内容")).toBeInTheDocument());
    expect(window.location.search).toBe("?sessionId=session_a");
  });

  it("打开长会话时只展示最近消息页，并可按游标加载更早消息", async () => {
    mockAppFetch((url) => {
      if (url.endsWith("/agents/sessions/session_paged")) {
        return jsonResponse({
          session: {
            id: "session_paged",
            title: "分页会话",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:04.000Z"
          },
          messages: [
            createUserMessage("session_paged", "消息 3", { id: "msg_3", createdAt: "2026-06-22T00:00:03.000Z" }),
            createAssistantMessage("session_paged", "消息 4", {
              id: "msg_4",
              createdAt: "2026-06-22T00:00:04.000Z",
              completedAt: "2026-06-22T00:00:04.000Z"
            })
          ],
          pageInfo: {
            hasMore: true,
            oldestCursor: "msg_3",
            limit: 30
          }
        });
      }

      if (url.includes("/agents/sessions/session_paged/messages?before=msg_3&limit=30")) {
        return jsonResponse({
          messages: [
            createUserMessage("session_paged", "消息 1", { id: "msg_1", createdAt: "2026-06-22T00:00:01.000Z" }),
            createAssistantMessage("session_paged", "消息 2", {
              id: "msg_2",
              createdAt: "2026-06-22T00:00:02.000Z",
              completedAt: "2026-06-22T00:00:02.000Z"
            })
          ],
          pageInfo: {
            hasMore: false,
            oldestCursor: "msg_1",
            limit: 30
          }
        });
      }

      if (url.endsWith("/agents/sessions")) {
        return jsonResponse({
          sessions: [
            {
              id: "session_paged",
              title: "分页会话",
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:04.000Z"
            }
          ]
        });
      }

      return undefined;
    });

    const { container } = render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "分页会话" }));

    await waitFor(() => expect(screen.getByText("消息 4")).toBeInTheDocument());
    expect(screen.queryByText("消息 1")).not.toBeInTheDocument();

    const scrollElement = container.querySelector(".chat-scroll") as HTMLDivElement;
    let scrollTop = 48;
    let scrollHeight = 1000;

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
    fireEvent.wheel(scrollElement, { deltaY: -120 });
    fireEvent.scroll(scrollElement);
    scrollHeight = 1300;

    await waitFor(() => expect(screen.getByText("消息 1")).toBeInTheDocument());
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:4001/agents/sessions/session_paged/messages?before=msg_3&limit=30"
    );
    expect(screen.queryByText("上滑加载更早消息")).not.toBeInTheDocument();
  });

  it("新建会话会清空当前消息、事件和 URL sessionId", async () => {
    window.history.replaceState(null, "", "/?sessionId=session_from_url");
    mockAppFetch((url) => {
      if (url.endsWith("/agents/sessions/session_from_url")) {
        return jsonResponse({
          session: {
            id: "session_from_url",
            title: "URL 会话",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:00.000Z"
          },
          messages: [
            createUserMessage("session_from_url", "从 URL 恢复", { id: "msg_user_from_url" }),
            createAssistantMessage("session_from_url", "URL 会话回答", {
              id: "msg_assistant_from_url",
              completedAt: "2026-06-22T00:00:01.000Z"
            })
          ]
        });
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("URL 会话回答")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "新建会话" }));

    expect(window.location.search).toBe("");
    expect(screen.queryByText("URL 会话回答")).not.toBeInTheDocument();
    expect(screen.getByText("有什么我能帮你的吗？")).toBeInTheDocument();
  });

  it("基础交互控件使用 MUI 组件承载", async () => {
    mockAppFetch();

    const { container } = render(<App />);

    expect(container.querySelector(".MuiPaper-root.chat-composer")).toBeInTheDocument();
    expect(container.querySelector(".MuiTextField-root")).toBeInTheDocument();
    expect(container.querySelector('label[for="agent-input"]')).not.toBeInTheDocument();
    expect(container.querySelector(".chat-composer")).toContainElement(screen.getByPlaceholderText("发消息..."));
    expect(screen.getByRole("button", { name: "发送" })).toHaveClass("MuiIconButton-root");
    expect(screen.queryByRole("button", { name: "运行" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "流式运行" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("API 正常")).toHaveClass("MuiChip-label"));
  });

  it("聊天工作台细节保持统一、舒适且没有突兀 outline", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).toMatch(/\.chat-scroll\s*{[^}]*overflow:\s*auto;[^}]*padding:\s*28px 24px 18px;/s);
    expect(styles).toMatch(/\.chat-scroll-content\s*{[^}]*width:\s*min\(100%,\s*800px\);[^}]*margin:\s*0 auto;/s);
    expect(styles).toMatch(/\.chat-scroll-content-empty\s*{[^}]*align-content:\s*center;[^}]*justify-items:\s*center;/s);
    expect(styles).toMatch(/\.chat-panel\.chat-panel\.MuiPaper-root\s*{[^}]*background:\s*transparent;/s);
    expect(styles).toMatch(/\.trace-panel\.trace-panel\.MuiPaper-root\s*{[^}]*background:\s*#f7f7f5;/s);
    expect(styles).toMatch(/\.chat-empty\s*{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*text-align:\s*center;/s);
    expect(styles).toMatch(/\.chat-composer\s*{[^}]*margin:\s*5px auto 12px;[^}]*border:\s*1px solid var\(--eye-border\);/s);
    expect(styles).toMatch(/\.chat-composer\.chat-composer\.MuiPaper-root\s*{[^}]*background:\s*#fffdfa;/s);
    expect(styles).toMatch(/\.chat-composer \.MuiOutlinedInput-root\.Mui-focused \.MuiOutlinedInput-notchedOutline\s*{[^}]*border-color:\s*transparent;/s);
    expect(styles).toMatch(/\.sidebar-search \.MuiInputBase-root\.Mui-focused\s*{[^}]*box-shadow:\s*none;/s);
    expect(styles).toMatch(/\.primary-button\s*{[^}]*background:\s*var\(--eye-primary-strong\);[^}]*color:\s*#fff;/s);
    expect(styles).toMatch(/\.composer-submit-button\.composer-submit-button\.MuiIconButton-root\s*{[^}]*width:\s*38px;[^}]*height:\s*38px;/s);
    expect(styles).toMatch(/\.chat-answer\s*{[^}]*width:\s*100%;[^}]*color:\s*var\(--eye-text\);/s);
    expect(styles).toMatch(/\.chat-system-row\s*{[^}]*margin:\s*42px 0;/s);
    expect(styles).toMatch(/\.chat-status\.failed\.chat-status\.MuiChip-root\s*{[^}]*border-color:\s*#d58b76;[^}]*background:\s*#fff5f1;[^}]*color:\s*#7a2418;/s);
    expect(styles).toMatch(/\.inline-error\.inline-error\.MuiAlert-root\s*{[^}]*border-color:\s*#d58b76;[^}]*background:\s*#fff8f6;[^}]*color:\s*#6f2318;/s);
    expect(styles).toMatch(/\.inline-error \.MuiAlert-icon\s*{[^}]*color:\s*#b73524;/s);
    expect(styles).toMatch(/\.inline-error \.MuiAlert-message\s*{[^}]*overflow-wrap:\s*anywhere;[^}]*color:\s*#6f2318;/s);
    expect(styles).toMatch(/\.new-session-button\.MuiButton-root\s*{[^}]*margin-bottom:\s*10px;/s);
    expect(styles).toMatch(/\.sidebar-divider\.sidebar-divider\.MuiDivider-root\s*{[^}]*margin:\s*2px 0 12px;[^}]*border-color:\s*#e4e4df;/s);
    expect(styles).toMatch(/\.sidebar-history-heading\s*{[^}]*margin:\s*0 0 10px;/s);
    expect(styles).toMatch(/\.session-history-list\s*{[^}]*gap:\s*6px;/s);
    expect(styles).toMatch(/\.session-history-item\.session-history-item\.MuiListItemButton-root\s*{[^}]*margin:\s*0 4px;[^}]*border-radius:\s*8px;[^}]*overflow:\s*hidden;/s);
    expect(styles).toMatch(/\.session-history-item\.session-history-item\.MuiListItemButton-root:hover\s*{[^}]*background:\s*#edf3e8;[^}]*color:\s*var\(--eye-primary-strong\);/s);
    expect(styles).toMatch(/\.session-history-item\.session-history-item\.Mui-selected,\s*\.session-history-item\.session-history-item\.Mui-selected:hover\s*{[^}]*background:\s*#e7f1d9;[^}]*border-radius:\s*8px;/s);
    expect(styles).toMatch(/\.session-history-item > svg\s*{[^}]*flex:\s*0 0 15px;[^}]*width:\s*15px;[^}]*height:\s*15px;/s);
    expect(styles).toMatch(/\.session-history-item \.MuiListItemText-root\s*{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.workspace\s*{[^}]*--session-panel-width:\s*280px;[^}]*--trace-panel-width:\s*clamp\(320px,\s*24vw,\s*380px\);[^}]*--chat-main-left:\s*var\(--session-panel-width\);[^}]*--chat-main-right:\s*var\(--trace-panel-width\);/s);
    expect(styles).toMatch(/\.workspace\.sidebar-collapsed\s*{[^}]*--chat-main-left:\s*0px;/s);
    expect(styles).toMatch(/\.workspace\.trace-collapsed\s*{[^}]*--chat-main-right:\s*0px;/s);
    expect(styles).toMatch(/\.session-sidebar,\s*\.trace-column\s*{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*bottom:\s*0;/s);
    expect(styles).toMatch(/\.session-sidebar\s*{[^}]*left:\s*0;[^}]*width:\s*var\(--session-panel-width\);[^}]*transition:\s*[\s\S]*left 0\.22s ease,/s);
    expect(styles).toMatch(/\.session-sidebar\.collapsed\s*{[^}]*left:\s*calc\(0px - var\(--session-panel-width\) - 1px\);/s);
    expect(styles).toMatch(/\.trace-column\s*{[^}]*right:\s*0;[^}]*width:\s*var\(--trace-panel-width\);[^}]*transition:\s*[\s\S]*right 0\.22s ease,/s);
    expect(styles).toMatch(/\.trace-column\.collapsed\s*{[^}]*right:\s*calc\(0px - var\(--trace-panel-width\) - 1px\);/s);
    expect(styles).toMatch(/\.chat-main,\s*\.response-column\s*{[^}]*position:\s*absolute;[^}]*right:\s*var\(--chat-main-right\);[^}]*left:\s*var\(--chat-main-left\);[^}]*transition:\s*[\s\S]*left 0\.22s ease,[\s\S]*right 0\.22s ease,/s);
    expect(styles).toMatch(/\.chat-main-header\s*{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(112px,\s*1fr\) auto minmax\(112px,\s*1fr\);/s);
    expect(styles).toMatch(/\.chat-header-side\.left\s*{[^}]*justify-content:\s*flex-start;/s);
    expect(styles).toMatch(/\.chat-header-side\.right\s*{[^}]*justify-content:\s*flex-end;[^}]*gap:\s*8px;/s);
    expect(styles).toMatch(/\.sidebar-toggle\.sidebar-toggle\.MuiIconButton-root\s*{[^}]*width:\s*38px;[^}]*height:\s*38px;[^}]*transition:\s*[\s\S]*border-color 0\.16s ease,/s);
  });

  it("新建会话空状态在消息区居中显示", async () => {
    mockAppFetch();

    const { container } = render(<App />);

    await waitFor(() => expect(screen.getByText("有什么我能帮你的吗？")).toBeInTheDocument());
    expect(container.querySelector(".chat-scroll-empty")).toBeInTheDocument();
    expect(container.querySelector(".chat-empty")).toContainElement(screen.getByText("有什么我能帮你的吗？"));
  });

  it("点击空状态建议会回填输入框并聚焦", async () => {
    mockAppFetch();

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "现在上海时间是多少？" }));

    expect(screen.getByLabelText("发消息")).toHaveTextContent("现在上海时间是多少？");
    expect(screen.getByLabelText("发消息")).toHaveFocus();
  });

  it("保留护眼主题变量并使用豆包式全屏底色", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).toContain("--eye-page: #fff2c6;");
    expect(styles).toContain("--eye-surface: #fff8df;");
    expect(styles).toContain("--eye-border: #eadfaf;");
    expect(styles).toContain("--eye-primary: #247a73;");
    expect(styles).toMatch(/body\s*{[^}]*background:\s*#f7f7f5;/s);
    expect(styles).toMatch(/\.workspace\s*{[^}]*background:\s*#f7f7f5;/s);
    expect(styles).toMatch(/\.panel\s*{[^}]*background:\s*var\(--eye-surface\);/s);
    expect(styles).toMatch(/\.primary-button\s*{[^}]*background:\s*var\(--eye-primary-strong\);/s);
  });

  it("提交任务会用流式事件展示回答和可折叠工具过程", async () => {
    window.history.replaceState(null, "", "/");
    mockAppFetch((url, init) => {
      if (url.endsWith("/agents/runs") && init?.method === "POST") {
        return jsonResponse(createStartMessageResponse({ input: "计算 12 * 9", assistantMessageId: "msg_1" }));
      }

      if (url.endsWith("/agents/runs/msg_1/events?after=0")) {
        return createStoredSseResponse("msg_1", [
          {
            type: "tool_start",
            iteration: 0,
            toolName: "calculator",
            arguments: { expression: "12 * 9" }
          },
          {
            type: "tool_result",
            iteration: 0,
            toolName: "calculator",
            result: { value: 108 }
          },
          { type: "message.part.delta", messageId: "msg_1", partIndex: 0, delta: "结果是 108" },
          { type: "final_answer", answer: "结果是 108" }
        ]);
      }

      return undefined;
    });

    render(<App />);

    await userEvent.clear(screen.getByLabelText("发消息"));
    await userEvent.type(screen.getByLabelText("发消息"), "计算 12 * 9");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getAllByText("结果是 108").length).toBeGreaterThan(0));
    expect(window.location.search).toBe("?sessionId=session_1");
    expect(screen.getByText("工具过程")).toBeInTheDocument();
    expect(screen.queryByText("工具步骤")).not.toBeInTheDocument();
    expect(screen.getAllByText(/"expression": "12 \* 9"/).length).toBeGreaterThan(0);
  });

  it("打开带 sessionId 的地址时优先恢复 URL 里的会话", async () => {
    window.history.replaceState(null, "", "/?sessionId=session_from_url");
    mockAppFetch((url) => {
      if (url.endsWith("/agents/sessions/session_from_url")) {
        return jsonResponse({
          session: {
            id: "session_from_url",
            title: "URL 会话",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:00.000Z"
          },
          messages: [
            createUserMessage("session_from_url", "从 URL 恢复", { id: "msg_user_from_url" }),
            createAssistantMessage("session_from_url", "URL 会话回答", {
              id: "msg_assistant_from_url",
              completedAt: "2026-06-22T00:00:01.000Z"
            })
          ]
        });
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("URL 会话回答")).toBeInTheDocument());
    expect(globalThis.fetch).toHaveBeenCalledWith("http://localhost:4001/agents/sessions/session_from_url");
  });

  it("刷新恢复已完成会话时从 message.parts 展示生成图片", async () => {
    window.history.replaceState(null, "", "/?sessionId=session_with_image");
    mockAppFetch((url) => {
      if (url.endsWith("/agents/sessions/session_with_image")) {
        return jsonResponse({
          session: {
            id: "session_with_image",
            title: "图片会话",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:00.000Z"
          },
          messages: [
            {
              id: "msg_user",
              sessionId: "session_with_image",
              role: "user",
              status: "completed",
              parts: [{ type: "text", value: "生成一只小狗" }],
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:00.000Z"
            },
            {
              id: "msg_assistant",
              sessionId: "session_with_image",
              role: "assistant",
              status: "completed",
              parts: [
                { type: "text", value: "图片已生成。" },
                {
                  type: "media",
                  mime: "image/png",
                  url: "https://example.com/dog.png",
                  extra: {
                    lifecycle: { state: "succeeded" },
                    tool: { name: "generate_image", toolCallId: "call_image", outputIndex: 0 },
                    generation: { prompt: "一只小狗", provider: "test" }
                  }
                }
              ],
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:01.000Z"
            }
          ]
        });
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => expect(screen.getByRole("img", { name: "一只小狗" })).toHaveAttribute("src", "https://example.com/dog.png"));
    expect(screen.getByRole("link", { name: "下载图片 1" })).toHaveAttribute("href", "https://example.com/dog.png");
  });

  it("恢复会话时展示历史摘要 system 状态消息", async () => {
    window.history.replaceState(null, "", "/?sessionId=session_with_summary_status");
    mockAppFetch((url) => {
      if (url.endsWith("/agents/sessions/session_with_summary_status")) {
        return jsonResponse({
          session: {
            id: "session_with_summary_status",
            title: "摘要状态会话",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:02.000Z"
          },
          messages: [
            createUserMessage("session_with_summary_status", "继续", { id: "msg_user_summary" }),
            createSystemMessage("session_with_summary_status", "已自动压缩较早上下文，后续会基于摘要和最近消息继续对话", {
              id: "msg_system_summary"
            }),
            createAssistantMessage("session_with_summary_status", "继续聊", {
              id: "msg_assistant_summary",
              completedAt: "2026-06-22T00:00:02.000Z"
            })
          ]
        });
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("继续聊")).toBeInTheDocument());
    expect(screen.getByText("上下文已自动压缩，后续会基于摘要和最近消息继续对话")).toBeInTheDocument();
    expect(screen.queryByText("已自动压缩较早上下文，后续会基于摘要和最近消息继续对话")).not.toBeInTheDocument();
  });

  it("裸地址不会恢复会话", async () => {
    window.history.replaceState(null, "", "/");
    mockAppFetch();

    render(<App />);

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("http://localhost:4001/health", expect.any(Object)));
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([url]) => String(url).includes("/agents/sessions/"))).toBe(false);
    expect(window.location.search).toBe("");
  });

  it("流式运行并展示 trace 时间线", async () => {
    mockAppFetch((url, init) => {
      if (url.endsWith("/agents/runs") && init?.method === "POST") {
        return jsonResponse(createStartMessageResponse({ input: "你好", assistantMessageId: "msg_1" }));
      }

      if (url.endsWith("/agents/runs/msg_1/events?after=0")) {
        return createStoredSseResponse("msg_1", [
          { type: "iteration_start", iteration: 0 },
          { type: "agent_state", iteration: 0, state: "thinking", label: "模型思考中" },
          { type: "llm_start", iteration: 0 },
          { type: "message.part.delta", messageId: "msg_1", partIndex: 0, delta: "结果" },
          { type: "message.part.delta", messageId: "msg_1", partIndex: 0, delta: "是 108。" },
          {
            type: "tool_call_ready",
            iteration: 0,
            toolCallId: "call_1",
            toolName: "calculator",
            arguments: { expression: "12 * 9" }
          },
          {
            type: "tool_start",
            iteration: 0,
            toolCallId: "call_1",
            toolName: "calculator",
            arguments: { expression: "12 * 9" }
          },
          {
            type: "tool_result",
            iteration: 0,
            toolCallId: "call_1",
            toolName: "calculator",
            result: { value: 108 },
            durationMs: 7
          },
          { type: "final_answer", answer: "结果是 108。" }
        ]);
      }

      return undefined;
    });

    render(<App />);

    await userEvent.type(screen.getByLabelText("发消息"), "你好");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getAllByText("结果是 108。").length).toBeGreaterThan(0));
    expect(screen.getAllByText("模型思考中").length).toBeGreaterThan(0);
    expect(screen.getByText("请求模型")).toBeInTheDocument();
    expect(screen.getByText("准备工具：calculator")).toBeInTheDocument();
    expect(screen.getByText("调用工具：calculator")).toBeInTheDocument();
    expect(screen.getByText("工具结果：calculator")).toBeInTheDocument();
    expect(screen.getAllByText(/耗时 7ms/).length).toBeGreaterThan(0);
  });

  it("摘要过程会在主消息区和时间线展示", async () => {
    const runningSystemMessage = createSystemMessage("session_1", "上下文自动压缩中...", {
      id: "msg_system_summary",
      status: "running"
    });
    const completedSystemMessage = createSystemMessage(
      "session_1",
      "上下文已自动压缩",
      {
        id: "msg_system_summary",
        status: "completed",
        completedAt: "2026-06-22T00:00:02.000Z"
      }
    );

    mockAppFetch((url, init) => {
      if (url.endsWith("/agents/runs") && init?.method === "POST") {
        return jsonResponse(createStartMessageResponse({ input: "继续深入", assistantMessageId: "msg_1" }));
      }

      if (url.endsWith("/agents/runs/msg_1/events?after=0")) {
        return createStoredSseResponse("msg_1", [
          { type: "session.message.created", message: runningSystemMessage },
          {
            type: "summary_start",
            sessionId: "session_1",
            messageId: "msg_system_summary",
            uncoveredMessageCount: 6,
            summarizedMessageCount: 4
          },
          { type: "session.message.updated", message: completedSystemMessage },
          {
            type: "summary_completed",
            sessionId: "session_1",
            messageId: "msg_system_summary",
            uncoveredMessageCount: 6,
            summarizedMessageCount: 4,
            coveredMessageId: "msg_assistant_old",
            durationMs: 25
          },
          { type: "message.part.updated", messageId: "msg_1", partIndex: 0, part: { type: "text", value: "可以，继续。" } },
          { type: "final_answer", answer: "可以，继续。" },
          { type: "run_completed", messageId: "msg_1" }
        ]);
      }

      return undefined;
    });

    render(<App />);

    await userEvent.type(screen.getByLabelText("发消息"), "继续深入");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getAllByText("可以，继续。").length).toBeGreaterThan(0));
    expect(screen.getByText("上下文已自动压缩")).toBeInTheDocument();
    expect(screen.getByText("开始压缩上下文")).toBeInTheDocument();
    expect(screen.getByText("上下文压缩完成")).toBeInTheDocument();
    expect(screen.getByText(/压缩 4 条/)).toBeInTheDocument();
  });

  it("历史消息中多条压缩状态在主消息区只保留最新一条", async () => {
    window.history.replaceState(null, "", "/?sessionId=session_many_summary");

    mockAppFetch((url) => {
      if (url.endsWith("/agents/sessions/session_many_summary")) {
        return jsonResponse({
          session: {
            id: "session_many_summary",
            title: "多次压缩",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:05.000Z"
          },
          messages: [
            createUserMessage("session_many_summary", "第一轮", { id: "msg_user_1", createdAt: "2026-06-22T00:00:01.000Z" }),
            createSystemMessage("session_many_summary", "已自动压缩上下文", {
              id: "msg_system_summary_1",
              createdAt: "2026-06-22T00:00:02.000Z"
            }),
            createAssistantMessage("session_many_summary", "第一轮回答", {
              id: "msg_assistant_1",
              createdAt: "2026-06-22T00:00:03.000Z"
            }),
            createSystemMessage("session_many_summary", "已自动压缩上下文", {
              id: "msg_system_summary_2",
              createdAt: "2026-06-22T00:00:04.000Z"
            })
          ]
        });
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("第一轮回答")).toBeInTheDocument());
    expect(screen.getAllByText("上下文已自动压缩")).toHaveLength(1);
    expect(screen.queryByText("已自动压缩上下文")).not.toBeInTheDocument();
  });

  it("历史消息中的未完成或失败压缩状态不会顶掉已完成压缩提示", async () => {
    window.history.replaceState(null, "", "/?sessionId=session_unfinished_summary");

    mockAppFetch((url) => {
      if (url.endsWith("/agents/sessions/session_unfinished_summary")) {
        return jsonResponse({
          session: {
            id: "session_unfinished_summary",
            title: "未完成压缩",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:05.000Z"
          },
          messages: [
            createSystemMessage("session_unfinished_summary", "已自动压缩上下文", {
              id: "msg_system_summary_done",
              status: "completed",
              createdAt: "2026-06-22T00:00:01.000Z"
            }),
            createSystemMessage("session_unfinished_summary", "上下文自动压缩中...", {
              id: "msg_system_summary_running",
              status: "running",
              createdAt: "2026-06-22T00:00:02.000Z"
            }),
            createSystemMessage("session_unfinished_summary", "上下文压缩失败，已继续本轮回答", {
              id: "msg_system_summary_failed",
              status: "failed",
              createdAt: "2026-06-22T00:00:03.000Z"
            }),
            createAssistantMessage("session_unfinished_summary", "继续聊", {
              id: "msg_assistant_latest",
              createdAt: "2026-06-22T00:00:04.000Z"
            })
          ]
        });
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("继续聊")).toBeInTheDocument());
    expect(screen.getByText("上下文已自动压缩")).toBeInTheDocument();
    expect(screen.queryByText("已自动压缩上下文")).not.toBeInTheDocument();
    expect(screen.queryByText("上下文自动压缩中...")).not.toBeInTheDocument();
    expect(screen.queryByText("上下文压缩失败，已继续本轮回答")).not.toBeInTheDocument();
  });

  it("压缩被取消后会从主消息区移除 system 状态", async () => {
    const runningSystemMessage = createSystemMessage("session_1", "上下文自动压缩中...", {
      id: "msg_system_summary",
      status: "running"
    });
    const cancelledSystemMessage = createSystemMessage("session_1", "上下文压缩已中断", {
      id: "msg_system_summary",
      status: "cancelled",
      completedAt: "2026-06-22T00:00:02.000Z"
    });

    mockAppFetch((url, init) => {
      if (url.endsWith("/agents/runs") && init?.method === "POST") {
        return jsonResponse(createStartMessageResponse({ input: "继续深入", assistantMessageId: "run_1" }));
      }

      if (url.endsWith("/agents/runs/run_1/events?after=0")) {
        return createStoredSseResponse("run_1", [
          { type: "session.message.created", message: runningSystemMessage },
          {
            type: "summary_start",
            sessionId: "session_1",
            messageId: "msg_system_summary",
            uncoveredMessageCount: 6,
            summarizedMessageCount: 4
          },
          { type: "session.message.updated", message: cancelledSystemMessage },
          { type: "cancelled", reason: "用户中断" }
        ]);
      }

      return undefined;
    });

    render(<App />);

    await userEvent.type(screen.getByLabelText("发消息"), "继续深入");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getByText("开始压缩上下文")).toBeInTheDocument());
    expect(screen.queryByText("上下文自动压缩中...")).not.toBeInTheDocument();
    expect(screen.queryByText("上下文压缩已中断")).not.toBeInTheDocument();
  });

  it("压缩失败后会从主消息区移除 system 状态，只在时间线保留观测", async () => {
    const runningSystemMessage = createSystemMessage("session_1", "上下文自动压缩中...", {
      id: "msg_system_summary",
      status: "running"
    });
    const failedSystemMessage = createSystemMessage("session_1", "上下文压缩失败，已继续本轮回答", {
      id: "msg_system_summary",
      status: "failed",
      completedAt: "2026-06-22T00:00:02.000Z"
    });

    mockAppFetch((url, init) => {
      if (url.endsWith("/agents/runs") && init?.method === "POST") {
        return jsonResponse(createStartMessageResponse({ input: "继续深入", assistantMessageId: "run_1" }));
      }

      if (url.endsWith("/agents/runs/run_1/events?after=0")) {
        return createStoredSseResponse("run_1", [
          { type: "session.message.created", message: runningSystemMessage },
          {
            type: "summary_start",
            sessionId: "session_1",
            messageId: "msg_system_summary",
            uncoveredMessageCount: 6,
            summarizedMessageCount: 4
          },
          { type: "session.message.updated", message: failedSystemMessage },
          {
            type: "summary_failed",
            sessionId: "session_1",
            messageId: "msg_system_summary",
            uncoveredMessageCount: 6,
            summarizedMessageCount: 4,
            durationMs: 25,
            error: { code: "SUMMARY_FAILED", message: "测试失败" }
          },
          { type: "message.part.updated", messageId: "run_1", partIndex: 0, part: { type: "text", value: "继续回答。" } },
          { type: "final_answer", answer: "继续回答。" },
          { type: "run_completed", messageId: "run_1" }
        ]);
      }

      return undefined;
    });

    render(<App />);

    await userEvent.type(screen.getByLabelText("发消息"), "继续深入");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getByText("上下文压缩失败")).toBeInTheDocument());
    expect(screen.getAllByText("继续回答。").length).toBeGreaterThan(0);
    expect(screen.queryByText("上下文自动压缩中...")).not.toBeInTheDocument();
    expect(screen.queryByText("上下文压缩失败，已继续本轮回答")).not.toBeInTheDocument();
  });

  it("收到 run_completed 后恢复发送并不会中断上一轮", async () => {
    let createCount = 0;
    let firstStream: ReturnType<typeof createControlledStoredSseResponse> | undefined;

    mockAppFetch((url, init) => {
      if (url.endsWith("/agents/runs") && init?.method === "POST") {
        createCount += 1;
        const body = JSON.parse(String(init.body)) as { parts: Array<{ type: "text"; value: string }> };

        return jsonResponse(
          createStartMessageResponse({
            input: body.parts[0]?.value ?? "",
            assistantMessageId: `msg_${createCount}`
          })
        );
      }

      if (url.endsWith("/agents/runs/msg_1/events?after=0")) {
        firstStream = createControlledStoredSseResponse("msg_1");
        return firstStream.response;
      }

      if (url.endsWith("/agents/runs/msg_2/events?after=0")) {
        return createStoredSseResponse("msg_2", [{ type: "final_answer", answer: "第二轮答案" }]);
      }

      return undefined;
    });

    render(<App />);

    await userEvent.type(screen.getByLabelText("发消息"), "第一轮");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(firstStream).toBeDefined());

    firstStream?.emit({ type: "final_answer", answer: "第一轮答案" });
    firstStream?.emit({ type: "run_completed", messageId: "msg_1" });

    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("发消息"), "第二轮");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getAllByText("第二轮答案").length).toBeGreaterThan(0));
    expect(
      vi.mocked(globalThis.fetch).mock.calls.some(([url, init]) => String(url).includes("/cancel") && init?.method === "POST")
    ).toBe(false);

    firstStream?.close();
  });

  it("流式运行中可以中断当前 message", async () => {
    mockAppFetch((url, init) => {
      if (url.endsWith("/agents/runs") && init?.method === "POST") {
        return jsonResponse(createStartMessageResponse({ input: "写一段很长的内容", assistantMessageId: "msg_1" }));
      }

      if (url.endsWith("/agents/runs/msg_1/events?after=0")) {
        return createOpenSseResponse();
      }

      if (url.endsWith("/agents/runs/msg_1/cancel") && init?.method === "POST") {
        return jsonResponse({
          run: {
            id: "msg_1",
            sessionId: "session_1",
            status: "cancelled",
            phase: "cancelled",
            userMessageId: "msg_1:user",
            assistantMessageId: "msg_1",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:01.000Z",
            completedAt: "2026-06-22T00:00:01.000Z"
          }
        });
      }

      if (url.endsWith("/agents/sessions/session_1")) {
        return jsonResponse({
          session: {
            id: "session_1",
            title: "写一段很长的内容",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:01.000Z"
          },
          messages: [
            createUserMessage("session_1", "写一段很长的内容", { id: "msg_1:user" }),
            createAssistantMessage("session_1", "", { id: "msg_1", status: "cancelled" })
          ]
        });
      }

      return undefined;
    });

    render(<App />);

    await userEvent.type(screen.getByLabelText("发消息"), "写一段很长的内容");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "停止" }));

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith("http://localhost:4001/agents/runs/msg_1/cancel", {
        method: "POST"
      })
    );
    expect(screen.getByText("已中断")).toBeInTheDocument();
  });

  it("生成中按 Enter 会先中断当前 message 再发送新 message", async () => {
    let messageCreateCount = 0;
    let firstStream: ReturnType<typeof createControlledStoredSseResponse> | undefined;

    mockAppFetch((url, init) => {
      if (url.endsWith("/agents/runs") && init?.method === "POST") {
        messageCreateCount += 1;
        const messageId = `msg_${messageCreateCount}`;
        const body = JSON.parse(String(init.body)) as { parts: Array<{ type: "text"; value: string }> };

        return jsonResponse(createStartMessageResponse({ input: body.parts[0]?.value ?? "", assistantMessageId: messageId }));
      }

      if (url.endsWith("/agents/runs/msg_1/events?after=0")) {
        firstStream = createControlledStoredSseResponse("msg_1");
        return firstStream.response;
      }

      if (url.endsWith("/agents/runs/msg_1/cancel") && init?.method === "POST") {
        return jsonResponse({
          run: {
            id: "msg_1",
            sessionId: "session_1",
            status: "cancelled",
            phase: "cancelled",
            userMessageId: "msg_1:user",
            assistantMessageId: "msg_1",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:01.000Z",
            completedAt: "2026-06-22T00:00:01.000Z"
          }
        });
      }

      if (url.endsWith("/agents/runs/msg_2/events?after=0")) {
        return createStoredSseResponse("msg_2", [
          { type: "message.part.delta", messageId: "msg_2", partIndex: 0, delta: "第二轮答案" },
          { type: "final_answer", answer: "第二轮答案" }
        ]);
      }

      return undefined;
    });

    render(<App />);

    await userEvent.type(screen.getByLabelText("发消息"), "第一轮");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("运行中")).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText("发消息"), "第二轮{Enter}");

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith("http://localhost:4001/agents/runs/msg_1/cancel", {
        method: "POST"
      })
    );
    await waitFor(() => expect(screen.getAllByText("第二轮答案").length).toBeGreaterThan(0));
    expect(screen.getByText("已中断")).toBeInTheDocument();
    expect(screen.queryByText("运行中")).not.toBeInTheDocument();

    const messageBodies = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url, init]) => String(url).endsWith("/agents/runs") && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)) as { parts: Array<{ type: "text"; value: string }> });

    expect(messageBodies.map((body) => body.parts[0]?.value)).toEqual(["第一轮", "第二轮"]);
    firstStream?.close();
  });

  it("创建流式 message 失败后会恢复发送按钮", async () => {
    mockAppFetch((url, init) => {
      if (url.endsWith("/agents/runs") && init?.method === "POST") {
        return jsonResponse(
          {
            error: {
              code: "PROVIDER_ERROR",
              message: "启动失败"
            }
          },
          false
        );
      }

      return undefined;
    });

    render(<App />);

    await userEvent.type(screen.getByLabelText("发消息"), "会失败的问题");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getByText("PROVIDER_ERROR: 启动失败")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
  });

  it("流式运行时用 message part delta 实时展示答案", async () => {
    mockAppFetch((url, init) => {
      if (url.endsWith("/agents/runs") && init?.method === "POST") {
        return jsonResponse(createStartMessageResponse({ input: "用户问题", assistantMessageId: "msg_1" }));
      }

      if (url.endsWith("/agents/runs/msg_1/events?after=0")) {
        return createStoredSseResponse("msg_1", [
          { type: "iteration_start", iteration: 0 },
          { type: "agent_state", iteration: 0, state: "thinking", label: "模型思考中" },
          { type: "llm_start", iteration: 0 },
          { type: "message.part.delta", messageId: "msg_1", partIndex: 0, delta: "分块答案" }
        ]);
      }

      return undefined;
    });

    render(<App />);

    await userEvent.type(screen.getByLabelText("发消息"), "用户问题");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getAllByText("分块答案").length).toBeGreaterThan(0));
    expect(screen.getByText("请求模型")).toBeInTheDocument();
  });

  it("流式运行时用 message part delta 实时展示答案", async () => {
    mockAppFetch((url, init) => {
      if (url.endsWith("/agents/runs") && init?.method === "POST") {
        const response = createStartMessageResponse({ input: "用户问题", assistantMessageId: "msg_1" });

        return jsonResponse({
          ...response,
          assistantMessage: {
            ...response.assistantMessage,
            parts: [{ type: "text", value: "" }]
          }
        });
      }

      if (url.endsWith("/agents/runs/msg_1/events?after=0")) {
        return createStoredSseResponse("msg_1", [
          { type: "message.part.delta", messageId: "msg_1", partIndex: 0, delta: "新协议答案" },
          { type: "final_answer", answer: "新协议答案" }
        ]);
      }

      return undefined;
    });

    render(<App />);

    await userEvent.type(screen.getByLabelText("发消息"), "用户问题");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getAllByText("新协议答案").length).toBeGreaterThan(0));
  });

  it("刷新后根据本地 activeRunId 恢复事件流", async () => {
    localStorage.setItem("agent.activeRunId", "msg_1");
    mockAppFetch((url) => {
      if (url.endsWith("/agents/runs/msg_1")) {
        return jsonResponse({
          run: {
            id: "msg_1",
            sessionId: "session_1",
            status: "completed",
            phase: "completed",
            userMessageId: "msg_user_1",
            assistantMessageId: "msg_1",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:01.000Z",
            completedAt: "2026-06-22T00:00:01.000Z"
          },
          events: [
            {
              id: "event_1",
              seq: 1,
              runId: "msg_1",
              messageId: "msg_1",
              event: { type: "iteration_start", iteration: 0 },
              createdAt: "2026-06-22T00:00:00.000Z"
            },
            {
              id: "event_2",
              seq: 2,
              runId: "msg_1",
              messageId: "msg_1",
              event: { type: "message.part.delta", messageId: "msg_1", partIndex: 0, delta: "恢复" },
              createdAt: "2026-06-22T00:00:00.000Z"
            },
            {
              id: "event_3",
              seq: 3,
              runId: "msg_1",
              messageId: "msg_1",
              event: { type: "final_answer", answer: "恢复" },
              createdAt: "2026-06-22T00:00:00.000Z"
            }
          ]
        });
      }

      if (url.endsWith("/agents/sessions/session_1")) {
        return jsonResponse({
          session: {
            id: "session_1",
            title: "恢复会话",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:01.000Z"
          },
          messages: [
            createUserMessage("session_1", "继续刚才的话题", { id: "msg_user_1" }),
            createAssistantMessage("session_1", "恢复", { id: "msg_1" })
          ]
        });
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => expect(screen.getAllByText("恢复").length).toBeGreaterThan(0));
    expect(window.location.search).toBe("?sessionId=session_1");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:4001/agents/runs/msg_1"
    );
  });

  it("卸载时取消刷新恢复的事件流订阅", async () => {
    localStorage.setItem("agent.activeRunId", "msg_1");
    let streamSignal: AbortSignal | undefined;

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/health")) {
        return Promise.resolve({
          ok: true
        } as Response);
      }

      if (url.endsWith("/agents/sessions")) {
        return Promise.resolve(jsonResponse({ sessions: [] }));
      }

      if (url.endsWith("/agents/runs/msg_1")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            run: {
              id: "msg_1",
              sessionId: "session_1",
              status: "running",
              phase: "answering",
              userMessageId: "msg_user_1",
              assistantMessageId: "msg_1",
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:00.000Z"
            },
            events: []
          })
        } as Response);
      }

      if (url.endsWith("/agents/sessions/session_1")) {
        return Promise.resolve(
          jsonResponse({
            session: {
              id: "session_1",
              title: "恢复会话",
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:00.000Z"
            },
            messages: [
              createUserMessage("session_1", "你好", { id: "msg_user_1" }),
              createAssistantMessage("session_1", "", { id: "msg_1", status: "running" })
            ]
          })
        );
      }

      streamSignal = init?.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        body: new ReadableStream()
      } as Response);
    });

    const { unmount } = render(<App />);

    await waitFor(() => expect(streamSignal).toBeDefined());
    expect(streamSignal?.aborted).toBe(false);

    unmount();

    expect(streamSignal?.aborted).toBe(true);
  });
});
