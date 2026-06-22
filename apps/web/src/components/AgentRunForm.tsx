import { Loader2, Play, Radio } from "lucide-react";
import type { FormEvent } from "react";

interface AgentRunFormProps {
  input: string;
  maxIterations: number;
  isRunning: boolean;
  isStreaming: boolean;
  onInputChange: (value: string) => void;
  onMaxIterationsChange: (value: number) => void;
  onSubmit: () => void;
  onStreamSubmit: () => void;
}

const examples = [
  "计算 12 * 9，然后告诉我现在几点",
  "现在上海时间是多少？",
  "帮我计算 (32 + 18) * 4"
];

export function AgentRunForm(props: AgentRunFormProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onSubmit();
  }

  return (
    <form className="panel run-form" onSubmit={handleSubmit}>
      <div className="panel-heading compact">
        <div>
          <span className="eyebrow">Task</span>
          <h2>运行 Agent</h2>
        </div>
      </div>

      <div className="field">
        <label htmlFor="agent-input">任务</label>
        <textarea
          id="agent-input"
          value={props.input}
          onChange={(event) => props.onInputChange(event.target.value)}
          rows={8}
        />
      </div>

      <div className="form-row">
        <label htmlFor="max-iterations">最大迭代</label>
        <input
          id="max-iterations"
          type="number"
          min={1}
          max={8}
          value={props.maxIterations}
          onChange={(event) => props.onMaxIterationsChange(Number(event.target.value))}
        />
      </div>

      <div className="button-row">
        <button className="primary-button" type="submit" disabled={props.isRunning || props.isStreaming || !props.input.trim()}>
          {props.isRunning ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
          运行
        </button>

        <button
          className="secondary-button"
          type="button"
          disabled={props.isRunning || props.isStreaming || !props.input.trim()}
          onClick={props.onStreamSubmit}
        >
          {props.isStreaming ? <Loader2 size={16} className="spin" /> : <Radio size={16} />}
          流式运行
        </button>
      </div>

      <div className="examples">
        <div className="examples-title">示例</div>
        {examples.map((example) => (
          <button type="button" key={example} onClick={() => props.onInputChange(example)}>
            {example}
          </button>
        ))}
      </div>
    </form>
  );
}
