import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (xs, ys) => [...xs, ...ys],
    default: () => []
  }),
  iteration: Annotation<number>({
    reducer: (_x, y) => y ?? 0,
    default: () => 0
  }),
  needsMediaSummary: Annotation<boolean>({
    reducer: (_x, y) => y ?? false,
    default: () => false
  })
});

export type AgentStateType = typeof AgentState.State;

export interface ToolNodeEvents {
  onToolStart: (toolCallId: string, toolName: string, arguments_: Record<string, unknown>) => Promise<void>;
  onToolProgress: (toolCallId: string, toolName: string, progress: Record<string, unknown>) => Promise<void>;
  onToolResult: (
    toolCallId: string,
    toolName: string,
    data: unknown,
    durationMs: number,
    llmContent?: string
  ) => Promise<void>;
  onToolError: (
    toolCallId: string,
    toolName: string,
    error: { code: string; message: string; recoverable?: boolean },
    durationMs: number
  ) => Promise<void>;
}

export function createToolMessage(
  content: string,
  toolCallId: string,
  toolName: string
): ToolMessage {
  return new ToolMessage({ content, tool_call_id: toolCallId, name: toolName });
}
