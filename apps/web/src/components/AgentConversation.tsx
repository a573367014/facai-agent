import { Bot, CircleAlert, Loader2, UserRound, Wrench } from "lucide-react";
import { useEffect, useRef } from "react";
import type { AgentState, AgentStep, AgentStreamEvent } from "../api/agent-client";
import { AgentSteps } from "./AgentSteps";

export type ChatMessageStatus = "running" | "completed" | "failed";

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
}

const stateText: Record<AgentState, string> = {
  thinking: "思考中",
  calling_tool: "调用工具",
  observing: "整理工具结果",
  answering: "生成回答",
  done: "完成",
  failed: "失败"
};

function getLatestState(events: AgentStreamEvent[] = []) {
  return [...events].reverse().find((event) => event.type === "agent_state");
}

function getToolEvents(events: AgentStreamEvent[] = []) {
  return events.filter(
    (event) => event.type === "tool_call_ready" || event.type === "tool_start" || event.type === "tool_result" || event.type === "tool_error"
  );
}

function getToolEventText(event: AgentStreamEvent): string {
  switch (event.type) {
    case "tool_call_ready":
      return `准备 ${event.toolName}`;
    case "tool_start":
      return `调用 ${event.toolName}`;
    case "tool_result":
      return `${event.toolName} 返回结果`;
    case "tool_error":
      return `${event.toolName} 执行失败`;
    default:
      return "";
  }
}

function getToolEventPayload(event: AgentStreamEvent): unknown {
  switch (event.type) {
    case "tool_call_ready":
    case "tool_start":
      return event.arguments;
    case "tool_result":
      return event.result;
    case "tool_error":
      return event.error;
    default:
      return null;
  }
}

function AssistantStatus({ message, isActive }: { message: ChatMessage; isActive: boolean }) {
  const latestState = getLatestState(message.events);

  if (message.status === "failed") {
    return (
      <span className="chat-status failed">
        <CircleAlert size={14} />
        失败
      </span>
    );
  }

  if (message.status === "running" || (isActive && !message.content)) {
    return (
      <span className="chat-status running">
        <Loader2 size={14} className="spin" />
        {latestState ? stateText[latestState.state] : "运行中"}
      </span>
    );
  }

  return null;
}

export function AgentConversation({ messages, isActive, error }: AgentConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

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
    <section className="panel chat-panel">
      <div className="panel-heading compact chat-heading">
        <div>
          <span className="eyebrow">Session</span>
          <h2>对话</h2>
        </div>
        {isActive ? <span className="run-badge streaming">生成中</span> : null}
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {error ? <div className="error-box chat-global-error">{error}</div> : null}
        {messages.length === 0 ? (
          <div className="empty-state chat-empty">
            <strong>还没有消息</strong>
            <p>发起任务后，会在这里形成用户和助手的连续对话。</p>
          </div>
        ) : (
          messages.map((message) => {
            const toolEvents = message.role === "assistant" ? getToolEvents(message.events) : [];
            const showCursor = message.role === "assistant" && message.status === "running";

            return (
              <article className={`chat-row ${message.role}`} key={message.id}>
                <div className="chat-avatar" aria-hidden="true">
                  {message.role === "user" ? <UserRound size={18} /> : <Bot size={18} />}
                </div>
                <div className="chat-content">
                  <div className={`chat-bubble ${message.role}`}>
                    <div className="chat-meta">
                      <strong>{message.role === "user" ? "你" : "Agent"}</strong>
                      {message.role === "assistant" ? <AssistantStatus message={message} isActive={isActive} /> : null}
                    </div>

                    {message.error ? <div className="error-box inline-error">{message.error}</div> : null}

                    {message.content ? (
                      <p className="chat-text">
                        {message.content}
                        {showCursor ? <span className="typing-cursor" aria-hidden="true" /> : null}
                      </p>
                    ) : message.role === "assistant" && message.status === "running" ? (
                      <p className="chat-text muted-live">
                        正在思考
                        <span className="typing-cursor" aria-hidden="true" />
                      </p>
                    ) : null}

                    {toolEvents.length > 0 ? (
                      <div className="tool-events">
                        <div className="tool-events-title">
                          <Wrench size={14} />
                          工具过程
                        </div>
                        {toolEvents.map((event, index) => (
                          <details className="tool-event" key={`${event.type}-${index}`}>
                            <summary>{getToolEventText(event)}</summary>
                            <pre>{JSON.stringify(getToolEventPayload(event), null, 2)}</pre>
                          </details>
                        ))}
                      </div>
                    ) : null}

                    {message.role === "assistant" && message.steps?.length ? (
                      <div className="tool-section compact-tools">
                        <div className="section-title">工具步骤</div>
                        <AgentSteps steps={message.steps} />
                      </div>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
