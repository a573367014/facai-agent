import { Alert, Box, Chip, CircularProgress, Paper, Typography } from "@mui/material";
import { Bot, CircleAlert, CircleStop, UserRound } from "lucide-react";
import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentState, AgentStep, AgentStreamEvent } from "../api/agent-client";
import { buildToolTraces, type ToolTrace } from "../utils/tool-traces";
import {
  asImageResult,
  ImageLoadingPreview,
  ImagePreview,
  type ToolImageActionPayload
} from "./ToolResultPreview";
import { ToolTraceList } from "./ToolTraceList";

export type ChatMessageStatus = "running" | "completed" | "failed" | "cancelled";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  runId?: string;
  status?: ChatMessageStatus;
  steps?: AgentStep[];
  events?: AgentStreamEvent[];
  error?: string;
}

interface AgentConversationProps {
  messages: ChatMessage[];
  isActive: boolean;
  error?: string | null;
  onImageAction?: (payload: ToolImageActionPayload) => void;
  onSuggestionSelect?: (suggestion: string) => void;
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

  if (message.status === "running" || (isActive && !message.content)) {
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getImageResourceUrls(message: ChatMessage) {
  if (message.role !== "assistant") {
    return [];
  }

  return getImageTraces(message.events, message.steps).flatMap((trace) => asImageResult(trace.result)?.imageUrls ?? []);
}

function stripImageResourceReferences(content: string, imageUrls: string[]) {
  if (imageUrls.length === 0) {
    return content;
  }

  const imageUrlPatterns = imageUrls.map((url) => new RegExp(escapeRegExp(url)));

  return content
    .split("\n")
    .filter((line) => !imageUrlPatterns.some((pattern) => pattern.test(line)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function MessageContent({ message, showCursor }: { message: ChatMessage; showCursor: boolean }) {
  if (message.role === "assistant") {
    const content = stripImageResourceReferences(message.content, getImageResourceUrls(message));

    return (
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        {showCursor ? <span className="typing-cursor" aria-hidden="true" /> : null}
      </div>
    );
  }

  return (
    <p className="chat-text">
      {message.content}
      {showCursor ? <span className="typing-cursor" aria-hidden="true" /> : null}
    </p>
  );
}

function MessageImageAssets({
  events = [],
  steps = [],
  onImageAction
}: {
  events?: AgentStreamEvent[];
  steps?: AgentStep[];
  onImageAction?: (payload: ToolImageActionPayload) => void;
}) {
  const imageTraces = getImageTraces(events, steps);

  if (imageTraces.length === 0) {
    return null;
  }

  return (
    <div className="message-image-assets">
      {imageTraces.map((trace) => {
        const imageResult = asImageResult(trace.result);

        if (imageResult) {
          return <ImagePreview key={trace.id} trace={trace} result={imageResult} onImageAction={onImageAction} />;
        }

        if (trace.status === "pending" || trace.status === "running") {
          return <ImageLoadingPreview key={trace.id} trace={trace} />;
        }

        return null;
      })}
    </div>
  );
}

function buildImageTracesFromSteps(steps: AgentStep[] = []): ToolTrace[] {
  return steps.flatMap((step, index) => {
    if (step.toolName !== "generate_image") {
      return [];
    }

    return [
      {
        id: `step:${index}:${step.toolName}`,
        iteration: index,
        toolName: step.toolName,
        status: "success",
        arguments: step.arguments,
        result: step.result
      } satisfies ToolTrace
    ];
  });
}

function getImageTraces(events: AgentStreamEvent[] = [], steps: AgentStep[] = []) {
  const eventImageTraces = buildToolTraces(events).filter((trace) => trace.toolName === "generate_image" && !trace.error);

  if (eventImageTraces.length > 0) {
    return eventImageTraces;
  }

  return buildImageTracesFromSteps(steps);
}

function hasActiveImageTrace(events: AgentStreamEvent[] = []) {
  return buildToolTraces(events).some(
    (trace) => trace.toolName === "generate_image" && !trace.error && (trace.status === "pending" || trace.status === "running")
  );
}

function getAssistantLiveText(message: ChatMessage) {
  if (hasActiveImageTrace(message.events)) {
    return "我正在为你生成图片";
  }

  return "正在思考";
}

export function AgentConversation({ messages, isActive, error, onImageAction, onSuggestionSelect }: AgentConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isEmpty = messages.length === 0;

  useEffect(() => {
    if (!scrollRef.current) {
      return;
    }

    if (typeof scrollRef.current.scrollTo === "function") {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth"
      });
      return;
    }

    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  return (
    <Paper component="section" className="panel chat-panel" elevation={0}>
      <div className={isEmpty ? "chat-scroll chat-scroll-empty" : "chat-scroll"} ref={scrollRef}>
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
          messages.map((message) => {
            const showCursor = message.role === "assistant" && message.status === "running";

            return (
              <Box component="article" className={`chat-row ${message.role}`} key={message.id}>
                <Box className="chat-avatar" aria-hidden="true">
                  {message.role === "user" ? <UserRound size={18} /> : <Bot size={18} />}
                </Box>
                <div className={`chat-content ${message.role}`}>
                  <div className={`chat-bubble ${message.role}`}>
                    <div className="chat-meta">
                      <strong>{message.role === "user" ? "你" : "Agent"}</strong>
                      {message.role === "assistant" ? <AssistantStatus message={message} isActive={isActive} /> : null}
                    </div>

                    {message.error ? (
                      <Alert className="error-box inline-error" severity="error">
                        {message.error}
                      </Alert>
                    ) : null}

                    {message.content ? (
                      <MessageContent message={message} showCursor={showCursor} />
                    ) : message.role === "assistant" && message.status === "running" ? (
                      <p className="chat-text muted-live">
                        {getAssistantLiveText(message)}
                        <span className="typing-cursor" aria-hidden="true" />
                      </p>
                    ) : null}

                    {message.role === "assistant" ? (
                      <MessageImageAssets events={message.events} steps={message.steps} onImageAction={onImageAction} />
                    ) : null}

                    {message.role === "assistant" ? <ToolTraceList events={message.events} onImageAction={onImageAction} /> : null}
                  </div>
                </div>
              </Box>
            );
          })
        )}
      </div>
    </Paper>
  );
}
