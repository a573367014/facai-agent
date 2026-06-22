import type { AgentRunResponse } from "../api/agent-client";
import { AgentSteps } from "./AgentSteps";

interface AgentResultPanelProps {
  result: AgentRunResponse | null;
  error: string | null;
  streamingAnswer: string;
  isStreaming: boolean;
}

export function AgentResultPanel({ result, error, streamingAnswer, isStreaming }: AgentResultPanelProps) {
  const answer = result?.answer ?? streamingAnswer;
  const hasAnswer = answer.length > 0;

  return (
    <section className="panel result-panel">
      <div className="panel-heading compact">
        <div>
          <span className="eyebrow">Output</span>
          <h2>回答结果</h2>
        </div>
        {isStreaming && !result ? <span className="run-badge streaming">生成中</span> : null}
      </div>
      {error ? <div className="error-box">{error}</div> : null}
      {hasAnswer ? (
        <>
          <article className="answer">
            {answer}
            {isStreaming && !result ? <span className="typing-cursor" aria-hidden="true" /> : null}
          </article>
          {result ? (
            <div className="tool-section">
              <div className="section-title">工具步骤</div>
              <AgentSteps steps={result.steps} />
            </div>
          ) : (
            <p className="muted">答案生成中...</p>
          )}
        </>
      ) : (
        <div className="empty-state">
          <strong>等待任务</strong>
          <p>运行后会在这里展示回答和工具调用步骤。</p>
        </div>
      )}
    </section>
  );
}
