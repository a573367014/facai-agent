import { Box, Chip, Paper, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import {
  cancelAgentRun,
  getAgentRun,
  getAgentSession,
  listAgentSessions,
  startAgentRun,
  streamAgentRunEvents,
  type AgentRunRecord,
  type AgentSessionRecord,
  type AgentStreamEvent,
  type StoredAgentEvent
} from "./api/agent-client";
import { AgentConversation, type ChatMessage } from "./components/AgentConversation";
import { AgentTimeline } from "./components/AgentTimeline";
import { AgentRunForm } from "./components/AgentRunForm";
import { SessionSidebar, type SessionHistoryItem } from "./components/SessionSidebar";
import "./styles.css";

const legacySessionIdKey = "agent.sessionId";
const activeRunIdKey = "agent.activeRunId";
const activeEventSeqKey = "agent.activeEventSeq";
const sessionIdQueryKey = "sessionId";

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function toAssistantStatus(run: AgentRunRecord): ChatMessage["status"] {
  if (run.status === "failed") {
    return "failed";
  }

  if (run.status === "cancelled") {
    return "cancelled";
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

function compactTitle(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= 24) {
    return normalized;
  }

  return `${normalized.slice(0, 24)}...`;
}

function readSessionIdFromUrl(): string | undefined {
  const sessionId = new URLSearchParams(window.location.search).get(sessionIdQueryKey)?.trim();
  return sessionId || undefined;
}

function writeSessionIdToUrl(sessionId: string) {
  const url = new URL(window.location.href);

  if (url.searchParams.get(sessionIdQueryKey) === sessionId) {
    return;
  }

  url.searchParams.set(sessionIdQueryKey, sessionId);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function clearSessionIdFromUrl(sessionId?: string) {
  const url = new URL(window.location.href);

  if (sessionId && url.searchParams.get(sessionIdQueryKey) !== sessionId) {
    return;
  }

  url.searchParams.delete(sessionIdQueryKey);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function buildHistoryItems(sessions: AgentSessionRecord[]): SessionHistoryItem[] {
  return sessions.map((session) => ({
    id: session.id,
    title: compactTitle(session.title ?? "未命名会话")
  }));
}

export default function App() {
  const [input, setInput] = useState("");
  const [maxIterations, setMaxIterations] = useState(4);
  const [isStreaming, setIsStreaming] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentStreamEvent[]>([]);
  const [health, setHealth] = useState("检查中");
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(() => readSessionIdFromUrl());
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const activeStreamControllerRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    localStorage.removeItem(legacySessionIdKey);
  }, []);

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
    let cancelled = false;

    listAgentSessions()
      .then(({ sessions }) => {
        if (!cancelled) {
          setSessions(sessions);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSessions([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const sessionId = readSessionIdFromUrl();

    if (!sessionId) {
      return;
    }

    setActiveSessionId(sessionId);
    writeSessionIdToUrl(sessionId);

    let cancelled = false;

    getAgentSession(sessionId)
      .then(({ session, runs }) => {
        if (!cancelled) {
          upsertSession(session);
          setMessages((currentMessages) => mergeMessages(buildMessagesFromRuns(runs), currentMessages));
        }
      })
      .catch((sessionError) => {
        if (!cancelled) {
          clearSessionIdFromUrl(sessionId);
          setActiveSessionId(undefined);
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
      setActiveRunId(runId);
      activeStreamControllerRef.current = controller;
      setError(null);
      setEvents([]);

      try {
        const snapshot = await getAgentRun(runId);

        if (cancelled) {
          return;
        }

        rememberSession(snapshot.run.sessionId);
        setMessages((currentMessages) => replaceRunMessages(currentMessages, createRunMessages(snapshot.run)));
        setEvents([]);

        for (const storedEvent of snapshot.events) {
          if (cancelled) {
            return;
          }

          applyStoredEvent(storedEvent);
        }

        const lastEventSeq = snapshot.events[snapshot.events.length - 1]?.seq ?? 0;

        if (snapshot.run.status !== "running") {
          clearActiveRun();
          return;
        }

        await streamAgentRunEvents(
          runId,
          lastEventSeq,
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
          if (activeStreamControllerRef.current === controller) {
            activeStreamControllerRef.current = null;
          }
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
    localStorage.removeItem(activeEventSeqKey);
    setActiveRunId(null);
  }

  function upsertSession(session: AgentSessionRecord) {
    setSessions((currentSessions) => {
      const withoutSession = currentSessions.filter((candidate) => candidate.id !== session.id);
      return [session, ...withoutSession].sort((leftSession, rightSession) =>
        rightSession.updatedAt.localeCompare(leftSession.updatedAt)
      );
    });
  }

  async function refreshSessions() {
    const response = await listAgentSessions();
    setSessions(response.sessions);
  }

  function rememberSession(sessionId: string) {
    setActiveSessionId(sessionId);
    writeSessionIdToUrl(sessionId);
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

        if (event.type === "answer_delta" || event.type === "answer_chunk") {
          return {
            ...message,
            content: message.content + (event.type === "answer_delta" ? event.delta : event.text),
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

        if (event.type === "cancelled") {
          return {
            ...message,
            status: "cancelled",
            events: nextEvents,
            error: undefined
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

    if (event.type === "cancelled") {
      clearActiveRun();
    }
  }

  function applyStoredEvent(storedEvent: StoredAgentEvent) {
    localStorage.setItem(activeEventSeqKey, String(storedEvent.seq));
    applyAgentEvent(storedEvent.event, storedEvent.runId);
  }

  async function startRunWithCurrentSession(submittedInput: string) {
    const sessionId = activeSessionId ?? readSessionIdFromUrl();

    try {
      return await startAgentRun(submittedInput, maxIterations, sessionId);
    } catch (error) {
      if (sessionId) {
        clearSessionIdFromUrl(sessionId);
        setActiveSessionId(undefined);
        return startAgentRun(submittedInput, maxIterations);
      }

      throw error;
    }
  }

  async function cancelActiveRun({ refreshAfterCancel = true, settleStreaming = true } = {}) {
    if (!activeRunId) {
      return;
    }

    const runId = activeRunId;
    const controller = activeStreamControllerRef.current;

    controller?.abort();

    try {
      const { run } = await cancelAgentRun(runId);
      upsertRun(run);
      setError(null);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "中断失败");
    } finally {
      clearActiveRun();

      if (activeStreamControllerRef.current === controller) {
        activeStreamControllerRef.current = null;
      }

      if (settleStreaming) {
        setIsStreaming(false);
      }
    }

    if (refreshAfterCancel) {
      await refreshSessions();
    }
  }

  async function handleSubmitRun() {
    const submittedInput = input.trim();

    if (!submittedInput) {
      return;
    }

    if (activeRunId) {
      await cancelActiveRun({ refreshAfterCancel: false, settleStreaming: false });
    }

    setIsStreaming(true);
    setError(null);
    setEvents([]);
    clearActiveRun();
    const controller = new AbortController();
    let streamControllerAttached = false;

    try {
      const { session, run } = await startRunWithCurrentSession(submittedInput);
      rememberSession(session.id);
      upsertSession(session);
      setActiveRunId(run.id);
      activeStreamControllerRef.current = controller;
      streamControllerAttached = true;
      localStorage.setItem(activeRunIdKey, run.id);
      localStorage.setItem(activeEventSeqKey, "0");
      upsertRun(run);
      setInput("");
      await streamAgentRunEvents(run.id, 0, applyStoredEvent, controller.signal);
      await refreshSessions();
    } catch (streamError) {
      if (!isAbortError(streamError)) {
        setError(streamError instanceof Error ? streamError.message : "流式请求失败");
      }
    } finally {
      if (!streamControllerAttached || activeStreamControllerRef.current === controller) {
        setIsStreaming(false);
      }

      if (activeStreamControllerRef.current === controller) {
        activeStreamControllerRef.current = null;
      }
    }
  }

  async function handleCancelRun() {
    await cancelActiveRun();
  }

  function handleNewSession() {
    clearActiveRun();
    clearSessionIdFromUrl();
    setActiveSessionId(undefined);
    setInput("");
    setMessages([]);
    setEvents([]);
    setError(null);
  }

  function handleSuggestionSelect(suggestion: string) {
    setInput(suggestion);
    inputRef.current?.focus();
  }

  async function handleSelectSession(sessionId: string) {
    if (sessionId === activeSessionId) {
      return;
    }

    clearActiveRun();
    setError(null);
    setEvents([]);

    try {
      const { session, runs } = await getAgentSession(sessionId);
      upsertSession(session);
      rememberSession(session.id);
      setMessages(buildMessagesFromRuns(runs));
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : "会话恢复失败");
    }
  }

  const historyItems = buildHistoryItems(sessions);

  return (
    <Box component="main" className="app-shell fullscreen-shell">
      <Box className="workspace">
        <SessionSidebar
          activeSessionId={activeSessionId}
          health={health}
          historyItems={historyItems}
          isBusy={isStreaming}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
        />

        <Box component="section" className="chat-main response-column">
          <Box component="header" className="chat-main-header">
            <Box>
              <Typography component="h1" variant="h6">
                {activeSessionId ? "当前会话" : "新对话"}
              </Typography>
              <Typography component="p">AI 生成可能有误，请核实工具结果</Typography>
            </Box>
            {isStreaming ? (
              <Chip className="run-badge streaming" size="small" label="生成中" color="primary" variant="outlined" />
            ) : null}
          </Box>

          <AgentConversation
            messages={messages}
            isActive={isStreaming}
            error={error}
            onSuggestionSelect={handleSuggestionSelect}
          />

          <AgentRunForm
            input={input}
            inputRef={inputRef}
            maxIterations={maxIterations}
            isStreaming={isStreaming}
            onInputChange={setInput}
            onMaxIterationsChange={setMaxIterations}
            onSubmit={handleSubmitRun}
            onCancel={handleCancelRun}
          />
        </Box>

        <Box component="aside" className="trace-column">
          <Paper component="section" className="panel trace-panel" elevation={0}>
            <Box className="panel-heading compact">
              <Box>
                <span className="eyebrow">Trace</span>
                <Typography component="h2" variant="h6">
                  事件时间线
                </Typography>
              </Box>
              <Chip className="count-pill" size="small" label={events.length} />
            </Box>
            <AgentTimeline events={events} />
          </Paper>
        </Box>
      </Box>
    </Box>
  );
}
