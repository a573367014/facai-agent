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
    case "llm_response":
      return "模型响应";
    case "tool_call_ready":
      return `准备工具：${event.toolName}`;
    case "tool_start":
      return `调用工具：${event.toolName}`;
    case "tool_result":
      return `工具结果：${event.toolName}`;
    case "tool_error":
      return `工具错误：${event.toolName}`;
    case "final_answer":
      return "最终答案";
    case "error":
      return `错误：${event.code}`;
  }
}

function getEventSummary(event: AgentStreamEvent): string {
  switch (event.type) {
    case "answer_delta":
      return event.delta;
    case "llm_response":
      return event.toolCalls?.length ? `返回 ${event.toolCalls.length} 个工具调用` : "返回自然语言内容";
    case "tool_call_ready":
    case "tool_start":
      return JSON.stringify(event.arguments);
    case "tool_result":
      return JSON.stringify(event.result);
    case "tool_error":
      return `${event.error.code}: ${event.error.message}`;
    case "final_answer":
      return event.answer;
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
        <li className={`timeline-item event-${event.type}`} key={`${event.type}-${index}`}>
          <div className="timeline-marker" aria-hidden="true" />
          <div className="timeline-body">
            <div className="timeline-topline">
              <div>
                <div className="timeline-title">{getEventTitle(event)}</div>
                {getEventSummary(event) ? <p>{getEventSummary(event)}</p> : null}
              </div>
              {getEventIteration(event) !== null ? <span className="iteration-pill">#{getEventIteration(event)! + 1}</span> : null}
            </div>
            <details>
              <summary>原始事件</summary>
              <pre>{JSON.stringify(event, null, 2)}</pre>
            </details>
          </div>
        </li>
      ))}
    </ol>
  );
}
