import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

function createStoredSseResponse(runId: string, events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        const blocks = events
          .map((event, index) => {
            const seq = index + 1;
            const storedEvent = {
              id: `event_${seq}`,
              seq,
              runId,
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

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("App", () => {
  it("消息列让对话面板铺满可用高度", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).toMatch(/\.response-column\s*{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/s);
    expect(styles).not.toContain("grid-template-rows: auto minmax(0, 1fr)");
  });

  it("使用全屏三栏工作台布局", () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true
    } as Response);

    const { container } = render(<App />);

    expect(container.querySelector(".fullscreen-shell")).toBeInTheDocument();
    expect(container.querySelector(".control-column")).toBeInTheDocument();
    expect(container.querySelector(".response-column")).toBeInTheDocument();
    expect(container.querySelector(".trace-column")).toBeInTheDocument();
    expect(screen.queryByText("Runtime")).not.toBeInTheDocument();
  });

  it("使用护眼暖色主题变量", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).toContain("--eye-page: #fff2c6;");
    expect(styles).toContain("--eye-surface: #fff8df;");
    expect(styles).toContain("--eye-border: #eadfaf;");
    expect(styles).toContain("--eye-primary: #247a73;");
    expect(styles).toMatch(/body\s*{[^}]*background:\s*var\(--eye-page\);/s);
    expect(styles).toMatch(/\.panel\s*{[^}]*background:\s*var\(--eye-surface\);/s);
    expect(styles).toMatch(/\.primary-button\s*{[^}]*background:\s*var\(--eye-primary\);/s);
  });

  it("提交任务并展示回答和可折叠工具过程", async () => {
    window.history.replaceState(null, "", "/");
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session: { id: "session_1" },
          run: { id: "run_1", sessionId: "session_1", status: "running", input: "计算 12 * 9" }
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          const steps = [
            {
              type: "tool_call",
              toolName: "calculator",
              arguments: { expression: "12 * 9" },
              result: { value: 108 }
            }
          ];

          return {
            run: {
              id: "run_1",
              sessionId: "session_1",
              input: "计算 12 * 9",
              status: "completed",
              answer: "结果是 108",
              steps,
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:01.000Z",
              completedAt: "2026-06-22T00:00:01.000Z"
            },
            events: [
              {
                id: 1,
                runId: "run_1",
                event: {
                  type: "tool_start",
                  iteration: 0,
                  toolName: "calculator",
                  arguments: { expression: "12 * 9" }
                },
                createdAt: "2026-06-22T00:00:00.500Z"
              },
              {
                id: 2,
                runId: "run_1",
                event: {
                  type: "tool_result",
                  iteration: 0,
                  toolName: "calculator",
                  result: { value: 108 }
                },
                createdAt: "2026-06-22T00:00:00.800Z"
              },
              {
                id: 3,
                runId: "run_1",
                event: { type: "final_answer", answer: "结果是 108", steps },
                createdAt: "2026-06-22T00:00:01.000Z"
              }
            ]
          };
        }
      } as Response);

    render(<App />);

    await userEvent.clear(screen.getByLabelText("任务"));
    await userEvent.type(screen.getByLabelText("任务"), "计算 12 * 9");
    await userEvent.click(screen.getByRole("button", { name: "运行" }));

    await waitFor(() => expect(screen.getAllByText("结果是 108").length).toBeGreaterThan(0));
    expect(window.location.search).toBe("?sessionId=session_1");
    expect(screen.getByText("工具过程")).toBeInTheDocument();
    expect(screen.queryByText("工具步骤")).not.toBeInTheDocument();
    expect(screen.getAllByText(/"expression": "12 \* 9"/).length).toBeGreaterThan(0);
  });

  it("打开带 sessionId 的地址时优先恢复 URL 里的会话", async () => {
    window.history.replaceState(null, "", "/?sessionId=session_from_url");
    localStorage.setItem("agent.sessionId", "session_from_storage");
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session: {
            id: "session_from_url",
            title: "URL 会话",
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:00.000Z"
          },
          runs: [
            {
              id: "run_from_url",
              sessionId: "session_from_url",
              input: "从 URL 恢复",
              status: "completed",
              answer: "URL 会话回答",
              steps: [],
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:01.000Z",
              completedAt: "2026-06-22T00:00:01.000Z"
            }
          ]
        })
      } as Response);

    render(<App />);

    await waitFor(() => expect(screen.getByText("URL 会话回答")).toBeInTheDocument());
    expect(localStorage.getItem("agent.sessionId")).toBe("session_from_url");
    expect(globalThis.fetch).toHaveBeenCalledWith("http://localhost:4001/agents/sessions/session_from_url");
  });

  it("流式运行并展示 trace 时间线", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session: { id: "session_1" },
          run: { id: "run_1", sessionId: "session_1", status: "running", input: "你好" }
        })
      } as Response)
      .mockResolvedValueOnce(
        createStoredSseResponse("run_1", [
          { type: "iteration_start", iteration: 0 },
          { type: "agent_state", iteration: 0, state: "thinking", label: "模型思考中" },
          { type: "llm_start", iteration: 0 },
          { type: "answer_delta", iteration: 0, delta: "结果" },
          { type: "answer_delta", iteration: 0, delta: "是 108。" },
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
          { type: "final_answer", answer: "结果是 108。", steps: [] }
        ])
      );

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "流式运行" }));

    await waitFor(() => expect(screen.getAllByText("结果是 108。").length).toBeGreaterThan(0));
    expect(screen.getAllByText("模型思考中").length).toBeGreaterThan(0);
    expect(screen.getByText("请求模型")).toBeInTheDocument();
    expect(screen.getByText("准备工具：calculator")).toBeInTheDocument();
    expect(screen.getByText("调用工具：calculator")).toBeInTheDocument();
    expect(screen.getByText("工具结果：calculator")).toBeInTheDocument();
    expect(screen.getAllByText(/耗时 7ms/).length).toBeGreaterThan(0);
  });

  it("流式运行时用 answer_chunk 实时展示答案", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session: { id: "session_1" },
          run: { id: "run_1", sessionId: "session_1", status: "running", input: "用户问题" }
        })
      } as Response)
      .mockResolvedValueOnce(
        createStoredSseResponse("run_1", [
          { type: "iteration_start", iteration: 0 },
          { type: "agent_state", iteration: 0, state: "thinking", label: "模型思考中" },
          { type: "llm_start", iteration: 0 },
          { type: "answer_chunk", iteration: 0, text: "分块答案" }
        ])
      );

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "流式运行" }));

    await waitFor(() => expect(screen.getAllByText("分块答案").length).toBeGreaterThan(0));
    expect(screen.getByText("请求模型")).toBeInTheDocument();
  });

  it("刷新后根据本地 activeRunId 恢复事件流", async () => {
    localStorage.setItem("agent.activeRunId", "run_1");
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          run: {
            id: "run_1",
            sessionId: "session_1",
            input: "继续刚才的话题",
            status: "completed",
            answer: "恢复",
            steps: [],
            createdAt: "2026-06-22T00:00:00.000Z",
            updatedAt: "2026-06-22T00:00:01.000Z"
          },
          events: [
            {
              id: 1,
              runId: "run_1",
              event: { type: "iteration_start", iteration: 0 },
              createdAt: "2026-06-22T00:00:00.000Z"
            },
            {
              id: 2,
              runId: "run_1",
              event: { type: "answer_chunk", iteration: 0, text: "恢复" },
              createdAt: "2026-06-22T00:00:00.000Z"
            },
            {
              id: 3,
              runId: "run_1",
              event: { type: "final_answer", answer: "恢复", steps: [] },
              createdAt: "2026-06-22T00:00:00.000Z"
            }
          ]
        })
      } as Response);

    render(<App />);

    await waitFor(() => expect(screen.getAllByText("恢复").length).toBeGreaterThan(0));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:4001/agents/runs/run_1"
    );
  });

  it("卸载时取消刷新恢复的事件流订阅", async () => {
    localStorage.setItem("agent.activeRunId", "run_1");
    let streamSignal: AbortSignal | undefined;

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/health")) {
        return Promise.resolve({
          ok: true
        } as Response);
      }

      if (url.endsWith("/agents/runs/run_1")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            run: {
              id: "run_1",
              sessionId: "session_1",
              input: "你好",
              status: "running",
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:00.000Z"
            },
            events: []
          })
        } as Response);
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
