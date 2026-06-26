import { Box, Chip, Paper, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import {
  cancelAgentMessage,
  getAgentMessage,
  getAgentSession,
  listAgentSessions,
  startAgentMessage,
  streamAgentMessageEvents,
  type AgentMessageRecord,
  type AgentSessionRecord,
  type AgentStreamEvent,
  type StoredAgentEvent
} from "./api/agent-client";
import { AgentConversation, type ChatMessage } from "./components/AgentConversation";
import { AgentTimeline } from "./components/AgentTimeline";
import { AgentComposer } from "./components/AgentComposer";
import { SessionSidebar, type SessionHistoryItem } from "./components/SessionSidebar";
import "./styles.css";

const activeMessageIdKey = "agent.activeMessageId";
const activeEventSeqKey = "agent.activeEventSeq";
const sessionIdQueryKey = "sessionId";

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function toChatMessageStatus(status: AgentMessageRecord["status"]): ChatMessage["status"] {
  return status;
}

function createMessageFromRecord(message: AgentMessageRecord): ChatMessage {
  const error = message.error ? `${message.error.code}: ${message.error.message}` : undefined;

  return {
    id: message.id,
    role: message.role,
    content: message.content,
    status: toChatMessageStatus(message.status),
    steps: message.steps ?? [],
    assets: message.assets ?? [],
    events: [],
    error
  };
}

function buildMessagesFromRecords(messages: AgentMessageRecord[]): ChatMessage[] {
  return [...messages]
    .sort((leftMessage, rightMessage) => leftMessage.createdAt.localeCompare(rightMessage.createdAt))
    .map((message) => createMessageFromRecord(message));
}

function replaceMessage(currentMessages: ChatMessage[], nextMessage: ChatMessage): ChatMessage[] {
  const exists = currentMessages.some((message) => message.id === nextMessage.id);

  if (!exists) {
    return [...currentMessages, nextMessage];
  }

  return currentMessages.map((message) => (message.id === nextMessage.id ? nextMessage : message));
}

function appendStartedMessages(
  currentMessages: ChatMessage[],
  userMessage: AgentMessageRecord,
  assistantMessage: AgentMessageRecord
): ChatMessage[] {
  const nextMessages = [createMessageFromRecord(userMessage), createMessageFromRecord(assistantMessage)];
  const nextIds = new Set(nextMessages.map((message) => message.id));

  return [...currentMessages.filter((message) => !nextIds.has(message.id)), ...nextMessages];
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
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const activeStreamControllerRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

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
      .then(({ session, messages }) => {
        if (!cancelled) {
          upsertSession(session);
          setMessages(buildMessagesFromRecords(messages));
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
    const storedActiveMessageId = localStorage.getItem(activeMessageIdKey);

    if (!storedActiveMessageId) {
      return;
    }

    const messageId = storedActiveMessageId;
    let cancelled = false;
    const controller = new AbortController();

    async function recoverActiveMessage() {
      setIsStreaming(true);
      setActiveMessageId(messageId);
      activeStreamControllerRef.current = controller;
      setError(null);
      setEvents([]);

      try {
        const snapshot = await getAgentMessage(messageId);

        if (cancelled) {
          return;
        }

        rememberSession(snapshot.message.sessionId);
        const sessionSnapshot = await getAgentSession(snapshot.message.sessionId);

        if (cancelled) {
          return;
        }

        setMessages(buildMessagesFromRecords(sessionSnapshot.messages));
        setEvents([]);

        for (const storedEvent of snapshot.events) {
          if (cancelled) {
            return;
          }

          applyStoredEvent(storedEvent);
        }

        const lastEventSeq = snapshot.events[snapshot.events.length - 1]?.seq ?? 0;

        if (snapshot.message.status !== "running") {
          clearActiveMessage();
          return;
        }

        await streamAgentMessageEvents(
          messageId,
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

    void recoverActiveMessage();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  function clearActiveMessage() {
    localStorage.removeItem(activeMessageIdKey);
    localStorage.removeItem(activeEventSeqKey);
    setActiveMessageId(null);
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

  function upsertMessage(message: AgentMessageRecord) {
    setMessages((currentMessages) => replaceMessage(currentMessages, createMessageFromRecord(message)));
  }

  function updateAssistantMessage(messageId: string, update: (message: ChatMessage) => ChatMessage) {
    setMessages((currentMessages) => currentMessages.map((message) => (message.id === messageId ? update(message) : message)));
  }

  function applyAgentEvent(event: AgentStreamEvent, messageId?: string) {
    setEvents((currentEvents) => [...currentEvents, event]);

    if (messageId) {
      updateAssistantMessage(messageId, (message) => {
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
      clearActiveMessage();
    }

    if (event.type === "error") {
      setError(`${event.code}: ${event.message}`);
      clearActiveMessage();
    }

    if (event.type === "cancelled") {
      clearActiveMessage();
    }
  }

  function applyStoredEvent(storedEvent: StoredAgentEvent) {
    localStorage.setItem(activeEventSeqKey, String(storedEvent.seq));
    applyAgentEvent(storedEvent.event, storedEvent.messageId);
  }

  async function startMessageWithCurrentSession(submittedInput: string) {
    const sessionId = activeSessionId ?? readSessionIdFromUrl();

    try {
      return await startAgentMessage(submittedInput, maxIterations, sessionId);
    } catch (error) {
      if (sessionId) {
        clearSessionIdFromUrl(sessionId);
        setActiveSessionId(undefined);
        return startAgentMessage(submittedInput, maxIterations);
      }

      throw error;
    }
  }

  async function cancelActiveMessage({ refreshAfterCancel = true, settleStreaming = true } = {}) {
    if (!activeMessageId) {
      return;
    }

    const messageId = activeMessageId;
    const controller = activeStreamControllerRef.current;

    controller?.abort();

    try {
      const { message } = await cancelAgentMessage(messageId);
      upsertMessage(message);
      setError(null);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "中断失败");
    } finally {
      clearActiveMessage();

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

  async function handleSubmitMessage() {
    const submittedInput = input.trim();

    if (!submittedInput) {
      return;
    }

    if (activeMessageId) {
      await cancelActiveMessage({ refreshAfterCancel: false, settleStreaming: false });
    }

    setIsStreaming(true);
    setError(null);
    setEvents([]);
    clearActiveMessage();
    const controller = new AbortController();
    let streamControllerAttached = false;

    try {
      const { session, userMessage, assistantMessage } = await startMessageWithCurrentSession(submittedInput);
      rememberSession(session.id);
      upsertSession(session);
      setActiveMessageId(assistantMessage.id);
      activeStreamControllerRef.current = controller;
      streamControllerAttached = true;
      localStorage.setItem(activeMessageIdKey, assistantMessage.id);
      localStorage.setItem(activeEventSeqKey, "0");
      setMessages((currentMessages) => appendStartedMessages(currentMessages, userMessage, assistantMessage));
      setInput("");
      await streamAgentMessageEvents(assistantMessage.id, 0, applyStoredEvent, controller.signal);
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

  async function handleCancelMessage() {
    await cancelActiveMessage();
  }

  function handleNewSession() {
    clearActiveMessage();
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

    clearActiveMessage();
    setError(null);
    setEvents([]);

    try {
      const { session, messages } = await getAgentSession(sessionId);
      upsertSession(session);
      rememberSession(session.id);
      setMessages(buildMessagesFromRecords(messages));
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
              <Chip className="generation-badge streaming" size="small" label="生成中" color="primary" variant="outlined" />
            ) : null}
          </Box>

          <AgentConversation
            messages={messages}
            isActive={isStreaming}
            error={error}
            onSuggestionSelect={handleSuggestionSelect}
          />

          <AgentComposer
            input={input}
            inputRef={inputRef}
            maxIterations={maxIterations}
            isStreaming={isStreaming}
            onInputChange={setInput}
            onMaxIterationsChange={setMaxIterations}
            onSubmit={handleSubmitMessage}
            onCancel={handleCancelMessage}
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
