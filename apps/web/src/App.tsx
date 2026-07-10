import { Alert, Box, Button, Chip, Drawer, IconButton, Snackbar, Tab, Tabs, Typography, useMediaQuery } from "@mui/material";
import { Menu, PanelLeftClose, PanelLeftOpen, PanelRightOpen, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import {
  authSessionChangedEvent,
  cancelAgentRun,
  clearAuthSession,
  deleteAgentSession,
  getGithubAuthorizeUrl,
  getAgentRun,
  getAgentSession,
  getAgentSessionMessages,
  listAgentSessions,
  listKnowledgeDocuments,
  regenerateAgentMessage,
  deleteKnowledgeDocument,
  reindexKnowledgeDocument,
  loginWithGithubCode,
  readAuthSession,
  startAgentRun,
  streamAgentRunEvents,
  uploadAgentDocument,
  uploadAgentImage,
  uploadKnowledgeDocument,
  type AgentMessagePageInfo,
  type AgentMessageRecord,
  type AgentProcessStepRecord,
  type AgentResourceRecord,
  type AgentRunRecord,
  type AgentSessionPageInfo,
  type MessagePart,
  type AgentSessionRecord,
  type AgentStreamEvent,
  type KnowledgeDocumentRecord,
  type StoredAgentEvent
} from "./api/agent-client";
import { AgentConversation, type ChatMessage } from "./components/AgentConversation";
import { AgentTimeline } from "./components/AgentTimeline";
import { AgentComposer } from "./components/AgentComposer";
import { KnowledgeAdminPanel } from "./components/KnowledgeAdminPanel";
import { SessionSidebar, type SessionHistoryItem } from "./components/SessionSidebar";
import type { ToolResourceActionPayload } from "./components/ToolResultPreview";
import { stripRuntimeFields, type RuntimePart } from "./prosemirror/part-serialization";
import "./styles.css";

const activeRunIdKey = "agent.activeRunId";
const runningRunsBySessionKey = "agent.runningRunsBySession";
const sessionIdQueryKey = "sessionId";
const defaultMessagePageLimit = 30;
const defaultSessionPageLimit = 30;
const githubOAuthClientId = import.meta.env.VITE_GITHUB_OAUTH_CLIENT_ID?.trim() ?? "";
const configuredGithubRedirectUri = import.meta.env.VITE_GITHUB_OAUTH_REDIRECT_URI?.trim();

type ResourceMap = Record<string, AgentResourceRecord>;
type RunningRunState = { runId: string };
type RunningRunsBySession = Record<string, RunningRunState>;
type InspectorTab = "events" | "knowledge";

function readRunningRunsBySession(): RunningRunsBySession {
  // 这里记录“每个会话当前还在跑的 run”。
  // 用户切换会话或刷新页面后，前端可以用 runId 重新接上 SSE，而不是丢掉正在生成的回答。
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
          runId: candidate.runId
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

function getGithubRedirectUri() {
  return configuredGithubRedirectUri || `${window.location.origin}/auth/github/callback`;
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
    const nextCreatedAt = nextMessage.createdAt;
    if (nextCreatedAt) {
      const insertIndex = currentMessages.findIndex((message) =>
        message.createdAt ? message.createdAt.localeCompare(nextCreatedAt) > 0 : false
      );
      if (insertIndex !== -1) {
        return [...currentMessages.slice(0, insertIndex), nextMessage, ...currentMessages.slice(insertIndex)];
      }
    }
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
  // 后端不会每次都重发整条消息：流式文本用 delta，resource/占位用 created/updated。
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

function appendQuotedResourcePart(currentParts: RuntimePart[], quotedResourcePart: RuntimePart): RuntimePart[] {
  const meaningfulParts = currentParts.filter((part) => part.type === "resource" || (part.type === "text" && part.value.trim()));

  if (meaningfulParts.length === 0) {
    return [quotedResourcePart];
  }

  return [...currentParts, quotedResourcePart];
}

function createQuotedResourcePart(payload: ToolResourceActionPayload): RuntimePart {
  const prompt = payload.prompt.trim();
  const mime = payload.mime ?? inferResourceMimeFromUrl(payload.url);
  const resourceLabel = getResourceLabel(mime);
  const name = prompt || `${resourceLabel} ${payload.index + 1}`;
  const tool =
    payload.trace.toolName === "resource"
      ? undefined
      : {
          name: payload.trace.toolName,
          toolCallId: payload.trace.id,
          ...(payload.toolCallRowId ? { toolCallRowId: payload.toolCallRowId } : {}),
          outputIndex: payload.outputIndex ?? payload.index
        };

  return {
    type: "resource",
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

function inferResourceMimeFromUrl(url: string) {
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

function getResourceLabel(mime: string) {
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
  const isCompactWorkspace = useMediaQuery("(max-width: 1023px)", { noSsr: true });
  const [composerParts, setComposerParts] = useState<RuntimePart[]>([{ type: "text", value: "" }]);
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [resourcesById, setResourcesById] = useState<ResourceMap>({});
  const [messagePageInfo, setMessagePageInfo] = useState<AgentMessagePageInfo>(() => createDefaultMessagePageInfo());
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachmentToastMessage, setAttachmentToastMessage] = useState<string | null>(null);
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<KnowledgeDocumentRecord[]>([]);
  const [isKnowledgeLoading, setIsKnowledgeLoading] = useState(false);
  const [isKnowledgeUploading, setIsKnowledgeUploading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentStreamEvent[]>([]);
  const [authSession, setAuthSession] = useState(() => readAuthSession());
  const [authError, setAuthError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(() => readSessionIdFromUrl());
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [sessionPageInfo, setSessionPageInfo] = useState<AgentSessionPageInfo>(() => createDefaultSessionPageInfo());
  const [isLoadingMoreSessions, setIsLoadingMoreSessions] = useState(false);
  const [deletingSessionIds, setDeletingSessionIds] = useState<Set<string>>(() => new Set());
  const [isSessionSidebarCollapsed, setIsSessionSidebarCollapsed] = useState(isCompactWorkspace);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("events");
  const activeStreamControllerRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | undefined>(activeSessionId);
  const runningRunsBySessionRef = useRef<RunningRunsBySession>(readRunningRunsBySession());
  // 这些 ref 是为了给异步 SSE 回调读“最新状态”。
  // React state 在闭包里可能是旧值，ref.current 可以避免旧流把事件写进新的会话。

  useEffect(() => {
    if (isCompactWorkspace) {
      setIsSessionSidebarCollapsed(true);
    }
  }, [isCompactWorkspace]);

  const closeAttachmentToast = useCallback(() => {
    setAttachmentToastMessage(null);
  }, []);

  const handleAttachmentToastClose = useCallback((_event: SyntheticEvent | Event, reason?: string) => {
    if (reason === "clickaway") {
      return;
    }

    closeAttachmentToast();
  }, [closeAttachmentToast]);

  const handleAttachmentUploadNotice = useCallback((message: string | null) => {
    setAttachmentToastMessage(message);
  }, []);

  const loadKnowledgeDocuments = useCallback(async () => {
    if (!authSession) {
      setKnowledgeDocuments([]);
      setKnowledgeError(null);
      return;
    }

    setIsKnowledgeLoading(true);
    setKnowledgeError(null);

    try {
      setKnowledgeDocuments(await listKnowledgeDocuments());
    } catch (loadError) {
      setKnowledgeError(loadError instanceof Error ? loadError.message : "知识库加载失败");
    } finally {
      setIsKnowledgeLoading(false);
    }
  }, [authSession]);

  const handleUploadKnowledgeDocument = useCallback(
    async (file: File) => {
      if (!authSession) {
        setKnowledgeError("请先登录 GitHub");
        return;
      }

      setIsKnowledgeUploading(true);
      setKnowledgeError(null);

      try {
        await uploadKnowledgeDocument(file);
        await loadKnowledgeDocuments();
      } catch (uploadError) {
        setKnowledgeError(uploadError instanceof Error ? uploadError.message : "知识库上传失败");
      } finally {
        setIsKnowledgeUploading(false);
      }
    },
    [authSession, loadKnowledgeDocuments]
  );

  const handleDeleteKnowledgeDocument = useCallback(
    async (documentId: string) => {
      if (!authSession) {
        setKnowledgeError("请先登录 GitHub");
        return;
      }

      setKnowledgeError(null);

      try {
        await deleteKnowledgeDocument(documentId);
        await loadKnowledgeDocuments();
      } catch (deleteError) {
        setKnowledgeError(deleteError instanceof Error ? deleteError.message : "知识库删除失败");
      }
    },
    [authSession, loadKnowledgeDocuments]
  );

  const handleReindexKnowledgeDocument = useCallback(
    async (documentId: string) => {
      if (!authSession) {
        setKnowledgeError("请先登录 GitHub");
        return;
      }

      setKnowledgeError(null);

      try {
        await reindexKnowledgeDocument(documentId);
        await loadKnowledgeDocuments();
      } catch (reindexError) {
        setKnowledgeError(reindexError instanceof Error ? reindexError.message : "知识库重新索引失败");
      }
    },
    [authSession, loadKnowledgeDocuments]
  );

  useEffect(() => {
    const syncAuthSession = () => {
      setAuthSession(readAuthSession());
    };

    window.addEventListener(authSessionChangedEvent, syncAuthSession);
    window.addEventListener("storage", syncAuthSession);
    return () => {
      window.removeEventListener(authSessionChangedEvent, syncAuthSession);
      window.removeEventListener("storage", syncAuthSession);
    };
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);

    if (url.pathname !== "/auth/github/callback") {
      return;
    }

    const code = url.searchParams.get("code");

    if (!code) {
      setAuthError("GitHub 登录回调缺少 code");
      return;
    }

    let cancelled = false;
    setAuthError(null);

    loginWithGithubCode({
      code,
      redirectUri: getGithubRedirectUri()
    })
      .then((session) => {
        if (cancelled) {
          return;
        }

        setAuthSession(session);
        window.history.replaceState(null, "", "/");
      })
      .catch((loginError) => {
        if (!cancelled) {
          setAuthError(loginError instanceof Error ? loginError.message : "GitHub 登录失败");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authSession) {
      setKnowledgeDocuments([]);
      return;
    }

    void loadKnowledgeDocuments();
  }, [authSession, loadKnowledgeDocuments]);

  useEffect(() => {
    if (!authSession) {
      setSessions([]);
      setSessionPageInfo(createDefaultSessionPageInfo());
      return;
    }

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
  }, [authSession]);

  useEffect(() => {
    if (!authSession) {
      return;
    }

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
  }, [authSession]);

  useEffect(() => {
    if (!authSession) {
      return;
    }

    const storedActiveRunId = localStorage.getItem(activeRunIdKey);

    if (!storedActiveRunId) {
      return;
    }

    const runId = storedActiveRunId;
    let cancelled = false;
    const controller = new AbortController();

    async function recoverActiveRun() {
      // 刷新页面后，如果 localStorage 里还有 activeRunId，先拉 run 快照和会话快照，
      // 再订阅 SSE live stream。这样刷新不会重新发起模型调用。
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

        if (snapshot.run.status !== "running") {
          forgetRunningRunByRunId(runId);
          clearActiveRun();
          return;
        }

        await streamAgentRunEvents(
          runId,
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
  }, [authSession]);

  function clearActiveRun() {
    activeRunIdRef.current = null;
    localStorage.removeItem(activeRunIdKey);
    setActiveRunId(null);
  }

  function setActiveRun(runId: string) {
    activeRunIdRef.current = runId;
    setActiveRunId(runId);
  }

  function rememberRunningRun(sessionId: string, runId: string) {
    runningRunsBySessionRef.current = {
      ...runningRunsBySessionRef.current,
      [sessionId]: { runId }
    };
    writeRunningRunsBySession(runningRunsBySessionRef.current);
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
    // 先校验 run 快照属于该 session，再订阅实时流。
    setIsStreaming(true);
    setActiveRun(runId);
    activeStreamControllerRef.current = controller;
    localStorage.setItem(activeRunIdKey, runId);
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

      rememberRunningRun(sessionId, runId);

      if (snapshot.run.status !== "running") {
        forgetRunningRunByRunId(runId);
        clearActiveRun();
        return;
      }

      await streamAgentRunEvents(runId, (storedEvent) => applyStoredRunEvent(storedEvent, runId, sessionId), controller.signal);
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
    if (!authSession) {
      setError("请先登录 GitHub");
      return;
    }

    const submittedParts = stripRuntimeFields(composerParts).filter(
      (part) => part.type === "resource" || (part.type === "text" && part.value.trim())
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
      setMessages((currentMessages) => appendStartedMessages(currentMessages, userMessage));
      setComposerParts([{ type: "text", value: "" }]);
      await streamAgentRunEvents(run.id, (storedEvent) => applyStoredRunEvent(storedEvent, run.id, session.id), controller.signal);
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
    if (!authSession) {
      setError("请先登录 GitHub");
      return;
    }

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
      await streamAgentRunEvents(run.id, (storedEvent) => applyStoredRunEvent(storedEvent, run.id, session.id), controller.signal);
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
    if (isCompactWorkspace) {
      setIsSessionSidebarCollapsed(true);
    }
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

  function handleResourceAction(payload: ToolResourceActionPayload) {
    if (payload.action !== "quote") {
      return;
    }

    setComposerParts((currentParts) => appendQuotedResourcePart(currentParts, createQuotedResourcePart(payload)));
    setComposerFocusToken((currentToken) => currentToken + 1);
  }

  async function handleSelectSession(sessionId: string) {
    if (isCompactWorkspace) {
      setIsSessionSidebarCollapsed(true);
    }

    if (!authSession) {
      setError("请先登录 GitHub");
      return;
    }

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
    if (!authSession) {
      return;
    }

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
    if (!authSession) {
      setError("请先登录 GitHub");
      return;
    }

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
    if (!authSession) {
      setError("请先登录 GitHub");
      return;
    }

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
  const activeSessionTitle = activeSessionId
    ? sessions.find((session) => session.id === activeSessionId)?.title?.trim() || "未命名会话"
    : "新对话";
  // 未登录是正常的访客状态，登录入口已经固定在会话栏底部；只有用户
  // 真正触发受保护操作后才把“请先登录”作为上下文错误显示在对话区。
  const displayError = authError ?? error;
  const workspaceClassName = [
    "workspace",
    isSessionSidebarCollapsed ? "sidebar-collapsed" : null,
    isCompactWorkspace ? "compact-workspace" : "desktop-workspace",
    isCompactWorkspace && !isSessionSidebarCollapsed ? "sidebar-overlay-open" : null,
    isInspectorOpen ? "inspector-open" : "inspector-closed"
  ]
    .filter(Boolean)
    .join(" ");

  function handleGithubLogin() {
    if (!githubOAuthClientId) {
      setAuthError("缺少 VITE_GITHUB_OAUTH_CLIENT_ID 配置");
      return;
    }

    window.location.href = getGithubAuthorizeUrl({
      clientId: githubOAuthClientId,
      redirectUri: getGithubRedirectUri(),
      state: crypto.randomUUID()
    });
  }

  function handleLogout() {
    clearAuthSession();
    setAuthSession(undefined);
    resetToNewSession();
    setSessions([]);
    setKnowledgeDocuments([]);
  }

  function renderSessionSidebar(collapsed: boolean) {
    return (
      <SessionSidebar
        activeSessionId={activeSessionId}
        historyItems={historyItems}
        isCollapsed={collapsed}
        hasMoreSessions={sessionPageInfo.hasMore}
        isLoadingMoreSessions={isLoadingMoreSessions}
        deletingSessionIds={deletingSessionIds}
        githubLogin={authSession?.user.githubLogin}
        isGithubLoginConfigured={Boolean(githubOAuthClientId)}
        onNewSession={handleNewSession}
        onCollapse={() => setIsSessionSidebarCollapsed(true)}
        onSelectSession={handleSelectSession}
        onLoadMoreSessions={handleLoadMoreSessions}
        onDeleteSession={handleDeleteSession}
        onGithubLogin={handleGithubLogin}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <Box component="main" className="app-shell fullscreen-shell">
      <Box className={workspaceClassName}>
        {isCompactWorkspace ? (
          <Drawer
            anchor="left"
            className="compact-sidebar-drawer"
            classes={{ paper: "compact-sidebar-drawer-paper" }}
            ModalProps={{ keepMounted: true }}
            open={!isSessionSidebarCollapsed}
            onClose={() => setIsSessionSidebarCollapsed(true)}
          >
            {renderSessionSidebar(false)}
          </Drawer>
        ) : (
          renderSessionSidebar(isSessionSidebarCollapsed)
        )}

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
                {isCompactWorkspace ? (
                  <Menu size={20} />
                ) : isSessionSidebarCollapsed ? (
                  <PanelLeftOpen size={18} />
                ) : (
                  <PanelLeftClose size={18} />
                )}
              </IconButton>
            </Box>

            <Box className="chat-main-title">
              <Typography component="h1" variant="h6">
                {activeSessionTitle}
              </Typography>
            </Box>

            <Box className="chat-header-side right">
              {isStreaming ? (
                <Chip className="generation-badge streaming" size="small" label="生成中" color="primary" variant="outlined" />
              ) : null}
              <Button
                aria-controls={isInspectorOpen ? "run-inspector" : undefined}
                aria-expanded={isInspectorOpen}
                className="inspector-trigger"
                onClick={() => setIsInspectorOpen(true)}
                size="small"
                startIcon={<PanelRightOpen size={17} />}
                type="button"
                variant="text"
              >
                运行详情
              </Button>
            </Box>
          </Box>

          <AgentConversation
            messages={messages}
            resourcesById={resourcesById}
            isActive={isStreaming}
            error={displayError}
            hasMoreMessages={messagePageInfo.hasMore}
            isLoadingOlderMessages={isLoadingOlderMessages}
            onLoadOlderMessages={handleLoadOlderMessages}
            onResourceAction={handleResourceAction}
            onReuseUserMessage={handleReuseUserMessage}
            onRegenerateMessage={handleRegenerateMessage}
            onSuggestionSelect={handleSuggestionSelect}
          />

          <Box className="composer-dock">
            <AgentComposer
              parts={composerParts}
              isStreaming={isStreaming}
              focusToken={composerFocusToken}
              onPartsChange={setComposerParts}
              onSubmit={handleSubmitMessage}
              onCancel={handleCancelMessage}
              onUploadDocument={uploadAgentDocument}
              onUploadError={handleAttachmentUploadNotice}
              onUploadImage={uploadAgentImage}
            />
            <Typography className="composer-disclaimer" component="p">
              AI 生成内容可能有误，请核实重要信息和工具结果。
            </Typography>
          </Box>
        </Box>

      </Box>
      <Drawer
        anchor="right"
        className="inspector-drawer"
        classes={{ paper: "inspector-drawer-paper" }}
        id="run-inspector"
        ModalProps={{ keepMounted: true }}
        open={isInspectorOpen}
        onClose={() => setIsInspectorOpen(false)}
        slotProps={{ paper: { "aria-labelledby": "run-inspector-title" } }}
      >
        <Box component="aside" className="inspector-shell" aria-label="运行详情">
          <Box component="header" className="inspector-header">
            <Box>
              <Typography component="h2" id="run-inspector-title" variant="h6">
                运行详情
              </Typography>
              <Typography component="p" className="inspector-session-title">
                {activeSessionTitle}
              </Typography>
            </Box>
            <IconButton
              aria-label="关闭运行详情"
              className="inspector-close"
              onClick={() => setIsInspectorOpen(false)}
              size="small"
              type="button"
            >
              <X size={18} />
            </IconButton>
          </Box>

          <Tabs
            aria-label="运行详情分类"
            className="inspector-tabs"
            onChange={(_event, nextTab: InspectorTab) => setInspectorTab(nextTab)}
            value={inspectorTab}
            variant="fullWidth"
          >
            <Tab aria-controls="inspector-panel-events" id="inspector-tab-events" label="事件" value="events" />
            <Tab aria-controls="inspector-panel-knowledge" id="inspector-tab-knowledge" label="知识库" value="knowledge" />
          </Tabs>

          <Box className="inspector-content">
            <Box
              aria-labelledby="inspector-tab-events"
              className="inspector-panel run-events-panel trace-panel"
              hidden={inspectorTab !== "events"}
              id="inspector-panel-events"
              role="tabpanel"
            >
              <Box className="inspector-panel-heading">
                <Box>
                  <Typography component="h3" variant="subtitle1">
                    运行事件
                  </Typography>
                  <Typography component="p">查看模型、工具与结果的实时事件。</Typography>
                </Box>
                <Chip className="count-pill" size="small" label={events.length} />
              </Box>
              <AgentTimeline events={events} />
            </Box>

            <Box
              aria-labelledby="inspector-tab-knowledge"
              className="inspector-panel knowledge-panel"
              hidden={inspectorTab !== "knowledge"}
              id="inspector-panel-knowledge"
              role="tabpanel"
            >
              <KnowledgeAdminPanel
                documents={knowledgeDocuments}
                isLoading={isKnowledgeLoading}
                isUploading={isKnowledgeUploading}
                error={knowledgeError}
                onRefresh={loadKnowledgeDocuments}
                onUpload={handleUploadKnowledgeDocument}
                onDelete={handleDeleteKnowledgeDocument}
                onReindex={handleReindexKnowledgeDocument}
              />
            </Box>

          </Box>
        </Box>
      </Drawer>
      <Snackbar
        className="attachment-toast"
        open={Boolean(attachmentToastMessage)}
        autoHideDuration={3600}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        onClose={handleAttachmentToastClose}
      >
        <Alert className="attachment-toast-alert" severity="warning" variant="filled" onClose={closeAttachmentToast}>
          {attachmentToastMessage}
        </Alert>
      </Snackbar>
    </Box>
  );
}
