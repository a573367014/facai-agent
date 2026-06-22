import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;

function createStoredSseResponse(runId: string): Response {
  const encoder = new TextEncoder();
  const storedEvent = {
    id: 1,
    runId,
    event: { type: "answer_delta", iteration: 0, delta: "恢复中" },
    createdAt: "2026-06-22T00:00:00.000Z"
  };

  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`id: 1\ndata: ${JSON.stringify(storedEvent)}\n\n`));
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
    localStorage.setItem("agent.activeRunId", "run_1");

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
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
              input: "恢复中的任务",
              status: "running",
              createdAt: "2026-06-22T00:00:00.000Z",
              updatedAt: "2026-06-22T00:00:00.000Z"
            },
            events: [
              {
                id: 1,
                runId: "run_1",
                event: { type: "answer_delta", iteration: 0, delta: "恢复中" },
                createdAt: "2026-06-22T00:00:00.000Z"
              }
            ]
          })
        } as Response);
      }

      return Promise.resolve(createStoredSseResponse("run_1"));
    });

    await import("./main");

    await waitFor(() => {
      const eventCalls = vi
        .mocked(globalThis.fetch)
        .mock.calls.filter(([url]) => String(url).includes("/agents/runs/run_1/events?after=1"));
      expect(eventCalls.length).toBeGreaterThan(0);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const eventCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => String(url).includes("/agents/runs/run_1/events?after=1"));
    expect(eventCalls).toHaveLength(1);
  });
});
