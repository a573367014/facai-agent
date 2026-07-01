import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Chip, CircularProgress, IconButton, Paper, Tooltip, Typography, type TooltipProps } from "@mui/material";
import { CheckCircle2, ChevronDown, CircleAlert, CircleStop, Clock3, Copy, Loader2, Pencil, RefreshCw, XCircle } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
  type WheelEvent
} from "react";
import type { AgentProcessStepRecord, AgentResourceRecord, AgentState, AgentStreamEvent, MessagePart } from "../api/agent-client";
import type { ToolImageActionPayload } from "./ToolResultPreview";
import { MessagePartRenderer } from "./MessagePartRenderer";
import type { UserPartSurfaceHandle } from "./UserPartSurface";

export type ChatMessageStatus = "running" | "completed" | "failed" | "cancelled";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: MessagePart[];
  status?: ChatMessageStatus;
  version?: number;
  processSteps?: AgentProcessStepRecord[];
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
  onReuseUserMessage?: (parts: MessagePart[]) => void;
  onRegenerateMessage?: (messageId: string) => void;
  onSuggestionSelect?: (suggestion: string) => void;
}

interface ScrollSnapshot {
  // 记录一次渲染前的滚动状态。加载更早消息时列表高度会变，
  // 用这些值可以把用户视野固定在原来的消息附近，而不是突然跳到顶部/底部。
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
  // Agent 状态事件是流式追加的，倒着找能拿到最新状态，用来显示“思考中/调用工具”等小标签。
  return [...events].reverse().find((event) => event.type === "agent_state");
}

function ProcessStepIcon({ status }: { status: AgentProcessStepRecord["status"] }) {
  switch (status) {
    case "succeeded":
      return <CheckCircle2 size={14} />;
    case "failed":
      return <XCircle size={14} />;
    case "cancelled":
      return <CircleStop size={14} />;
    case "running":
      return <Loader2 className="spin" size={14} />;
  }
}

function getProcessSummaryLabel(steps: AgentProcessStepRecord[]) {
  if (steps.some((step) => step.status === "running")) {
    return "进行中";
  }

  if (steps.some((step) => step.status === "failed")) {
    return "有失败步骤";
  }

  if (steps.some((step) => step.status === "cancelled")) {
    return "已中断";
  }

  return `已完成 ${steps.length} 步`;
}

function AgentThinkingProcess({ message }: { message: ChatMessage }) {
  const steps = [...(message.processSteps ?? [])].sort(
    (leftStep, rightStep) => leftStep.orderIndex - rightStep.orderIndex || leftStep.startedAt.localeCompare(rightStep.startedAt)
  );

  if (steps.length === 0) {
    return null;
  }

  const isRunning = message.status === "running";

  return (
    <Accordion className="thinking-process" defaultExpanded={isRunning} disableGutters elevation={0}>
      <AccordionSummary className="thinking-process-summary" expandIcon={<ChevronDown size={16} />}>
        <Box className="thinking-process-heading">
          <Clock3 size={15} />
          <span>任务进度</span>
        </Box>
        <Chip className="thinking-process-chip" size="small" label={getProcessSummaryLabel(steps)} />
      </AccordionSummary>
      <AccordionDetails className="thinking-process-details">
        <ol className="thinking-step-list">
          {steps.map((step) => (
            <li className={`thinking-step thinking-step-${step.status}`} key={step.id}>
              <span className="thinking-step-icon" aria-hidden="true">
                <ProcessStepIcon status={step.status} />
              </span>
              <span className="thinking-step-content">
                <span className="thinking-step-title">{step.title}</span>
                {step.summary ? <span className="thinking-step-summary">{step.summary}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </AccordionDetails>
    </Accordion>
  );
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

function hasReusableUserParts(parts: MessagePart[]) {
  return parts.some((part) => part.type === "media" || (part.type === "text" && part.value.trim().length > 0));
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
  onReuseUserMessage,
  onRegenerateMessage,
  onSuggestionSelect
}: AgentConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousScrollSnapshotRef = useRef<ScrollSnapshot>();
  const pendingPrependScrollSnapshotRef = useRef<ScrollSnapshot>();
  const loadOlderRequestLockedRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<number>();
  const userPartSurfaceRefs = useRef(new Map<string, UserPartSurfaceHandle>());
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
    // 只有明确的用户上滑才触发加载历史。
    // 否则消息流式更新造成 scrollTop 接近顶部时，也可能误触发分页请求。
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

  function setUserPartSurfaceRef(messageId: string) {
    return (handle: UserPartSurfaceHandle | null) => {
      if (handle) {
        userPartSurfaceRefs.current.set(messageId, handle);
        return;
      }

      userPartSurfaceRefs.current.delete(messageId);
    };
  }

  function getReusableUserMessageParts(message: ChatMessage) {
    return userPartSurfaceRefs.current.get(message.id)?.getSelectedParts() ?? message.parts;
  }

  function reuseUserMessageParts(message: ChatMessage) {
    const parts = getReusableUserMessageParts(message);
    onReuseUserMessage?.(parts);
    return parts;
  }

  function handleCopyUserMessage(message: ChatMessage) {
    const parts = reuseUserMessageParts(message);
    const text = getTextContent(parts);

    if (text) {
      copyText(text);
    }
  }

  function handleEditUserMessage(message: ChatMessage) {
    if (onReuseUserMessage) {
      reuseUserMessageParts(message);
      return;
    }

    onEditUserMessage?.(getTextContent(message.parts));
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
      // prepend 历史消息会让 scrollHeight 变大。
      // 新 scrollTop = 旧 scrollTop + 新旧高度差，用户眼前那条消息就不会位移。
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
      // 用户正在看历史时，不因为新 token 到达就强行拉到底部。
      // 只更新快照，保留用户当前阅读位置。
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
                const canCopyUserMessage = message.role === "user" && hasReusableUserParts(message.parts);
                const canEditUserMessage =
                  canCopyUserMessage && (typeof onReuseUserMessage === "function" || typeof onEditUserMessage === "function");
                const canRegenerate =
                  message.role === "assistant" && message.status !== "running" && typeof onRegenerateMessage === "function";
                const messageTimestamp = formatMessageTimestamp(message.createdAt);
                const hasMessageMeta = Boolean(messageTimestamp || canCopyUserMessage || canRegenerate);
                const hasProcessSteps = message.role === "assistant" && Boolean(message.processSteps?.length);

                return (
                  <Box component="article" className={`chat-row ${message.role}`} key={message.id}>
                    <div className={`chat-content ${message.role}`}>
                      <div className={messageBodyClassName}>
                        {message.role === "assistant" && !hasProcessSteps ? <AssistantStatus message={message} isActive={isActive} /> : null}

                        {message.error ? (
                          <Alert className="error-box inline-error" severity="error">
                            {message.error}
                          </Alert>
                        ) : null}

                        {message.role === "assistant" ? <AgentThinkingProcess message={message} /> : null}

                        {message.parts.length ? (
                          <MessagePartRenderer
                            role={message.role}
                            parts={message.parts}
                            resourcesById={resourcesById}
                            showCursor={showCursor}
                            onImageAction={onImageAction}
                            userPartSurfaceRef={message.role === "user" ? setUserPartSurfaceRef(message.id) : undefined}
                          />
                        ) : message.role === "assistant" && message.status === "running" ? (
                          <p className="chat-text muted-live">
                            正在思考
                            <span className="typing-cursor" aria-hidden="true" />
                          </p>
                        ) : null}

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
                                    onClick={() => handleCopyUserMessage(message)}
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
                                      onClick={() => handleEditUserMessage(message)}
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
