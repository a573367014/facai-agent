import { Box, Chip, IconButton, Paper, Typography } from "@mui/material";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  apiBaseUrl,
  cancelAgentRun,
  deleteAgentSession,
  getAgentRun,
  getAgentSession,
  getAgentSessionMessages,
  listAgentSessions,
  regenerateAgentMessage,
  startAgentRun,
  streamAgentRunEvents,
  uploadAgentImage,
  type AgentMessagePageInfo,
  type AgentMessageRecord,
  type AgentProcessStepRecord,
  type AgentResourceRecord,
  type AgentRunRecord,
  type AgentSessionPageInfo,
  type MessagePart,
  type AgentSessionRecord,
  type AgentStreamEvent,
  type StoredAgentEvent
} from "./api/agent-client";
import { AgentConversation, type ChatMessage } from "./components/AgentConversation";
import { AgentTimeline } from "./components/AgentTimeline";
import { AgentComposer } from "./components/AgentComposer";
import { SessionSidebar, type SessionHistoryItem } from "./components/SessionSidebar";
import type { ToolImageActionPayload } from "./components/ToolResultPreview";
import { stripRuntimeFields, type RuntimePart } from "./prosemirror/part-serialization";
import "./styles.css";

const activeRunIdKey = "agent.activeRunId";
const activeEventSeqKey = "agent.activeEventSeq";
const runningRunsBySessionKey = "agent.runningRunsBySession";
const sessionIdQueryKey = "sessionId";
const defaultMessagePageLimit = 30;
const defaultSessionPageLimit = 30;

type ResourceMap = Record<string, AgentResourceRecord>;
type RunningRunState = { runId: string; lastSeq: number };
type RunningRunsBySession = Record<string, RunningRunState>;

function readRunningRunsBySession(): RunningRunsBySession {
  // 这里记录“每个会话当前还在跑的 run”。
  // 用户切换会话或刷新页面后，前端可以用 runId + lastSeq 重新接上 SSE，而不是丢掉正在生成的回答。
  try {
    const rawValue = localStorage.getItem(runningRunsBySessionKey);

    if (!rawValue) {
      return {};
    }

    const parsedValue = JSON.parse(rawValue) as Record<string, unknown>;
    const runningRuns: RunningRunsBySession = {};

    for (const [sessionId, value] of Object.entries(parsedValue)) {
      if (!value || typeof value !== "object") {
        continue;
      }

      const candidate = value as Partial<RunningRunState>;

      if (typeof candidate.runId === "string") {
        runningRuns[sessionId] = {
          runId: candidate.runId,
          lastSeq: typeof candidate.lastSeq === "number" && Number.isFinite(candidate.lastSeq) ? candidate.lastSeq : 0
        };
      }
    }

    return runningRuns;
  } catch {
    return {};
  }
}

function writeRunningRunsBySession(runningRuns: RunningRunsBySession) {
  if (Object.keys(runningRuns).length === 0) {
    localStorage.removeItem(runningRunsBySessionKey);
    return;
  }

  localStorage.setItem(runningRunsBySessionKey, JSON.stringify(runningRuns));
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function toChatMessageStatus(status: AgentMessageRecord["status"]): ChatMessage["status"] {
  return status;
}

function createMessageFromRecord(
  message: AgentMessageRecord,
  options: { version?: number; processSteps?: AgentProcessStepRecord[] } = {}
): ChatMessage {
  const error = message.error ? `${message.error.code}: ${message.error.message}` : undefined;

  return {
    id: message.id,
    role: message.role,
    parts: normalizeMessagePartsForDisplay(message),
    status: toChatMessageStatus(message.status),
    version: options.version,
    processSteps: options.processSteps ?? [],
    events: [],
    error,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    completedAt: message.completedAt
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
  // system 消息主要承载“上下文压缩中/已压缩”这类状态。
  // 聊天窗口只保留最新一条已完成摘要提示，避免历史里堆一长串系统提示影响阅读。
  const latestSummarySystemMessageId = [...messages].reverse().find((message) => shouldShowSummarySystemMessage(message, options) && isSummarySystemMessage(message))?.id;

  return messages.filter((message) => {
    if (!shouldShowSummarySystemMessage(message, options)) {
      return false;
    }

    return !isSummarySystemMessage(message) || message.id === latestSummarySystemMessageId;
  });
}

function groupProcessStepsByMessage(processSteps: AgentProcessStepRecord[] = []) {
  const stepsByMessage = new Map<string, AgentProcessStepRecord[]>();

  for (const step of processSteps) {
    stepsByMessage.set(step.messageId, [...(stepsByMessage.get(step.messageId) ?? []), step]);
  }

  return stepsByMessage;
}

function sortProcessSteps(processSteps: AgentProcessStepRecord[] = []) {
  return [...processSteps].sort(
    (leftStep, rightStep) => leftStep.orderIndex - rightStep.orderIndex || leftStep.startedAt.localeCompare(rightStep.startedAt)
  );
}

function upsertProcessStep(processSteps: AgentProcessStepRecord[] = [], step: AgentProcessStepRecord): AgentProcessStepRecord[] {
  const withoutStep = processSteps.filter((candidate) => candidate.id !== step.id);
  return sortProcessSteps([...withoutStep, step]);
}

function buildMessagesFromRecords(messages: AgentMessageRecord[], processSteps: AgentProcessStepRecord[] = []): ChatMessage[] {
  const stepsByMessage = groupProcessStepsByMessage(processSteps);
  const chatMessages = [...messages]
    .sort((leftMessage, rightMessage) => leftMessage.createdAt.localeCompare(rightMessage.createdAt))
    .map((message) => createMessageFromRecord(message, { processSteps: sortProcessSteps(stepsByMessage.get(message.id)) }));

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

function createDefaultSessionPageInfo(): AgentSessionPageInfo {
  return {
    hasMore: false,
    limit: defaultSessionPageLimit
  };
}

function normalizeSessionPageInfo(pageInfo?: AgentSessionPageInfo): AgentSessionPageInfo {
  return pageInfo ?? createDefaultSessionPageInfo();
}

function resourcesToMap(resources: AgentResourceRecord[] = []): ResourceMap {
  return Object.fromEntries(resources.map((resource) => [resource.id, resource]));
}

function mergeResources(currentResources: ResourceMap, resources: AgentResourceRecord[] = []): ResourceMap {
  if (resources.length === 0) {
    return currentResources;
  }

  return {
    ...currentResources,
    ...resourcesToMap(resources)
  };
}

function prependMessagesFromRecords(
  currentMessages: ChatMessage[],
  olderMessages: AgentMessageRecord[],
  processSteps: AgentProcessStepRecord[] = []
): ChatMessage[] {
  const prependedMessages = buildMessagesFromRecords(olderMessages, processSteps);
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

function upsertMessageRecord(currentMessages: ChatMessage[], message: AgentMessageRecord, options: { version?: number } = {}): ChatMessage[] {
  const existingMessage = currentMessages.find((currentMessage) => currentMessage.id === message.id);
  const version = options.version ?? existingMessage?.version;

  return normalizeVisibleMessages(replaceMessage(currentMessages, createMessageFromRecord(message, {
    version,
    processSteps: existingMessage?.processSteps
  })), {
    showRunningSummary: true
  });
}

function upsertMessageSnapshot(currentMessages: ChatMessage[], event: Extract<AgentStreamEvent, { type: "message.snapshot" }>): ChatMessage[] {
  const existingMessage = currentMessages.find((message) => message.id === event.message.id);

  // snapshot 是后端给前端的“消息当前完整状态”，常用于重连后校准。
  // 如果本地已经收到更高版本的 part 事件，就不要被旧 snapshot 覆盖。
  if (isOlderSnapshotVersion(existingMessage, event.version)) {
    return currentMessages;
  }

  return normalizeVisibleMessages(replaceMessage(currentMessages, createMessageFromRecord(event.message, {
    version: event.version,
    processSteps: sortProcessSteps(event.processSteps)
  })), {
    showRunningSummary: true
  });
}

function isOlderSnapshotVersion(message: ChatMessage | undefined, eventVersion: number | undefined) {
  return typeof eventVersion === "number" && typeof message?.version === "number" && eventVersion < message.version;
}

function isDuplicateOrOlderPartVersion(message: ChatMessage, event: AgentStreamEvent) {
  if (
    event.type !== "message.part.created" &&
    event.type !== "message.part.delta" &&
    event.type !== "message.part.updated"
  ) {
    return false;
  }

  // part 事件可能因为重连回放而重复到达。
  // version 是消息级别的递增号，用它挡住重复/更旧事件，可以避免 delta 被追加两次。
  return typeof event.version === "number" && typeof message.version === "number" && event.version <= message.version;
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

function compactMessageParts(parts: Array<MessagePart | undefined> = []): MessagePart[] {
  // SSE 事件乱序或缺少前置 part 时，直接 parts[1] = xxx 会制造“空洞数组”。
  // React 渲染和 final_answer 都会遍历 parts，所以进入核心逻辑前先压成真正连续的数组。
  return parts.filter((part): part is MessagePart => Boolean(part));
}

function createEmptyTextPart(): MessagePart {
  return { type: "text", value: "" };
}

function normalizePartIndex(partIndex: number) {
  return Number.isInteger(partIndex) && partIndex >= 0 ? partIndex : 0;
}

function padMissingPartsBeforeIndex(parts: MessagePart[] = [], partIndex: number): MessagePart[] {
  const safePartIndex = normalizePartIndex(partIndex);
  const nextParts = compactMessageParts(parts);

  // 后端的 partIndex 是“最终消息里的位置”。
  // 比如视频 partIndex=1 先到，但文本 partIndex=0 还没到，前端先补一个空文本位；
  // 后面的 final_answer 或 message.part.updated 再把这个空位填成真正正文。
  while (nextParts.length < safePartIndex) {
    nextParts.push(createEmptyTextPart());
  }

  return nextParts;
}

function setTextPartValue(parts: MessagePart[] = [], value: string): MessagePart[] {
  const denseParts = compactMessageParts(parts);
  const textPartIndex = denseParts.findIndex((part) => part.type === "text");

  if (textPartIndex === -1) {
    return value ? [{ type: "text", value }, ...denseParts] : denseParts;
  }

  return denseParts.map((part, index) => (index === textPartIndex && part.type === "text" ? { ...part, value } : part));
}

function applyPartEventToMessage(message: ChatMessage, event: AgentStreamEvent): ChatMessage {
  // 后端不会每次都重发整条消息：流式文本用 delta，媒体/占位用 created/updated。
  // 这个函数只负责把“一个 part 事件”折叠到当前 ChatMessage 上。
  if (event.type === "message.part.created") {
    const partIndex = normalizePartIndex(event.partIndex);
    const parts = padMissingPartsBeforeIndex(message.parts, partIndex);
    parts.splice(partIndex, 0, event.part);
    return { ...message, parts, version: event.version ?? message.version };
  }

  if (event.type === "message.part.delta") {
    const partIndex = normalizePartIndex(event.partIndex);
    const parts = padMissingPartsBeforeIndex(message.parts, partIndex);
    const targetPart = parts[partIndex];

    if (!targetPart) {
      parts[partIndex] = { type: "text", value: event.delta };
      return {
        ...message,
        version: event.version ?? message.version,
        parts
      };
    }

    if (targetPart.type !== "text") {
      parts.splice(partIndex, 0, { type: "text", value: event.delta });
      return {
        ...message,
        version: event.version ?? message.version,
        parts
      };
    }

    return {
      ...message,
      version: event.version ?? message.version,
      parts: parts.map((part, index) =>
        index === partIndex && part.type === "text" ? { ...part, value: part.value + event.delta } : part
      )
    };
  }

  if (event.type === "message.part.updated") {
    const partIndex = normalizePartIndex(event.partIndex);
    const parts = padMissingPartsBeforeIndex(message.parts, partIndex);

    if (!parts[partIndex]) {
      parts[partIndex] = event.part;
      return {
        ...message,
        version: event.version ?? message.version,
        parts
      };
    }

    return {
      ...message,
      version: event.version ?? message.version,
      parts: parts.map((part, index) => (index === partIndex ? event.part : part))
    };
  }

  return message;
}

function createStreamingAssistantMessage(messageId: string, event: AgentStreamEvent): ChatMessage {
  const now = new Date().toISOString();

  return {
    id: messageId,
    role: "assistant",
    parts: event.type === "message.part.created" ? [] : [{ type: "text", value: "" }],
    status: "running",
    processSteps: [],
    events: [],
    createdAt: now,
    updatedAt: now
  };
}

function shouldCreateAssistantMessageForEvent(event: AgentStreamEvent) {
  return (
    event.type === "message.part.created" ||
    event.type === "message.part.delta" ||
    event.type === "message.part.updated" ||
    event.type === "final_answer"
  );
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

function appendQuotedMediaPart(currentParts: RuntimePart[], quotedMediaPart: RuntimePart): RuntimePart[] {
  const meaningfulParts = currentParts.filter((part) => part.type === "media" || (part.type === "text" && part.value.trim()));

  if (meaningfulParts.length === 0) {
    return [quotedMediaPart];
  }

  return [...currentParts, quotedMediaPart];
}

function createQuotedMediaPart(payload: ToolImageActionPayload): RuntimePart {
  const prompt = payload.prompt.trim();
  const mime = payload.mime ?? inferMediaMimeFromUrl(payload.url);
  const mediaLabel = getMediaLabel(mime);
  const name = prompt || `${mediaLabel} ${payload.index + 1}`;
  const tool =
    payload.trace.toolName === "media"
      ? undefined
      : {
          name: payload.trace.toolName,
          toolCallId: payload.trace.id,
          ...(payload.toolCallRowId ? { toolCallRowId: payload.toolCallRowId } : {}),
          outputIndex: payload.outputIndex ?? payload.index
        };

  return {
    type: "media",
    mime,
    url: payload.url,
    name,
    ...(typeof payload.width === "number" ? { width: payload.width } : {}),
    ...(typeof payload.height === "number" ? { height: payload.height } : {}),
    extra: {
      lifecycle: { state: "succeeded" },
      ...(payload.resourceId ? { resource: { id: payload.resourceId } } : {}),
      ...(tool ? { tool } : {}),
      ...(prompt ? { generation: { prompt } } : {})
    }
  };
}

function inferMediaMimeFromUrl(url: string) {
  const pathname = safeUrlPathname(url).toLowerCase();

  if (pathname.endsWith(".mp4")) {
    return "video/mp4";
  }

  if (pathname.endsWith(".webm")) {
    return "video/webm";
  }

  if (pathname.endsWith(".mov") || pathname.endsWith(".qt")) {
    return "video/quicktime";
  }

  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (pathname.endsWith(".webp")) {
    return "image/webp";
  }

  if (pathname.endsWith(".gif")) {
    return "image/gif";
  }

  return "image/png";
}

function getMediaLabel(mime: string) {
  return mime.startsWith("video/") ? "视频" : "图片";
}

function safeUrlPathname(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export default function App() {
  const [composerParts, setComposerParts] = useState<RuntimePart[]>([{ type: "text", value: "" }]);
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [resourcesById, setResourcesById] = useState<ResourceMap>({});
  const [messagePageInfo, setMessagePageInfo] = useState<AgentMessagePageInfo>(() => createDefaultMessagePageInfo());
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentStreamEvent[]>([]);
  const [health, setHealth] = useState("检查中");
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(() => readSessionIdFromUrl());
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [sessionPageInfo, setSessionPageInfo] = useState<AgentSessionPageInfo>(() => createDefaultSessionPageInfo());
  const [isLoadingMoreSessions, setIsLoadingMoreSessions] = useState(false);
  const [deletingSessionIds, setDeletingSessionIds] = useState<Set<string>>(() => new Set());
  const [isSessionSidebarCollapsed, setIsSessionSidebarCollapsed] = useState(false);
  const [isTracePanelCollapsed, setIsTracePanelCollapsed] = useState(false);
  const activeStreamControllerRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | undefined>(activeSessionId);
  const runningRunsBySessionRef = useRef<RunningRunsBySession>(readRunningRunsBySession());
  // 这些 ref 是为了给异步 SSE 回调读“最新状态”。
  // React state 在闭包里可能是旧值，ref.current 可以避免旧流把事件写进新的会话。

  useEffect(() => {
    const controller = new AbortController();

    fetch(`${apiBaseUrl}/health`, {
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
      .then(({ sessions, pageInfo }) => {
        if (!cancelled) {
          setSessions(sessions);
          setSessionPageInfo(normalizeSessionPageInfo(pageInfo));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSessions([]);
          setSessionPageInfo(createDefaultSessionPageInfo());
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

    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    writeSessionIdToUrl(sessionId);

    let cancelled = false;

    getAgentSession(sessionId)
      .then(({ session, messages, resources, processSteps, pageInfo }) => {
        if (!cancelled) {
          upsertSession(session);
          setMessages(buildMessagesFromRecords(messages, processSteps));
          setResourcesById(resourcesToMap(resources));
          setMessagePageInfo(normalizeMessagePageInfo(pageInfo));
        }
      })
      .catch((sessionError) => {
        if (!cancelled) {
          clearSessionIdFromUrl(sessionId);
          activeSessionIdRef.current = undefined;
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
      // 刷新页面后，如果 localStorage 里还有 activeRunId，先拉 run 快照和会话快照，
      // 再从最后 seq 继续订阅 SSE。这样刷新不会重新发起模型调用。
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
        rememberRunningRun(snapshot.run.sessionId, runId);
        const sessionSnapshot = await getAgentSession(snapshot.run.sessionId);

        if (cancelled) {
          return;
        }

        setMessages(buildMessagesFromRecords(sessionSnapshot.messages, sessionSnapshot.processSteps));
        setResourcesById(resourcesToMap(sessionSnapshot.resources));
        setMessagePageInfo(normalizeMessagePageInfo(sessionSnapshot.pageInfo));
        setEvents([]);

        for (const storedEvent of snapshot.events) {
          if (cancelled) {
            return;
          }

          applyStoredRunEvent(storedEvent, runId, snapshot.run.sessionId);
        }

        const lastEventSeq = snapshot.events[snapshot.events.length - 1]?.seq ?? 0;

        if (snapshot.run.status !== "running") {
          forgetRunningRunByRunId(runId);
          clearActiveRun();
          return;
        }

        await streamAgentRunEvents(
          runId,
          lastEventSeq,
          (storedEvent) => {
            if (!cancelled) {
              applyStoredRunEvent(storedEvent, runId, snapshot.run.sessionId);
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

  function rememberRunningRun(sessionId: string, runId: string, lastSeq = 0) {
    runningRunsBySessionRef.current = {
      ...runningRunsBySessionRef.current,
      [sessionId]: { runId, lastSeq }
    };
    writeRunningRunsBySession(runningRunsBySessionRef.current);
  }

  function updateRunningRunSeq(sessionId: string | undefined, runId: string, seq: number) {
    if (!sessionId || seq <= 0) {
      return;
    }

    const currentRun = runningRunsBySessionRef.current[sessionId];

    // lastSeq 只前进不后退，避免旧事件把断点游标覆盖成更小的值。
    if (!currentRun || currentRun.runId !== runId || currentRun.lastSeq >= seq) {
      return;
    }

    rememberRunningRun(sessionId, runId, seq);
  }

  function forgetRunningRunByRunId(runId: string | undefined) {
    if (!runId) {
      return;
    }

    let didRemoveRun = false;
    const nextRunningRuns: RunningRunsBySession = {};

    for (const [sessionId, runningRun] of Object.entries(runningRunsBySessionRef.current)) {
      if (runningRun.runId === runId) {
        didRemoveRun = true;
        continue;
      }

      nextRunningRuns[sessionId] = runningRun;
    }

    if (!didRemoveRun) {
      return;
    }

    runningRunsBySessionRef.current = nextRunningRuns;
    writeRunningRunsBySession(nextRunningRuns);
  }

  function forgetRunningRunForSession(sessionId: string) {
    if (!runningRunsBySessionRef.current[sessionId]) {
      return;
    }

    const nextRunningRuns = Object.fromEntries(
      Object.entries(runningRunsBySessionRef.current).filter(([candidateSessionId]) => candidateSessionId !== sessionId)
    );
    runningRunsBySessionRef.current = nextRunningRuns;
    writeRunningRunsBySession(nextRunningRuns);
  }

  function releaseActiveRun(runId?: string) {
    if (runId && activeRunIdRef.current !== runId) {
      return;
    }

    // run 结束时要同时清三处：内存 ref、React state、localStorage。
    // 少清任意一处，刷新或切会话时都可能误以为还有流在跑。
    forgetRunningRunByRunId(runId ?? activeRunIdRef.current ?? undefined);
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
    setSessionPageInfo(normalizeSessionPageInfo(response.pageInfo));
  }

  function rememberSession(sessionId: string) {
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    writeSessionIdToUrl(sessionId);
  }

  function updateAssistantMessage(
    messageId: string,
    update: (message: ChatMessage) => ChatMessage,
    options: { createFromEvent?: AgentStreamEvent } = {}
  ) {
    setMessages((currentMessages) => {
      let didUpdate = false;
      const nextMessages = currentMessages.map((message) => {
        if (message.id !== messageId) {
          return message;
        }

        didUpdate = true;
        return update(message);
      });

      if (didUpdate || !options.createFromEvent) {
        return nextMessages;
      }

      return [...currentMessages, update(createStreamingAssistantMessage(messageId, options.createFromEvent))];
    });
  }

  function applyAgentEvent(event: AgentStreamEvent, messageId?: string, runId?: string) {
    // 这是前端的“事件归约器”：后端发来的每个 SSE 事件都会进入这里，
    // 然后更新 messages/resources/events/error 等 UI 状态。
    if (event.type === "message.snapshot") {
      setMessages((currentMessages) => upsertMessageSnapshot(currentMessages, event));
      setResourcesById((currentResources) => mergeResources(currentResources, event.resources));
      return;
    }

    setEvents((currentEvents) => [...currentEvents, event]);

    if (event.type === "session.message.created" || event.type === "session.message.updated") {
      setMessages((currentMessages) => upsertMessageRecord(currentMessages, event.message));
    }

    if (event.type === "resource.created" || event.type === "resource.updated") {
      setResourcesById((currentResources) => ({
        ...currentResources,
        [event.resource.id]: event.resource
      }));
    }

    const targetMessageId =
      event.type === "process.step.created" || event.type === "process.step.updated"
        ? messageId ?? event.step.messageId
        : messageId;

    if (targetMessageId) {
      updateAssistantMessage(targetMessageId, (message) => {
        if (isDuplicateOrOlderPartVersion(message, event)) {
          return message;
        }

        const nextEvents = [...(message.events ?? []), event];

        if (event.type === "process.step.created" || event.type === "process.step.updated") {
          return {
            ...message,
            processSteps: upsertProcessStep(message.processSteps, event.step),
            events: nextEvents
          };
        }

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
      }, shouldCreateAssistantMessageForEvent(event) ? { createFromEvent: event } : undefined);
    }

    if (event.type === "error") {
      // error/cancelled/run_completed 都是 run 生命周期的终点。
      // 收到终点事件后必须释放 active run，否则发送按钮会一直处于生成中。
      setError(`${event.code}: ${event.message}`);
      forgetRunningRunByRunId(runId ?? activeRunIdRef.current ?? undefined);
      clearActiveRun();
    }

    if (event.type === "cancelled") {
      forgetRunningRunByRunId(runId ?? activeRunIdRef.current ?? undefined);
      clearActiveRun();
    }

    if (event.type === "run_completed") {
      releaseActiveRun(runId);
    }
  }

  function applyStoredEvent(storedEvent: StoredAgentEvent) {
    if (storedEvent.seq > 0) {
      // seq 同时写 localStorage 和 runningRunsBySession：
      // activeEventSeqKey 服务当前页面刷新，runningRunsBySession 服务切会话后恢复。
      localStorage.setItem(activeEventSeqKey, String(storedEvent.seq));
    }
    applyAgentEvent(storedEvent.event, storedEvent.messageId, storedEvent.runId);
  }

  function applyStoredRunEvent(storedEvent: StoredAgentEvent, expectedRunId: string, expectedSessionId?: string) {
    // SSE 是长连接。用户可能在旧连接还没彻底关闭时切到了别的会话/开启了新 run。
    // 这里用 activeRunId、sessionId、event.runId 三重校验，防止旧流污染当前界面。
    if (activeRunIdRef.current !== expectedRunId) {
      return;
    }

    if (expectedSessionId && activeSessionIdRef.current !== expectedSessionId) {
      return;
    }

    if (storedEvent.runId && storedEvent.runId !== expectedRunId) {
      return;
    }

    updateRunningRunSeq(expectedSessionId, expectedRunId, storedEvent.seq);
    applyStoredEvent(storedEvent);
  }

  async function startRunWithCurrentSession(submittedParts: MessagePart[]) {
    const sessionId = activeSessionId ?? readSessionIdFromUrl();

    try {
      return await startAgentRun(submittedParts, sessionId);
    } catch (error) {
      if (sessionId) {
        clearSessionIdFromUrl(sessionId);
        setActiveSessionId(undefined);
        return startAgentRun(submittedParts);
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

    // 先中断本地 SSE 读取，再请求后端取消 run。
    // 这样 UI 不会继续消费取消前后交错到达的旧流事件。
    controller?.abort();

    try {
      const { run } = await cancelAgentRun(runId);
      setMessages((currentMessages) => markRunMessagesCancelled(currentMessages, run));
      setError(null);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "中断失败");
    } finally {
      forgetRunningRunByRunId(runId);
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
        setMessages(buildMessagesFromRecords(sessionSnapshot.messages, sessionSnapshot.processSteps));
        setResourcesById(resourcesToMap(sessionSnapshot.resources));
        setMessagePageInfo(normalizeMessagePageInfo(sessionSnapshot.pageInfo));
      }

      await refreshSessions();
    }
  }

  function detachActiveRun() {
    activeStreamControllerRef.current?.abort();
    activeStreamControllerRef.current = null;
    clearActiveRun();
    setIsStreaming(false);
  }

  async function resumeSessionRunIfNeeded(sessionId: string) {
    const runningRun = runningRunsBySessionRef.current[sessionId];

    if (!runningRun) {
      return;
    }

    const runId = runningRun.runId;
    const controller = new AbortController();

    // 切回一个仍在生成的会话时，只恢复这个会话自己的 run。
    // 先校验 run 快照属于该 session，再从 lastSeq 继续订阅。
    setIsStreaming(true);
    setActiveRun(runId);
    activeStreamControllerRef.current = controller;
    localStorage.setItem(activeRunIdKey, runId);
    localStorage.setItem(activeEventSeqKey, String(runningRun.lastSeq));
    setError(null);

    try {
      const snapshot = await getAgentRun(runId);

      if (activeSessionIdRef.current !== sessionId || activeRunIdRef.current !== runId || activeStreamControllerRef.current !== controller) {
        return;
      }

      if (snapshot.run.sessionId !== sessionId) {
        forgetRunningRunForSession(sessionId);
        clearActiveRun();
        return;
      }

      const lastEventSeq = snapshot.events[snapshot.events.length - 1]?.seq ?? runningRun.lastSeq;
      rememberRunningRun(sessionId, runId, lastEventSeq);
      localStorage.setItem(activeEventSeqKey, String(lastEventSeq));

      if (snapshot.run.status !== "running") {
        forgetRunningRunByRunId(runId);
        clearActiveRun();
        return;
      }

      await streamAgentRunEvents(runId, lastEventSeq, (storedEvent) => applyStoredRunEvent(storedEvent, runId, sessionId), controller.signal);
    } catch (streamError) {
      if (activeStreamControllerRef.current === controller && !isAbortError(streamError)) {
        setError(streamError instanceof Error ? streamError.message : "流式请求失败");
      }
    } finally {
      if (activeStreamControllerRef.current === controller) {
        activeStreamControllerRef.current = null;
        setIsStreaming(false);
      }
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
      // 当前只允许前端界面绑定一个 active run。
      // 用户提交新消息时先取消旧 run，避免两个 SSE 流同时写同一组 messages。
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
      rememberRunningRun(session.id, run.id);
      activeStreamControllerRef.current = controller;
      streamControllerAttached = true;
      localStorage.setItem(activeRunIdKey, run.id);
      localStorage.setItem(activeEventSeqKey, "0");
      setMessages((currentMessages) => appendStartedMessages(currentMessages, userMessage));
      setComposerParts([{ type: "text", value: "" }]);
      await streamAgentRunEvents(run.id, 0, (storedEvent) => applyStoredRunEvent(storedEvent, run.id, session.id), controller.signal);
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

  async function handleRegenerateMessage(messageId: string) {
    if (activeRunId) {
      // 重新生成本质上也是启动一个新的 run，所以同样先释放旧 run。
      await cancelActiveRun({ refreshAfterCancel: false, settleStreaming: false });
    }

    setIsStreaming(true);
    setError(null);
    setEvents([]);
    clearActiveRun();
    const controller = new AbortController();
    let streamControllerAttached = false;

    try {
      const { run, session } = await regenerateAgentMessage(messageId);
      rememberSession(session.id);
      upsertSession(session);
      setActiveRun(run.id);
      rememberRunningRun(session.id, run.id);
      activeStreamControllerRef.current = controller;
      streamControllerAttached = true;
      localStorage.setItem(activeRunIdKey, run.id);
      localStorage.setItem(activeEventSeqKey, "0");
      await streamAgentRunEvents(run.id, 0, (storedEvent) => applyStoredRunEvent(storedEvent, run.id, session.id), controller.signal);
      await refreshSessions();
    } catch (streamError) {
      if (!isAbortError(streamError) && (!streamControllerAttached || activeStreamControllerRef.current === controller)) {
        setError(streamError instanceof Error ? streamError.message : "重新生成失败");
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

  function resetToNewSession() {
    clearActiveRun();
    clearSessionIdFromUrl();
    activeSessionIdRef.current = undefined;
    setActiveSessionId(undefined);
    setComposerParts([{ type: "text", value: "" }]);
    setMessages([]);
    setResourcesById({});
    setMessagePageInfo(createDefaultMessagePageInfo());
    setIsLoadingOlderMessages(false);
    setEvents([]);
    setError(null);
  }

  async function handleNewSession() {
    if (activeRunId) {
      detachActiveRun();
    }

    resetToNewSession();
  }

  function handleSuggestionSelect(suggestion: string) {
    setComposerParts([{ type: "text", value: suggestion }]);
    setComposerFocusToken((currentToken) => currentToken + 1);
  }

  function handleReuseUserMessage(parts: MessagePart[]) {
    setComposerParts(parts.map((part) => ({ ...part })));
    setComposerFocusToken((currentToken) => currentToken + 1);
  }

  function handleImageAction(payload: ToolImageActionPayload) {
    if (payload.action !== "quote") {
      return;
    }

    setComposerParts((currentParts) => appendQuotedMediaPart(currentParts, createQuotedMediaPart(payload)));
    setComposerFocusToken((currentToken) => currentToken + 1);
  }

  async function handleSelectSession(sessionId: string) {
    if (sessionId === activeSessionId) {
      return;
    }

    if (activeRunId) {
      // 切会话时不一定取消后端 run，只是把当前前端流解绑。
      // 如果那个会话还在跑，会记录在 runningRunsBySession，切回来时再恢复。
      detachActiveRun();
    }

    clearActiveRun();
    setError(null);
    setEvents([]);
    setMessages([]);
    setResourcesById({});
    setMessagePageInfo(createDefaultMessagePageInfo());
    setIsLoadingOlderMessages(false);

    try {
      const { session, messages, resources, processSteps, pageInfo } = await getAgentSession(sessionId);
      upsertSession(session);
      rememberSession(session.id);
      setMessages(buildMessagesFromRecords(messages, processSteps));
      setResourcesById(resourcesToMap(resources));
      setMessagePageInfo(normalizeMessagePageInfo(pageInfo));
      await resumeSessionRunIfNeeded(session.id);
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : "会话恢复失败");
    }
  }

  async function handleLoadMoreSessions() {
    const after = sessionPageInfo.nextCursor;

    if (!after || !sessionPageInfo.hasMore || isLoadingMoreSessions) {
      return;
    }

    setIsLoadingMoreSessions(true);
    setError(null);

    try {
      const response = await listAgentSessions({
        after,
        limit: sessionPageInfo.limit || defaultSessionPageLimit
      });
      const incomingIds = new Set(response.sessions.map((session) => session.id));

      setSessions((currentSessions) => [...currentSessions.filter((session) => !incomingIds.has(session.id)), ...response.sessions]);
      setSessionPageInfo(normalizeSessionPageInfo(response.pageInfo));
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : "加载更多会话失败");
    } finally {
      setIsLoadingMoreSessions(false);
    }
  }

  async function handleDeleteSession(sessionId: string) {
    setDeletingSessionIds((currentIds) => new Set(currentIds).add(sessionId));
    setError(null);
    forgetRunningRunForSession(sessionId);

    if (sessionId === activeSessionId && activeRunId) {
      activeStreamControllerRef.current?.abort();
      clearActiveRun();
      setIsStreaming(false);
    }

    try {
      await deleteAgentSession(sessionId);
      setSessions((currentSessions) => currentSessions.filter((session) => session.id !== sessionId));

      if (sessionId === activeSessionId) {
        resetToNewSession();
      }
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : "删除会话失败");
    } finally {
      setDeletingSessionIds((currentIds) => {
        const nextIds = new Set(currentIds);
        nextIds.delete(sessionId);
        return nextIds;
      });
    }
  }

  async function handleLoadOlderMessages() {
    const sessionId = activeSessionId ?? readSessionIdFromUrl();
    const before = messagePageInfo.nextCursor;

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

      setMessages((currentMessages) => prependMessagesFromRecords(currentMessages, response.messages, response.processSteps));
      setResourcesById((currentResources) => mergeResources(currentResources, response.resources));
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
          hasMoreSessions={sessionPageInfo.hasMore}
          isLoadingMoreSessions={isLoadingMoreSessions}
          deletingSessionIds={deletingSessionIds}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onLoadMoreSessions={handleLoadMoreSessions}
          onDeleteSession={handleDeleteSession}
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
            resourcesById={resourcesById}
            isActive={isStreaming}
            error={error}
            hasMoreMessages={messagePageInfo.hasMore}
            isLoadingOlderMessages={isLoadingOlderMessages}
            onLoadOlderMessages={handleLoadOlderMessages}
            onImageAction={handleImageAction}
            onReuseUserMessage={handleReuseUserMessage}
            onRegenerateMessage={handleRegenerateMessage}
            onSuggestionSelect={handleSuggestionSelect}
          />

          <AgentComposer
            parts={composerParts}
            isStreaming={isStreaming}
            focusToken={composerFocusToken}
            onPartsChange={setComposerParts}
            onSubmit={handleSubmitMessage}
            onCancel={handleCancelMessage}
            onUploadImage={uploadAgentImage}
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
