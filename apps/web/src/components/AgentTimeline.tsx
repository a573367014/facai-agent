import { Accordion, AccordionDetails, AccordionSummary, Box, Chip, Typography } from "@mui/material";
import { ChevronDown } from "lucide-react";
import type { AgentStreamEvent } from "../api/agent-client";

interface AgentTimelineProps {
  events: AgentStreamEvent[];
}

type TimelineEvent = AgentStreamEvent;
type VisibleTimelineEvent = Exclude<AgentStreamEvent, { type: "message.snapshot" }>;

function isVisibleTimelineEvent(event: TimelineEvent): event is VisibleTimelineEvent {
  return event.type !== "message.snapshot";
}

function getEventTitle(event: VisibleTimelineEvent): string {
  switch (event.type) {
    case "iteration_start":
      return `第 ${event.iteration + 1} 轮开始`;
    case "iteration_end":
      return event.outcome === "final_answer" ? `第 ${event.iteration + 1} 轮结束：最终回答` : `第 ${event.iteration + 1} 轮结束：工具结果写回`;
    case "agent_state":
      return event.label;
    case "llm_start":
      return "请求模型";
    case "session.message.created":
      return "会话消息已创建";
    case "session.message.updated":
      return "会话消息已更新";
    case "message.part.created":
      return "消息片段已创建";
    case "message.part.delta":
      return "消息片段增量";
    case "message.part.updated":
      return "消息片段已更新";
    case "resource.created":
      return "资源已创建";
    case "resource.updated":
      return "资源已更新";
    case "process.step.created":
      return "过程步骤已创建";
    case "process.step.updated":
      return "过程步骤已更新";
    case "summary_start":
      return "开始压缩上下文";
    case "summary_completed":
      return "上下文压缩完成";
    case "summary_failed":
      return "上下文压缩失败";
    case "answer_delta":
      return "答案片段";
    case "llm_response":
      return "模型响应";
    case "tool_call_ready":
      return `准备工具：${event.toolName}`;
    case "tool_start":
      return `调用工具：${event.toolName}`;
    case "tool_progress":
      return `工具进度：${event.toolName}`;
    case "tool_result":
      return `工具结果：${event.toolName}`;
    case "tool_error":
      return `工具错误：${event.toolName}`;
    case "final_answer":
      return "最终答案";
    case "run_completed":
      return "运行收尾完成";
    case "cancelled":
      return "运行已中断";
    case "error":
      return `错误：${event.code}`;
    default:
      return "事件";
  }
}

function getEventSummary(event: VisibleTimelineEvent): string {
  switch (event.type) {
    case "answer_delta":
      return event.delta;
    case "message.part.created":
    case "message.part.updated":
      return `${event.part.type} #${event.partIndex + 1}`;
    case "message.part.delta":
      return event.delta;
    case "session.message.created":
    case "session.message.updated":
      return `${event.message.role} · ${event.message.status}`;
    case "resource.created":
    case "resource.updated":
      return `${event.resource.type} · ${event.resource.status}`;
    case "process.step.created":
    case "process.step.updated":
      return `${event.step.title} · ${event.step.status}`;
    case "summary_start":
      return `待整理 ${event.uncoveredMessageCount} 条，压缩 ${event.summarizedMessageCount} 条`;
    case "summary_completed":
      return `覆盖到 ${event.coveredMessageId} · 耗时 ${event.durationMs}ms`;
    case "summary_failed":
      return `${event.error.code}: ${event.error.message}`;
    case "llm_response":
      return event.toolCalls?.length ? `返回 ${event.toolCalls.length} 个工具调用` : "返回自然语言内容";
    case "tool_call_ready":
    case "tool_start":
      return JSON.stringify(event.arguments);
    case "tool_progress":
      return JSON.stringify(event.progress);
    case "tool_result":
      return [event.durationMs !== undefined ? `耗时 ${event.durationMs}ms` : null, JSON.stringify(event.result)].filter(Boolean).join(" · ");
    case "tool_error":
      return [
        event.durationMs !== undefined ? `耗时 ${event.durationMs}ms` : null,
        event.error.recoverable !== undefined ? (event.error.recoverable ? "可恢复" : "不可恢复") : null,
        `${event.error.code}: ${event.error.message}`
      ]
        .filter(Boolean)
        .join(" · ");
    case "final_answer":
      return event.answer;
    case "run_completed":
      return event.messageId;
    case "cancelled":
      return event.reason ?? "";
    case "error":
      return event.message;
    default:
      return "";
  }
}

function getEventIteration(event: VisibleTimelineEvent): number | null {
  return "iteration" in event ? event.iteration : null;
}

export function AgentTimeline({ events }: AgentTimelineProps) {
  const visibleEvents = events.filter(isVisibleTimelineEvent);

  if (visibleEvents.length === 0) {
    return <p className="muted">流式运行后会在这里展示实时 trace。</p>;
  }

  return (
    <ol className="timeline">
      {visibleEvents.map((event, index) => (
        <Box component="li" className={`timeline-item event-${event.type}`} key={`${event.type}-${index}`}>
          <Box className="timeline-marker" aria-hidden="true" />
          <Box className="timeline-body">
            <Box className="timeline-topline">
              <Box>
                <Typography className="timeline-title" component="div">
                  {getEventTitle(event)}
                </Typography>
                {getEventSummary(event) ? <p>{getEventSummary(event)}</p> : null}
              </Box>
              {getEventIteration(event) !== null ? <Chip className="iteration-pill" size="small" label={`#${getEventIteration(event)! + 1}`} /> : null}
            </Box>
            <Accordion className="timeline-raw-event">
              <AccordionSummary expandIcon={<ChevronDown size={15} />}>原始事件</AccordionSummary>
              <AccordionDetails>
                <pre>{JSON.stringify(event, null, 2)}</pre>
              </AccordionDetails>
            </Accordion>
          </Box>
        </Box>
      ))}
    </ol>
  );
}
