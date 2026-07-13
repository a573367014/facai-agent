/**
 * Agent 领域类型定义。
 *
 * 本文件是 Agent 执行引擎内部的类型边界，职责有二：
 * 1. 重新导出对外契约（@agent/contracts）与工具类型（../tools/types）中
 *    Agent 链路需要用到的部分，让本模块内部只依赖一个本地入口；
 * 2. 定义 Agent 执行链路专用的类型：ToolCall / AgentMessage /
 *    AgentExecutionInput / AgentExecutionResult。
 *
 * 边界说明：这里的 AgentMessage 是"喂给 LLM 的消息形态"，与存储/展示用的
 * MessagePart（见 message-parts.ts）、对外 DTO（AgentMessageDto 等）是三套
 * 不同模型，分别服务于"推理 / 存储 / 传输"，不要互相混用。
 */
import type { AgentStreamEvent, MessagePart } from "@agent/contracts";
import type { JsonObject, ToolDefinition } from "../tools/types.js";

export type {
  AgentErrorDetail,
  AgentMessageDto as AgentMessageSnapshot,
  AgentProcessStepDto as AgentProcessStepSnapshot,
  AgentResourceDto as AgentResourceSnapshot,
  AgentState,
  AgentStreamEvent
} from "@agent/contracts";
export type { JsonObject, RegisteredTool, ToolDefinition } from "../tools/types.js";

/**
 * 一次工具调用的请求结构。
 *
 * 表示模型在 assistant 消息里发起的"我要调用某个工具"的请求，
 * 对应 OpenAI/Anthropic 风格的 function/tool call。
 * - id：本次调用的唯一标识，工具结果（role: "tool"）靠它关联回来，
 *   多工具并发时模型据此对齐"哪条结果对应哪次调用"；
 * - name：要调用的工具名，必须在已注册工具表中，否则执行器会拒绝；
 * - arguments：工具入参，结构由具体 ToolDefinition 约束。
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

/**
 * 喂给 LLM 的消息单元。
 *
 * 这里只保留 LLM 推理需要的最小信息，刻意不携带存储模型里的状态、parts 等：
 * - system：系统/记忆消息（如会话摘要、系统指令）；
 * - user：用户输入；
 * - assistant：模型回复，可同时携带 toolCalls（一轮里既回话又调工具），
 *   content 可选是为了支持"纯工具调用、不输出文字"的回合；
 * - tool：工具执行结果，必须带 toolCallId，否则模型无法把它对回原调用。
 */
export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/**
 * Agent 执行入口的输入契约。
 *
 * 调用方提供本轮用户输入及可选的运行参数：
 * - input：纯文本输入（parts 的降级形态）；
 * - parts：结构化输入（图片/视频/占位控件等），存在时优先于 input；
 * - history：预构建的历史消息，存在时跳过内部历史构建逻辑；
 * - replayToolCalls：重放模式下的工具调用，用于复现/调试，避免真实再调一次；
 * - maxIterations：工具调用循环的最大轮数，防止模型陷入无限调工具；
 * - messageId/sessionId：用于事件溯源与持久化关联；
 * - signal：外部取消信号，长任务可被中断；
 * - onEvent：流式事件回调，Agent 通过它把 token、工具进度等增量推给上层。
 */
export interface AgentExecutionInput {
  input: string;
  parts?: MessagePart[];
  history?: AgentMessage[];
  replayToolCalls?: ToolCall[];
  maxIterations?: number;
  messageId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
}

/**
 * Agent 执行出口结果。
 *
 * 目前只返回最终的自然语言答案；中间过程（工具调用、token 流）通过
 * onEvent 流式推送，因此这里不需要承载过程数据，保持出口最小化。
 */
export interface AgentExecutionResult {
  answer: string;
}
