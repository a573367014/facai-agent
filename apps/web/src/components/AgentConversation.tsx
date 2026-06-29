import { Alert, Box, Chip, CircularProgress, IconButton, Paper, Tooltip, Typography, type TooltipProps } from "@mui/material";
import { CircleAlert, CircleStop, Copy, Pencil, RefreshCw } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
  type WheelEvent
} from "react";
import type { AgentResourceRecord, AgentState, AgentStreamEvent, MessagePart } from "../api/agent-client";
import type { ToolImageActionPayload } from "./ToolResultPreview";
import { ToolTraceList } from "./ToolTraceList";
import { MessagePartRenderer } from "./MessagePartRenderer";

export type ChatMessageStatus = "running" | "completed" | "failed" | "cancelled";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: MessagePart[];
  status?: ChatMessageStatus;
  version?: number;
  events?: AgentStreamEvent[];
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
}

interface AgentConversationProps {
  messages: ChatMessage[];
  resourcesById?: Record<string, AgentResourceRecord>;
  isActive: boolean;
  error?: string | null;
  hasMoreMessages?: boolean;
  isLoadingOlderMessages?: boolean;
  onImageAction?: (payload: ToolImageActionPayload) => void;
  onLoadOlderMessages?: () => void;
  onEditUserMessage?: (text: string) => void;
  onRegenerateMessage?: (messageId: string) => void;
  onSuggestionSelect?: (suggestion: string) => void;
}

interface ScrollSnapshot {
  firstId?: string;
  lastId?: string;
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

const stateText: Record<AgentState, string> = {
  thinking: "思考中",
  calling_tool: "调用工具",
  observing: "整理工具结果",
  answering: "生成回答",
  done: "完成",
  failed: "失败"
};

const emptySuggestions = [
  "现在上海时间是多少？",
  "数据库设计中需要注意哪些问题？",
  "帮我生成一张温馨田园小猪图片",
  "JavaScript 的哪些新特性可以提升前端开发效率？",
  "解释一下这个 Agent 项目的工具调用流程"
];

const LOAD_OLDER_SCROLL_THRESHOLD = 120;
const USER_SCROLL_INTENT_TTL_MS = 800;
const AUTO_SCROLL_BOTTOM_THRESHOLD = 24;
const messageActionTooltipSlotProps: TooltipProps["slotProps"] = {
  popper: {
    modifiers: [
      {
        name: "offset",
        options: {
          offset: [0, -8]
        }
      }
    ]
  }
};

function getLatestState(events: AgentStreamEvent[] = []) {
  return [...events].reverse().find((event) => event.type === "agent_state");
}

function AssistantStatus({ message, isActive }: { message: ChatMessage; isActive: boolean }) {
  const latestState = getLatestState(message.events);

  if (message.status === "failed") {
    return (
      <Chip className="chat-status failed" size="small" icon={<CircleAlert size={14} />} label="失败" color="error" />
    );
  }

  if (message.status === "cancelled") {
    return (
      <Chip className="chat-status cancelled" size="small" icon={<CircleStop size={14} />} label="已中断" variant="outlined" />
    );
  }

  if (message.status === "running" || (isActive && !hasTextContent(message.parts))) {
    return (
      <Chip
        className="chat-status running"
        size="small"
        icon={<CircularProgress color="inherit" size={14} />}
        label={latestState ? stateText[latestState.state] : "运行中"}
        color="primary"
        variant="outlined"
      />
    );
  }

  return null;
}

function hasTextContent(parts: MessagePart[]) {
  return parts.some((part) => part.type === "text" && part.value.trim().length > 0);
}

function getTextContent(parts: MessagePart[]) {
  return parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.value.trim())
    .filter(Boolean)
    .join("\n");
}

function copyText(value: string) {
  const writePromise = navigator.clipboard?.writeText(value);

  if (writePromise) {
    void writePromise.catch(() => undefined);
  }
}

function padTimePart(value: number) {
  return String(value).padStart(2, "0");
}

function formatMessageTimestamp(value?: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  const now = new Date();
  const time = `${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
  const isSameYear = date.getFullYear() === now.getFullYear();
  const isSameMonth = isSameYear && date.getMonth() === now.getMonth();
  const isSameDay = isSameMonth && date.getDate() === now.getDate();

  if (isSameDay) {
    return time;
  }

  if (isSameMonth) {
    return `${date.getDate()}日 ${time}`;
  }

  if (isSameYear) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }

  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

function SystemStatusMessage({ message }: { message: ChatMessage }) {
  const text = getTextContent(message.parts) || message.error || "系统状态已更新";
  const isRunning = message.status === "running";

  return (
    <Box component="article" className={`chat-system-row ${message.status ?? "completed"}`} key={message.id}>
      <span className="chat-system-rule" aria-hidden="true" />
      <span className="chat-system-pill" role="status">
        {isRunning ? <CircularProgress color="inherit" size={13} /> : null}
        <span>{text}</span>
      </span>
      <span className="chat-system-rule" aria-hidden="true" />
    </Box>
  );
}

export function AgentConversation({
  messages,
  resourcesById = {},
  isActive,
  error,
  hasMoreMessages = false,
  isLoadingOlderMessages = false,
  onImageAction,
  onLoadOlderMessages,
  onEditUserMessage,
  onRegenerateMessage,
  onSuggestionSelect
}: AgentConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousScrollSnapshotRef = useRef<ScrollSnapshot>();
  const pendingPrependScrollSnapshotRef = useRef<ScrollSnapshot>();
  const loadOlderRequestLockedRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<number>();
  const isEmpty = messages.length === 0;

  function clearUserScrollIntentTimer() {
    if (userScrollIntentTimerRef.current) {
      window.clearTimeout(userScrollIntentTimerRef.current);
      userScrollIntentTimerRef.current = undefined;
    }
  }

  function markUserScrollIntent() {
    userScrollIntentRef.current = true;
    clearUserScrollIntentTimer();
    userScrollIntentTimerRef.current = window.setTimeout(() => {
      userScrollIntentRef.current = false;
      userScrollIntentTimerRef.current = undefined;
    }, USER_SCROLL_INTENT_TTL_MS);
  }

  function createScrollSnapshot(): ScrollSnapshot | undefined {
    const scrollElement = scrollRef.current;

    if (!scrollElement) {
      return undefined;
    }

    return {
      firstId: messages[0]?.id,
      lastId: messages.at(-1)?.id,
      scrollHeight: scrollElement.scrollHeight,
      scrollTop: scrollElement.scrollTop,
      clientHeight: scrollElement.clientHeight
    };
  }

  function isAtBottom(snapshot: ScrollSnapshot) {
    return snapshot.scrollHeight - snapshot.scrollTop - snapshot.clientHeight <= AUTO_SCROLL_BOTTOM_THRESHOLD;
  }

  function requestLoadOlderMessages() {
    if (
      !userScrollIntentRef.current ||
      !hasMoreMessages ||
      isLoadingOlderMessages ||
      loadOlderRequestLockedRef.current ||
      !onLoadOlderMessages
    ) {
      return;
    }

    pendingPrependScrollSnapshotRef.current = createScrollSnapshot();
    loadOlderRequestLockedRef.current = true;
    userScrollIntentRef.current = false;
    clearUserScrollIntentTimer();
    onLoadOlderMessages();
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (event.deltaY < 0) {
      markUserScrollIntent();
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      markUserScrollIntent();
    }
  }

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    previousScrollSnapshotRef.current = createScrollSnapshot();

    if (event.currentTarget.scrollTop <= LOAD_OLDER_SCROLL_THRESHOLD) {
      requestLoadOlderMessages();
    }
  }

  useEffect(() => {
    if (!isLoadingOlderMessages) {
      loadOlderRequestLockedRef.current = false;
    }
  }, [isLoadingOlderMessages]);

  useEffect(() => {
    return () => {
      clearUserScrollIntentTimer();
    };
  }, []);

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;

    if (!scrollElement) {
      return;
    }

    const firstId = messages[0]?.id;
    const lastId = messages.at(-1)?.id;
    const previousSnapshot = pendingPrependScrollSnapshotRef.current ?? previousScrollSnapshotRef.current;
    const isPrepending = previousSnapshot && previousSnapshot.lastId === lastId && previousSnapshot.firstId !== firstId;

    if (isPrepending) {
      scrollElement.scrollTop = previousSnapshot.scrollTop + scrollElement.scrollHeight - previousSnapshot.scrollHeight;
      pendingPrependScrollSnapshotRef.current = undefined;
      previousScrollSnapshotRef.current = {
        firstId,
        lastId,
        scrollHeight: scrollElement.scrollHeight,
        scrollTop: scrollElement.scrollTop,
        clientHeight: scrollElement.clientHeight
      };

      return;
    }

    pendingPrependScrollSnapshotRef.current = undefined;

    const isReplacingMessageList = previousSnapshot
      ? previousSnapshot.firstId !== firstId && previousSnapshot.lastId !== lastId
      : false;
    const shouldAutoScroll = !previousSnapshot || isReplacingMessageList || isAtBottom(previousSnapshot);

    if (!shouldAutoScroll) {
      previousScrollSnapshotRef.current = {
        firstId,
        lastId,
        scrollHeight: scrollElement.scrollHeight,
        scrollTop: scrollElement.scrollTop,
        clientHeight: scrollElement.clientHeight
      };

      return;
    }

    scrollElement.scrollTop = scrollElement.scrollHeight;
    previousScrollSnapshotRef.current = {
      firstId,
      lastId,
      scrollHeight: scrollElement.scrollHeight,
      scrollTop: scrollElement.scrollTop,
      clientHeight: scrollElement.clientHeight
    };
  }, [messages]);

  return (
    <Paper component="section" className="panel chat-panel" elevation={0}>
      <div
        className={isEmpty ? "chat-scroll chat-scroll-empty" : "chat-scroll"}
        ref={scrollRef}
        onPointerDown={handlePointerDown}
        onScroll={handleScroll}
        onTouchMove={markUserScrollIntent}
        onWheel={handleWheel}
      >
        <div className={isEmpty ? "chat-scroll-content chat-scroll-content-empty" : "chat-scroll-content"}>
          {error ? (
            <Alert className="error-box chat-global-error" severity="error">
              {error}
            </Alert>
          ) : null}
          {messages.length === 0 ? (
            <Box className="empty-state chat-empty">
              <Typography component="h2">有什么我能帮你的吗？</Typography>
              <p>输入一个任务，Agent 会按需调用工具并把过程展示在右侧。</p>
              <Box className="empty-suggestions">
                {emptySuggestions.map((suggestion) => (
                  <Chip
                    className="empty-suggestion-chip"
                    key={suggestion}
                    label={suggestion}
                    clickable={Boolean(onSuggestionSelect)}
                    onClick={onSuggestionSelect ? () => onSuggestionSelect(suggestion) : undefined}
                  />
                ))}
              </Box>
            </Box>
          ) : (
            <>
              {hasMoreMessages ? (
                <Box className="load-older-row" role="status" aria-live="polite">
                  <span className="load-older-hint">
                    {isLoadingOlderMessages ? (
                      <>
                        <CircularProgress color="inherit" size={13} />
                        <span>加载更早消息中...</span>
                      </>
                    ) : (
                      "上滑加载更早消息"
                    )}
                  </span>
                </Box>
              ) : null}
              {messages.map((message) => {
                if (message.role === "system" && (message.status === "cancelled" || message.status === "failed")) {
                  return null;
                }

                if (message.role === "system") {
                  return <SystemStatusMessage message={message} key={message.id} />;
                }

                const showCursor = message.role === "assistant" && message.status === "running";
                const messageBodyClassName = message.role === "assistant" ? "chat-answer assistant" : "chat-bubble user";
                const userMessageText = message.role === "user" ? getTextContent(message.parts) : "";
                const canCopyUserMessage = message.role === "user" && userMessageText.length > 0;
                const canEditUserMessage = canCopyUserMessage && typeof onEditUserMessage === "function";
                const canRegenerate =
                  message.role === "assistant" && message.status !== "running" && typeof onRegenerateMessage === "function";
                const messageTimestamp = formatMessageTimestamp(message.createdAt);
                const hasMessageMeta = Boolean(messageTimestamp || canCopyUserMessage || canRegenerate);

                return (
                  <Box component="article" className={`chat-row ${message.role}`} key={message.id}>
                    <div className={`chat-content ${message.role}`}>
                      <div className={messageBodyClassName}>
                        {message.role === "assistant" ? <AssistantStatus message={message} isActive={isActive} /> : null}

                        {message.error ? (
                          <Alert className="error-box inline-error" severity="error">
                            {message.error}
                          </Alert>
                        ) : null}

                        {message.parts.length ? (
                          <MessagePartRenderer
                            role={message.role}
                            parts={message.parts}
                            resourcesById={resourcesById}
                            showCursor={showCursor}
                            onImageAction={onImageAction}
                          />
                        ) : message.role === "assistant" && message.status === "running" ? (
                          <p className="chat-text muted-live">
                            正在思考
                            <span className="typing-cursor" aria-hidden="true" />
                          </p>
                        ) : null}

                        {message.role === "assistant" ? <ToolTraceList events={message.events} onImageAction={onImageAction} /> : null}

                        {hasMessageMeta ? (
                          <Box className={`message-meta-row ${message.role}`}>
                            {canRegenerate ? (
                              <Box className="message-actions assistant-actions">
                                <Tooltip title="重新生成" placement="top" slotProps={messageActionTooltipSlotProps}>
                                  <IconButton
                                    aria-label="重新生成"
                                    className="message-action-button"
                                    onClick={() => onRegenerateMessage(message.id)}
                                    size="small"
                                    type="button"
                                  >
                                    <RefreshCw size={15} />
                                  </IconButton>
                                </Tooltip>
                              </Box>
                            ) : null}

                            {messageTimestamp ? (
                              <time className="message-timestamp" dateTime={message.createdAt}>
                                {messageTimestamp}
                              </time>
                            ) : null}

                            {canCopyUserMessage ? (
                              <Box className="message-actions user-actions">
                                <Tooltip title="复制" placement="top" slotProps={messageActionTooltipSlotProps}>
                                  <IconButton
                                    aria-label="复制消息"
                                    className="message-action-button"
                                    onClick={() => copyText(userMessageText)}
                                    size="small"
                                    type="button"
                                  >
                                    <Copy size={15} />
                                  </IconButton>
                                </Tooltip>

                                {canEditUserMessage ? (
                                  <Tooltip title="修改" placement="top" slotProps={messageActionTooltipSlotProps}>
                                    <IconButton
                                      aria-label="修改消息"
                                      className="message-action-button"
                                      onClick={() => onEditUserMessage(userMessageText)}
                                      size="small"
                                      type="button"
                                    >
                                      <Pencil size={15} />
                                    </IconButton>
                                  </Tooltip>
                                ) : null}
                              </Box>
                            ) : null}
                          </Box>
                        ) : null}
                      </div>
                    </div>
                  </Box>
                );
              })}
            </>
          )}
        </div>
      </div>
    </Paper>
  );
}
