import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;
const timestamp = "2026-06-22T00:00:00.000Z";

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload
  } as Response;
}

function createStoredSseResponse(messageId: string): Response {
  const encoder = new TextEncoder();
  const storedEvent = {
    id: "event_1",
    runId: messageId,
    messageId,
    event: { type: "answer_delta", iteration: 0, delta: "恢复中" },
    createdAt: "2026-06-22T00:00:00.000Z"
  };

  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`id: event_1\ndata: ${JSON.stringify(storedEvent)}\n\n`));
        controller.close();
      }
    })
  } as Response;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  localStorage.clear();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("main", () => {
  it("入口初始化时只恢复一次事件流订阅", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    localStorage.setItem("agent.activeRunId", "msg_1");

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/health")) {
        return Promise.resolve({
          ok: true
        } as Response);
      }

      if (url.endsWith("/agents/sessions") && !url.endsWith("/agents/sessions/session_1")) {
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
            events: [
              {
                id: "event_1",
                runId: "msg_1",
                messageId: "msg_1",
                event: { type: "answer_delta", iteration: 0, delta: "恢复中" },
                createdAt: "2026-06-22T00:00:00.000Z"
              }
            ]
          })
        } as Response);
      }

      if (url.endsWith("/agents/sessions/session_1")) {
        return Promise.resolve(
          jsonResponse({
            session: {
              id: "session_1",
              title: "恢复会话",
              createdAt: timestamp,
              updatedAt: timestamp
            },
            messages: [
              {
                id: "msg_user_1",
                sessionId: "session_1",
                role: "user",
                status: "completed",
                parts: [{ type: "text", value: "恢复中的任务" }],
                createdAt: timestamp,
                updatedAt: timestamp
              },
              {
                id: "msg_1",
                sessionId: "session_1",
                role: "assistant",
                status: "running",
                parts: [{ type: "text", value: "" }],
                createdAt: timestamp,
                updatedAt: timestamp
              }
            ]
          })
        );
      }

      return Promise.resolve(createStoredSseResponse("msg_1"));
    });

    await import("./main");

    await waitFor(() => {
      const eventCalls = vi
        .mocked(globalThis.fetch)
        .mock.calls.filter(([url]) => String(url).includes("/agents/runs/msg_1/stream"));
      expect(eventCalls.length).toBeGreaterThan(0);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const eventCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => String(url).includes("/agents/runs/msg_1/stream"));
    expect(eventCalls).toHaveLength(1);
  });
});
