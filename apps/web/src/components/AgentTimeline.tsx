import { Accordion, AccordionDetails, AccordionSummary, Box, Chip, Typography } from "@mui/material";
import { ChevronDown } from "lucide-react";
import type { AgentStreamEvent } from "../api/agent-client";

interface AgentTimelineProps {
  events: AgentStreamEvent[];
}

function getEventTitle(event: AgentStreamEvent): string {
  switch (event.type) {
    case "iteration_start":
      return `第 ${event.iteration + 1} 轮开始`;
    case "iteration_end":
      return event.outcome === "final_answer" ? `第 ${event.iteration + 1} 轮结束：最终回答` : `第 ${event.iteration + 1} 轮结束：工具结果写回`;
    case "agent_state":
      return event.label;
    case "llm_start":
      return "请求模型";
    case "answer_delta":
      return "答案片段";
    case "answer_chunk":
      return "答案合并片段";
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
    case "cancelled":
      return "运行已中断";
    case "error":
      return `错误：${event.code}`;
  }
}

function getEventSummary(event: AgentStreamEvent): string {
  switch (event.type) {
    case "answer_delta":
      return event.delta;
    case "answer_chunk":
      return event.text;
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
    case "cancelled":
      return event.reason ?? "";
    case "error":
      return event.message;
    default:
      return "";
  }
}

function getEventIteration(event: AgentStreamEvent): number | null {
  return "iteration" in event ? event.iteration : null;
}

export function AgentTimeline({ events }: AgentTimelineProps) {
  if (events.length === 0) {
    return <p className="muted">流式运行后会在这里展示实时 trace。</p>;
  }

  return (
    <ol className="timeline">
      {events.map((event, index) => (
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
