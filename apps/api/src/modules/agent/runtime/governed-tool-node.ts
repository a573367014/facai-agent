/**
 * 受治理的工具节点：LangGraph 状态定义与工具节点事件契约。
 *
 * 本文件是 LangGraph 图执行的核心基础设施，定义了两样东西：
 * 1. AgentState —— LangGraph 图节点之间共享的状态形状（消息列表、
 *    迭代计数、是否需要资源总结），以及各字段的 reducer（合并策略）；
 * 2. ToolNodeEvents —— 工具执行节点向上层暴露的事件回调契约
 *    （开始/进度/结果/错误），让 AgentService 能把工具执行过程流式推给前端。
 *
 * 边界说明：本文件只定义"状态形状"和"事件契约"，不包含工具执行逻辑本身——
 * 真正的执行在 langchain-agent-service.ts 的 governedTools 节点函数里。
 * "governed"（受治理）的含义是：工具执行不是裸调用，而是经过权限过滤、
 * 错误恢复、事件上报等治理流程的。
 */
import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";

/**
 * LangGraph 图的共享状态。
 *
 * 三个字段各自有 reducer，决定了图节点返回的增量如何合并进全局状态：
 *
 * - messages：reducer 是数组拼接（[...xs, ...ys]），所以每个节点返回的
 *   messages 会被追加到已有列表末尾，而不是替换。这是 Agent 对话的核心
 *   语义——每轮的 AI 消息、工具消息都累积起来，形成完整上下文。
 *   如果改成替换，模型会丢失历史，无法做多轮推理。
 *
 * - iteration：reducer 是"用新值覆盖"（(_x, y) => y ?? 0），因为迭代计数
 *   是单调递增的标量，每次节点返回最新值即可，不需要累积。
 *
 * - needsResourceSummary：标记本轮工具执行后是否需要走"资源失败总结"
 *   分支。同样用覆盖语义，因为这是一个临时标志，用完即弃。
 */
export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (xs, ys) => [...xs, ...ys],
    default: () => []
  }),
  iteration: Annotation<number>({
    reducer: (_x, y) => y ?? 0,
    default: () => 0
  }),
  needsResourceSummary: Annotation<boolean>({
    reducer: (_x, y) => y ?? false,
    default: () => false
  })
});

export type AgentStateType = typeof AgentState.State;

/**
 * 工具节点事件回调契约。
 *
 * 工具执行节点（governedTools）通过这组回调把执行过程上报给 AgentService，
 * 后者再转成 AgentStreamEvent 推给前端 SSE。四个回调覆盖了工具执行的
 * 完整生命周期：
 *
 * - onToolStart：工具开始执行，前端可以显示"正在调用 xxx"；
 * - onToolProgress：长耗时工具的中间进度（如批量生图完成了 3/10），
 *   让前端能展示进度条而不是干等；
 * - onToolResult：工具成功完成，携带结果数据和耗时；
 * - onToolError：工具执行失败，携带错误码和是否可恢复的标记。
 *
 * 为什么用回调而不是直接返回事件列表：因为工具执行是异步且可能很长，
 * 用回调可以实时推送进度，而列表只能等执行完一次性返回，体验差很多。
 */
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

/**
 * 创建一条 ToolMessage（工具结果消息）。
 *
 * 工具执行完后，结果需要以 ToolMessage 形式写回消息列表，模型才能在
 * 下一轮看到工具返回了什么。tool_call_id 是关键——它把这条结果关联回
 * 模型发起的某次具体调用，模型据此知道"这个结果对应我刚才调的哪个工具"。
 * 如果不传 tool_call_id，模型会把结果和调用对不上号，推理会混乱。
 */
export function createToolMessage(
  content: string,
  toolCallId: string,
  toolName: string
): ToolMessage {
  return new ToolMessage({ content, tool_call_id: toolCallId, name: toolName });
}
