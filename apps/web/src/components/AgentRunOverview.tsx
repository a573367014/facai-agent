import { Activity, CheckCircle2, CircleAlert, Clock3, Radio, Wrench } from "lucide-react";
import type { AgentState, AgentStreamEvent } from "../api/agent-client";

interface AgentRunOverviewProps {
  events: AgentStreamEvent[];
  isActive: boolean;
}

const stateLabel: Record<AgentState, string> = {
  thinking: "思考",
  calling_tool: "工具",
  observing: "观察",
  answering: "回答",
  done: "完成",
  failed: "失败"
};

function getLatestState(events: AgentStreamEvent[]) {
  return [...events].reverse().find((event) => event.type === "agent_state");
}

function countEvents(events: AgentStreamEvent[], type: AgentStreamEvent["type"]) {
  return events.filter((event) => event.type === type).length;
}

export function AgentRunOverview({ events, isActive }: AgentRunOverviewProps) {
  const latestState = getLatestState(events);
  const iterationCount = countEvents(events, "iteration_start");
  const toolCount = countEvents(events, "tool_start");
  const tokenCount = countEvents(events, "answer_delta");
  const errorCount = countEvents(events, "error") + countEvents(events, "tool_error");
  const currentLabel = latestState?.label ?? (isActive ? "等待服务端事件" : "尚未运行");
  const currentState = latestState?.state;

  return (
    <section className="panel run-overview">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Runtime</span>
          <h2>{currentLabel}</h2>
        </div>
        <span className={`run-badge ${currentState ?? "idle"}`}>
          {currentState ? stateLabel[currentState] : isActive ? "运行中" : "空闲"}
        </span>
      </div>

      <div className="metric-strip">
        <div>
          <Clock3 size={16} />
          <span>迭代</span>
          <strong>{iterationCount}</strong>
        </div>
        <div>
          <Wrench size={16} />
          <span>工具</span>
          <strong>{toolCount}</strong>
        </div>
        <div>
          <Radio size={16} />
          <span>片段</span>
          <strong>{tokenCount}</strong>
        </div>
        <div>
          {errorCount > 0 ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
          <span>错误</span>
          <strong>{errorCount}</strong>
        </div>
      </div>

      <div className="activity-line">
        <Activity size={16} />
        <span>{events.length > 0 ? `已接收 ${events.length} 个事件` : "事件流会在这里汇总运行状态"}</span>
      </div>
    </section>
  );
}
