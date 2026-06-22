import { useEffect, useState } from "react";
import {
  getAgentRun,
  getAgentSession,
  startAgentRun,
  streamAgentRunEvents,
  type AgentRunDetailResponse,
  type AgentRunRecord,
  type AgentStreamEvent,
  type StoredAgentEvent
} from "./api/agent-client";
import { AgentConversation, type ChatMessage } from "./components/AgentConversation";
import { AgentTimeline } from "./components/AgentTimeline";
import { AgentRunForm } from "./components/AgentRunForm";
import { AgentRunOverview } from "./components/AgentRunOverview";
import "./styles.css";

const defaultInput = "计算 12 * 9，然后告诉我现在几点";
const activeRunIdKey = "agent.activeRunId";
const activeEventIdKey = "agent.activeEventId";
const sessionIdKey = "agent.sessionId";

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function toAssistantStatus(run: AgentRunRecord): ChatMessage["status"] {
  if (run.status === "failed") {
    return "failed";
  }

  if (run.status === "completed") {
    return "completed";
  }

  return "running";
}

function createRunMessages(run: AgentRunRecord): ChatMessage[] {
  const error = run.error ? `${run.error.code}: ${run.error.message}` : undefined;

  return [
    {
      id: `${run.id}:user`,
      role: "user",
      runId: run.id,
      content: run.input,
      status: "completed"
    },
    {
      id: `${run.id}:assistant`,
      role: "assistant",
      runId: run.id,
      content: run.answer ?? "",
      status: toAssistantStatus(run),
      steps: run.steps ?? [],
      events: [],
      error
    }
  ];
}

function buildMessagesFromRuns(runs: AgentRunRecord[]): ChatMessage[] {
  return [...runs]
    .sort((leftRun, rightRun) => leftRun.createdAt.localeCompare(rightRun.createdAt))
    .flatMap((run) => createRunMessages(run));
}

function mergeMessages(baseMessages: ChatMessage[], currentMessages: ChatMessage[]): ChatMessage[] {
  const currentById = new Map(currentMessages.map((message) => [message.id, message]));
  const usedIds = new Set<string>();
  const merged = baseMessages.map((message) => {
    const current = currentById.get(message.id);
    usedIds.add(message.id);
    return current ?? message;
  });

  for (const message of currentMessages) {
    if (!usedIds.has(message.id)) {
      merged.push(message);
    }
  }

  return merged;
}

function replaceRunMessages(currentMessages: ChatMessage[], runMessages: ChatMessage[]): ChatMessage[] {
  const runId = runMessages[0]?.runId;

  if (!runId) {
    return currentMessages;
  }

  return [...currentMessages.filter((message) => message.runId !== runId), ...runMessages];
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRunResult(runId: string): Promise<AgentRunDetailResponse> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const snapshot = await getAgentRun(runId);

    if (snapshot.run.status !== "running") {
      return snapshot;
    }

    await wait(250);
  }

  throw new Error("运行超时，请稍后查看会话结果");
}

export default function App() {
  const [input, setInput] = useState(defaultInput);
  const [maxIterations, setMaxIterations] = useState(4);
  const [isRunning, setIsRunning] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentStreamEvent[]>([]);
  const [health, setHealth] = useState("检查中");

  useEffect(() => {
    const controller = new AbortController();

    fetch(`${import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4001"}/health`, {
      signal: controller.signal
    })
      .then((response) => setHealth(response.ok ? "正常" : "异常"))
      .catch((healthError) => {
        if (!isAbortError(healthError)) {
          setHealth("异常");
        }
      });

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const sessionId = localStorage.getItem(sessionIdKey);

    if (!sessionId) {
      return;
    }

    let cancelled = false;

    getAgentSession(sessionId)
      .then(({ runs }) => {
        if (!cancelled) {
          setMessages((currentMessages) => mergeMessages(buildMessagesFromRuns(runs), currentMessages));
        }
      })
      .catch((sessionError) => {
        if (!cancelled) {
          localStorage.removeItem(sessionIdKey);
          setError(sessionError instanceof Error ? sessionError.message : "会话恢复失败");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const activeRunId = localStorage.getItem(activeRunIdKey);

    if (!activeRunId) {
      return;
    }

    const runId = activeRunId;
    let cancelled = false;
    const controller = new AbortController();

    async function recoverActiveRun() {
      setIsStreaming(true);
      setError(null);
      setEvents([]);

      try {
        const snapshot = await getAgentRun(runId);

        if (cancelled) {
          return;
        }

        setMessages((currentMessages) => replaceRunMessages(currentMessages, createRunMessages(snapshot.run)));
        setEvents([]);

        for (const storedEvent of snapshot.events) {
          if (cancelled) {
            return;
          }

          applyStoredEvent(storedEvent);
        }

        const lastEventId = snapshot.events[snapshot.events.length - 1]?.id ?? 0;

        if (snapshot.run.status !== "running") {
          clearActiveRun();
          return;
        }

        await streamAgentRunEvents(
          runId,
          lastEventId,
          (storedEvent) => {
            if (!cancelled) {
              applyStoredEvent(storedEvent);
            }
          },
          controller.signal
        );
      } catch (streamError) {
        if (!cancelled && !isAbortError(streamError)) {
          setError(streamError instanceof Error ? streamError.message : "流式请求失败");
        }
      } finally {
        if (!cancelled) {
          setIsStreaming(false);
        }
      }
    }

    void recoverActiveRun();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  function clearActiveRun() {
    localStorage.removeItem(activeRunIdKey);
    localStorage.removeItem(activeEventIdKey);
  }

  function upsertRun(run: AgentRunRecord) {
    setMessages((currentMessages) => replaceRunMessages(currentMessages, createRunMessages(run)));
  }

  function updateAssistantMessage(runId: string, update: (message: ChatMessage) => ChatMessage) {
    setMessages((currentMessages) =>
      currentMessages.map((message) => (message.id === `${runId}:assistant` ? update(message) : message))
    );
  }

  function applyAgentEvent(event: AgentStreamEvent, runId?: string) {
    setEvents((currentEvents) => [...currentEvents, event]);

    if (runId) {
      updateAssistantMessage(runId, (message) => {
        const nextEvents = [...(message.events ?? []), event];

        if (event.type === "answer_delta") {
          return {
            ...message,
            content: message.content + event.delta,
            status: "running",
            events: nextEvents
          };
        }

        if (event.type === "final_answer") {
          return {
            ...message,
            content: event.answer,
            status: "completed",
            steps: event.steps,
            events: nextEvents,
            error: undefined
          };
        }

        if (event.type === "error") {
          return {
            ...message,
            status: "failed",
            events: nextEvents,
            error: `${event.code}: ${event.message}`
          };
        }

        return {
          ...message,
          status: message.status === "completed" ? "completed" : "running",
          events: nextEvents
        };
      });
    }

    if (event.type === "final_answer") {
      clearActiveRun();
    }

    if (event.type === "error") {
      setError(`${event.code}: ${event.message}`);
      clearActiveRun();
    }
  }

  function applyStoredEvent(storedEvent: StoredAgentEvent) {
    localStorage.setItem(activeEventIdKey, String(storedEvent.id));
    applyAgentEvent(storedEvent.event, storedEvent.runId);
  }

  async function startRunWithCurrentSession(submittedInput: string) {
    const sessionId = localStorage.getItem(sessionIdKey) ?? undefined;

    try {
      return await startAgentRun(submittedInput, maxIterations, sessionId);
    } catch (error) {
      if (sessionId) {
        localStorage.removeItem(sessionIdKey);
        return startAgentRun(submittedInput, maxIterations);
      }

      throw error;
    }
  }

  async function handleRun() {
    const submittedInput = input.trim();

    if (!submittedInput) {
      return;
    }

    setIsRunning(true);
    setError(null);
    setEvents([]);

    try {
      const { session, run } = await startRunWithCurrentSession(submittedInput);
      localStorage.setItem(sessionIdKey, session.id);
      upsertRun(run);
      setInput("");

      const snapshot = await waitForRunResult(run.id);
      const runEvents = snapshot.events.map((storedEvent) => storedEvent.event);
      upsertRun(snapshot.run);
      setEvents(runEvents);
      updateAssistantMessage(run.id, (message) => ({
        ...message,
        events: runEvents
      }));

      if (snapshot.run.status === "failed") {
        setError(snapshot.run.error ? `${snapshot.run.error.code}: ${snapshot.run.error.message}` : "运行失败");
      }
    } catch (runError) {
      const message = runError instanceof Error ? runError.message : "请求失败";
      setError(message);
    } finally {
      setIsRunning(false);
    }
  }

  async function handleStreamRun() {
    const submittedInput = input.trim();

    if (!submittedInput) {
      return;
    }

    setIsStreaming(true);
    setError(null);
    setEvents([]);
    clearActiveRun();

    try {
      const { session, run } = await startRunWithCurrentSession(submittedInput);
      localStorage.setItem(sessionIdKey, session.id);
      localStorage.setItem(activeRunIdKey, run.id);
      localStorage.setItem(activeEventIdKey, "0");
      upsertRun(run);
      setInput("");
      await streamAgentRunEvents(run.id, 0, applyStoredEvent);
    } catch (streamError) {
      setError(streamError instanceof Error ? streamError.message : "流式请求失败");
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <main className="app-shell fullscreen-shell">
      <header className="topbar">
        <div>
          <h1>Agent Demo</h1>
          <p>Fastify + React 工具调用工作台</p>
        </div>
        <span className={health === "正常" ? "status ok" : "status"}>API {health}</span>
      </header>

      <div className="workspace">
        <aside className="control-column">
          <AgentRunForm
            input={input}
            maxIterations={maxIterations}
            isRunning={isRunning}
            isStreaming={isStreaming}
            onInputChange={setInput}
            onMaxIterationsChange={setMaxIterations}
            onSubmit={handleRun}
            onStreamSubmit={handleStreamRun}
          />
        </aside>

        <section className="response-column">
          <AgentRunOverview events={events} isActive={isRunning || isStreaming} />
          <AgentConversation messages={messages} isActive={isRunning || isStreaming} error={error} />
        </section>

        <aside className="trace-column">
          <section className="panel trace-panel">
            <div className="panel-heading compact">
              <div>
                <span className="eyebrow">Trace</span>
                <h2>事件时间线</h2>
              </div>
              <span className="count-pill">{events.length}</span>
            </div>
            <AgentTimeline events={events} />
          </section>
        </aside>
      </div>
    </main>
  );
}
