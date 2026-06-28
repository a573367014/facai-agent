import { Box, Chip, IconButton, Paper, Typography } from "@mui/material";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  cancelAgentRun,
  getAgentRun,
  getAgentSession,
  getAgentSessionMessages,
  listAgentSessions,
  startAgentRun,
  streamAgentRunEvents,
  type AgentMessagePageInfo,
  type AgentMessageRecord,
  type AgentRunRecord,
  type MessagePart,
  type AgentSessionRecord,
  type AgentStreamEvent,
  type StoredAgentEvent
} from "./api/agent-client";
import { AgentConversation, type ChatMessage } from "./components/AgentConversation";
import { AgentTimeline } from "./components/AgentTimeline";
import { AgentComposer } from "./components/AgentComposer";
import { SessionSidebar, type SessionHistoryItem } from "./components/SessionSidebar";
import { stripRuntimeFields, type RuntimePart } from "./prosemirror/part-serialization";
import "./styles.css";

const activeRunIdKey = "agent.activeRunId";
const activeEventSeqKey = "agent.activeEventSeq";
const sessionIdQueryKey = "sessionId";
const defaultMessagePageLimit = 30;

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
    parts: normalizeMessagePartsForDisplay(message),
    status: toChatMessageStatus(message.status),
    events: [],
    error
  };
}

function normalizeSummaryStatusText(value: string) {
  return value
    .replace("已自动压缩较早上下文，后续会基于摘要和最近消息继续对话", "上下文已自动压缩，后续会基于摘要和最近消息继续对话")
    .replace("已自动压缩较早上下文", "上下文已自动压缩")
    .replace("已自动整理较早上下文", "上下文已自动压缩")
    .replace("已自动压缩上下文", "上下文已自动压缩");
}

function normalizeMessagePartsForDisplay(message: AgentMessageRecord): MessagePart[] {
  if (message.role !== "system") {
    return message.parts;
  }

  return message.parts.map((part) => (part.type === "text" ? { ...part, value: normalizeSummaryStatusText(part.value) } : part));
}

function getMessageText(parts: MessagePart[]) {
  return parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.value.trim())
    .filter(Boolean)
    .join("\n");
}

function isSummarySystemMessage(message: ChatMessage) {
  if (message.role !== "system") {
    return false;
  }

  const text = getMessageText(message.parts);

  return text.includes("上下文") && (text.includes("压缩") || text.includes("整理"));
}

function shouldShowSummarySystemMessage(message: ChatMessage, options: { showRunningSummary?: boolean }) {
  if (!isSummarySystemMessage(message)) {
    return true;
  }

  if (message.status === "completed") {
    return true;
  }

  return Boolean(options.showRunningSummary && message.status === "running");
}

function normalizeVisibleMessages(messages: ChatMessage[], options: { showRunningSummary?: boolean } = {}): ChatMessage[] {
  const latestSummarySystemMessageId = [...messages].reverse().find((message) => shouldShowSummarySystemMessage(message, options) && isSummarySystemMessage(message))?.id;

  return messages.filter((message) => {
    if (!shouldShowSummarySystemMessage(message, options)) {
      return false;
    }

    return !isSummarySystemMessage(message) || message.id === latestSummarySystemMessageId;
  });
}

function buildMessagesFromRecords(messages: AgentMessageRecord[]): ChatMessage[] {
  const chatMessages = [...messages]
    .sort((leftMessage, rightMessage) => leftMessage.createdAt.localeCompare(rightMessage.createdAt))
    .map((message) => createMessageFromRecord(message));

  return normalizeVisibleMessages(chatMessages);
}

function createDefaultMessagePageInfo(): AgentMessagePageInfo {
  return {
    hasMore: false,
    limit: defaultMessagePageLimit
  };
}

function normalizeMessagePageInfo(pageInfo?: AgentMessagePageInfo): AgentMessagePageInfo {
  return pageInfo ?? createDefaultMessagePageInfo();
}

function prependMessagesFromRecords(currentMessages: ChatMessage[], olderMessages: AgentMessageRecord[]): ChatMessage[] {
  const prependedMessages = buildMessagesFromRecords(olderMessages);
  const prependedIds = new Set(prependedMessages.map((message) => message.id));

  return normalizeVisibleMessages([...prependedMessages, ...currentMessages.filter((message) => !prependedIds.has(message.id))], {
    showRunningSummary: true
  });
}

function replaceMessage(currentMessages: ChatMessage[], nextMessage: ChatMessage): ChatMessage[] {
  const exists = currentMessages.some((message) => message.id === nextMessage.id);

  if (!exists) {
    return [...currentMessages, nextMessage];
  }

  return currentMessages.map((message) => (message.id === nextMessage.id ? nextMessage : message));
}

function upsertMessageRecord(currentMessages: ChatMessage[], message: AgentMessageRecord): ChatMessage[] {
  return normalizeVisibleMessages(replaceMessage(currentMessages, createMessageFromRecord(message)), {
    showRunningSummary: true
  });
}

function markRunMessagesCancelled(currentMessages: ChatMessage[], run: AgentRunRecord): ChatMessage[] {
  const cancelledMessageIds = new Set([run.assistantMessageId, run.systemMessageId].filter((messageId): messageId is string => Boolean(messageId)));

  if (cancelledMessageIds.size === 0) {
    return currentMessages;
  }

  return normalizeVisibleMessages(currentMessages.flatMap((message) => {
    if (!cancelledMessageIds.has(message.id) || message.status !== "running") {
      return [message];
    }

    if (message.role === "system") {
      return [];
    }

    return [{
      ...message,
      status: "cancelled",
      error: undefined,
      parts: message.parts
    }];
  }), { showRunningSummary: true });
}

function setTextPartValue(parts: MessagePart[] = [], value: string): MessagePart[] {
  const textPartIndex = parts.findIndex((part) => part.type === "text");

  if (textPartIndex === -1) {
    return value ? [{ type: "text", value }, ...parts] : parts;
  }

  return parts.map((part, index) => (index === textPartIndex && part.type === "text" ? { ...part, value } : part));
}

function applyPartEventToMessage(message: ChatMessage, event: AgentStreamEvent): ChatMessage {
  if (event.type === "message.part.created") {
    const parts = [...(message.parts ?? [])];
    parts.splice(event.partIndex, 0, event.part);
    return { ...message, parts };
  }

  if (event.type === "message.part.delta") {
    return {
      ...message,
      parts: (message.parts ?? []).map((part, index) =>
        index === event.partIndex && part.type === "text" ? { ...part, value: part.value + event.delta } : part
      )
    };
  }

  if (event.type === "message.part.updated") {
    return {
      ...message,
      parts: (message.parts ?? []).map((part, index) => (index === event.partIndex ? event.part : part))
    };
  }

  return message;
}

function appendStartedMessages(currentMessages: ChatMessage[], userMessage: AgentMessageRecord): ChatMessage[] {
  const nextMessages = [createMessageFromRecord(userMessage)];
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
  const [composerParts, setComposerParts] = useState<RuntimePart[]>([{ type: "text", value: "" }]);
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const [maxIterations, setMaxIterations] = useState(4);
  const [isStreaming, setIsStreaming] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagePageInfo, setMessagePageInfo] = useState<AgentMessagePageInfo>(() => createDefaultMessagePageInfo());
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentStreamEvent[]>([]);
  const [health, setHealth] = useState("检查中");
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(() => readSessionIdFromUrl());
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [isSessionSidebarCollapsed, setIsSessionSidebarCollapsed] = useState(false);
  const [isTracePanelCollapsed, setIsTracePanelCollapsed] = useState(false);
  const activeStreamControllerRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<string | null>(null);

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
      .then(({ session, messages, pageInfo }) => {
        if (!cancelled) {
          upsertSession(session);
          setMessages(buildMessagesFromRecords(messages));
          setMessagePageInfo(normalizeMessagePageInfo(pageInfo));
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
    const storedActiveRunId = localStorage.getItem(activeRunIdKey);

    if (!storedActiveRunId) {
      return;
    }

    const runId = storedActiveRunId;
    let cancelled = false;
    const controller = new AbortController();

    async function recoverActiveRun() {
      setIsStreaming(true);
      setActiveRun(runId);
      activeStreamControllerRef.current = controller;
      setError(null);
      setEvents([]);

      try {
        const snapshot = await getAgentRun(runId);

        if (cancelled) {
          return;
        }

        rememberSession(snapshot.run.sessionId);
        const sessionSnapshot = await getAgentSession(snapshot.run.sessionId);

        if (cancelled) {
          return;
        }

        setMessages(buildMessagesFromRecords(sessionSnapshot.messages));
        setMessagePageInfo(normalizeMessagePageInfo(sessionSnapshot.pageInfo));
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
    activeRunIdRef.current = null;
    localStorage.removeItem(activeRunIdKey);
    localStorage.removeItem(activeEventSeqKey);
    setActiveRunId(null);
  }

  function setActiveRun(runId: string) {
    activeRunIdRef.current = runId;
    setActiveRunId(runId);
  }

  function releaseActiveRun(runId?: string) {
    if (runId && activeRunIdRef.current !== runId) {
      return;
    }

    clearActiveRun();
    activeStreamControllerRef.current = null;
    setIsStreaming(false);
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

  function updateAssistantMessage(messageId: string, update: (message: ChatMessage) => ChatMessage) {
    setMessages((currentMessages) => currentMessages.map((message) => (message.id === messageId ? update(message) : message)));
  }

  function applyAgentEvent(event: AgentStreamEvent, messageId?: string, runId?: string) {
    setEvents((currentEvents) => [...currentEvents, event]);

    if (event.type === "session.message.created" || event.type === "session.message.updated") {
      setMessages((currentMessages) => upsertMessageRecord(currentMessages, event.message));
    }

    if (messageId) {
      updateAssistantMessage(messageId, (message) => {
        const nextEvents = [...(message.events ?? []), event];

        if (
          event.type === "message.part.created" ||
          event.type === "message.part.delta" ||
          event.type === "message.part.updated"
        ) {
          return {
            ...applyPartEventToMessage(message, event),
            events: nextEvents
          };
        }

        if (event.type === "final_answer") {
          return {
            ...message,
            parts: setTextPartValue(message.parts, event.answer),
            status: "completed",
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

    if (event.type === "error") {
      setError(`${event.code}: ${event.message}`);
      clearActiveRun();
    }

    if (event.type === "cancelled") {
      clearActiveRun();
    }

    if (event.type === "run_completed") {
      releaseActiveRun(runId);
    }
  }

  function applyStoredEvent(storedEvent: StoredAgentEvent) {
    localStorage.setItem(activeEventSeqKey, String(storedEvent.seq));
    applyAgentEvent(storedEvent.event, storedEvent.messageId, storedEvent.runId);
  }

  async function startRunWithCurrentSession(submittedParts: MessagePart[]) {
    const sessionId = activeSessionId ?? readSessionIdFromUrl();

    try {
      return await startAgentRun(submittedParts, maxIterations, sessionId);
    } catch (error) {
      if (sessionId) {
        clearSessionIdFromUrl(sessionId);
        setActiveSessionId(undefined);
        return startAgentRun(submittedParts, maxIterations);
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
      setMessages((currentMessages) => markRunMessagesCancelled(currentMessages, run));
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
      const sessionId = activeSessionId ?? readSessionIdFromUrl();

      if (sessionId) {
        const sessionSnapshot = await getAgentSession(sessionId);
        setMessages(buildMessagesFromRecords(sessionSnapshot.messages));
        setMessagePageInfo(normalizeMessagePageInfo(sessionSnapshot.pageInfo));
      }

      await refreshSessions();
    }
  }

  async function handleSubmitMessage() {
    const submittedParts = stripRuntimeFields(composerParts).filter(
      (part) => part.type === "media" || (part.type === "text" && part.value.trim())
    );

    if (submittedParts.length === 0) {
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
      const { run, session, userMessage } = await startRunWithCurrentSession(submittedParts);
      rememberSession(session.id);
      upsertSession(session);
      setActiveRun(run.id);
      activeStreamControllerRef.current = controller;
      streamControllerAttached = true;
      localStorage.setItem(activeRunIdKey, run.id);
      localStorage.setItem(activeEventSeqKey, "0");
      setMessages((currentMessages) => appendStartedMessages(currentMessages, userMessage));
      setComposerParts([{ type: "text", value: "" }]);
      await streamAgentRunEvents(run.id, 0, applyStoredEvent, controller.signal);
      await refreshSessions();
    } catch (streamError) {
      if (!isAbortError(streamError) && (!streamControllerAttached || activeStreamControllerRef.current === controller)) {
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
    await cancelActiveRun();
  }

  function handleNewSession() {
    clearActiveRun();
    clearSessionIdFromUrl();
    setActiveSessionId(undefined);
    setComposerParts([{ type: "text", value: "" }]);
    setMessages([]);
    setMessagePageInfo(createDefaultMessagePageInfo());
    setIsLoadingOlderMessages(false);
    setEvents([]);
    setError(null);
  }

  function handleSuggestionSelect(suggestion: string) {
    setComposerParts([{ type: "text", value: suggestion }]);
    setComposerFocusToken((currentToken) => currentToken + 1);
  }

  async function handleSelectSession(sessionId: string) {
    if (sessionId === activeSessionId) {
      return;
    }

    clearActiveRun();
    setError(null);
    setEvents([]);

    try {
      const { session, messages, pageInfo } = await getAgentSession(sessionId);
      upsertSession(session);
      rememberSession(session.id);
      setMessages(buildMessagesFromRecords(messages));
      setMessagePageInfo(normalizeMessagePageInfo(pageInfo));
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : "会话恢复失败");
    }
  }

  async function handleLoadOlderMessages() {
    const sessionId = activeSessionId ?? readSessionIdFromUrl();
    const before = messagePageInfo.oldestCursor;

    if (!sessionId || !before || !messagePageInfo.hasMore || isLoadingOlderMessages) {
      return;
    }

    setIsLoadingOlderMessages(true);
    setError(null);

    try {
      const response = await getAgentSessionMessages(sessionId, {
        before,
        limit: messagePageInfo.limit || defaultMessagePageLimit
      });

      setMessages((currentMessages) => prependMessagesFromRecords(currentMessages, response.messages));
      setMessagePageInfo(response.pageInfo);
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : "加载历史消息失败");
    } finally {
      setIsLoadingOlderMessages(false);
    }
  }

  const historyItems = buildHistoryItems(sessions);
  const workspaceClassName = [
    "workspace",
    isSessionSidebarCollapsed ? "sidebar-collapsed" : null,
    isTracePanelCollapsed ? "trace-collapsed" : null
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Box component="main" className="app-shell fullscreen-shell">
      <Box className={workspaceClassName}>
        <SessionSidebar
          activeSessionId={activeSessionId}
          health={health}
          historyItems={historyItems}
          isCollapsed={isSessionSidebarCollapsed}
          isBusy={isStreaming}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
        />

        <Box component="section" className="chat-main response-column">
          <Box component="header" className="chat-main-header">
            <Box className="chat-header-side left">
              <IconButton
                aria-expanded={!isSessionSidebarCollapsed}
                aria-label={isSessionSidebarCollapsed ? "展开会话栏" : "收起会话栏"}
                className="sidebar-toggle chat-header-toggle"
                onClick={() => setIsSessionSidebarCollapsed((current) => !current)}
                size="small"
                type="button"
              >
                {isSessionSidebarCollapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
              </IconButton>
            </Box>

            <Box className="chat-main-title">
              <Typography component="h1" variant="h6">
                {activeSessionId ? "当前会话" : "新对话"}
              </Typography>
              <Typography component="p">AI 生成可能有误，请核实工具结果</Typography>
            </Box>

            <Box className="chat-header-side right">
              {isStreaming ? (
                <Chip className="generation-badge streaming" size="small" label="生成中" color="primary" variant="outlined" />
              ) : null}
              <IconButton
                aria-expanded={!isTracePanelCollapsed}
                aria-label={isTracePanelCollapsed ? "展开事件时间线" : "收起事件时间线"}
                className="sidebar-toggle chat-header-toggle"
                onClick={() => setIsTracePanelCollapsed((current) => !current)}
                size="small"
                type="button"
              >
                {isTracePanelCollapsed ? <ChevronsLeft size={18} /> : <ChevronsRight size={18} />}
              </IconButton>
            </Box>
          </Box>

          <AgentConversation
            messages={messages}
            isActive={isStreaming}
            error={error}
            hasMoreMessages={messagePageInfo.hasMore}
            isLoadingOlderMessages={isLoadingOlderMessages}
            onLoadOlderMessages={handleLoadOlderMessages}
            onSuggestionSelect={handleSuggestionSelect}
          />

          <AgentComposer
            parts={composerParts}
            maxIterations={maxIterations}
            isStreaming={isStreaming}
            focusToken={composerFocusToken}
            onPartsChange={setComposerParts}
            onMaxIterationsChange={setMaxIterations}
            onSubmit={handleSubmitMessage}
            onCancel={handleCancelMessage}
          />
        </Box>

        <Box component="aside" className={isTracePanelCollapsed ? "trace-column collapsed" : "trace-column"} aria-hidden={isTracePanelCollapsed ? true : undefined}>
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
