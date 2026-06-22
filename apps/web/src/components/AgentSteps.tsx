import type { AgentStep } from "../api/agent-client";

interface AgentStepsProps {
  steps: AgentStep[];
}

export function AgentSteps({ steps }: AgentStepsProps) {
  if (steps.length === 0) {
    return <p className="muted">本次没有调用工具。</p>;
  }

  return (
    <ol className="steps">
      {steps.map((step, index) => (
        <li className="step-item" key={`${step.toolName}-${index}`}>
          <div className="step-header">
            <span>{index + 1}</span>
            <strong>{step.toolName}</strong>
          </div>
          <div className="step-grid">
            <div>
              <div className="code-label">参数</div>
              <pre>{JSON.stringify(step.arguments, null, 2)}</pre>
            </div>
            <div>
              <div className="code-label">结果</div>
              <pre>{JSON.stringify(step.result, null, 2)}</pre>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
