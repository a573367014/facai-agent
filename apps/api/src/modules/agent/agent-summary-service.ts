/**
 * 模块职责：会话摘要服务。
 *
 * 当对话变长时，把早期消息压缩成结构化摘要（userGoal / decisions / preferences 等），
 * 写入 SQLite 作为后续对话的 system 记忆。这样既节省 token 又保留关键上下文。
 *
 * 核心设计：
 * 1. "够多再做"：不是每轮都压缩，而是当新增消息数超过阈值且内容字符数足够时才触发。
 * 2. "保留最近原文"：最近 N 条消息保留原文不压缩，减少摘要丢细节带来的误解。
 * 3. 摘要模型不允许用工具，只做"旧摘要 + 新消息 → 结构化 JSON"的合并。
 *
 * 边界：
 * - 只负责生成摘要内容，不负责决定何时触发（由 coordinator 调用 planRefresh 判断）。
 * - 不直接写 SQLite，返回结果由 coordinator 落库。
 * - 压缩失败不中断主回答流程，由 coordinator 决定如何处理。
 */
import type { LlmProvider } from "./providers/types.js";
import type { AgentMessageRecord, AgentSessionSummary, AgentSessionSummaryRecord } from "./agent-store.js";
import { partsToLlmText } from "./message-parts.js";

const SUMMARY_SCHEMA_VERSION = 1;
const DEFAULT_TRIGGER_MESSAGE_COUNT = 16;
const DEFAULT_KEEP_RECENT_MESSAGES = 8;
const DEFAULT_TRIGGER_CHARACTER_COUNT = 2000;

interface ContextLikeMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentSummaryServiceOptions {
  provider: LlmProvider;
  triggerMessageCount?: number;
  keepRecentMessages?: number;
  triggerCharacterCount?: number;
}

export interface RefreshSessionSummaryInput {
  sessionId: string;
  messages: AgentMessageRecord[];
  previousSummary?: AgentSessionSummaryRecord;
}

export interface RefreshSessionSummaryResult {
  summary: AgentSessionSummary;
  coveredMessageId: string;
  schemaVersion: number;
}

export interface AgentSummaryRefreshPlan {
  messagesToSummarizeLimit: number;
}

export interface SummarizeSessionMessagesInput {
  sessionId: string;
  messagesToSummarize: AgentMessageRecord[];
  previousSummary?: AgentSessionSummaryRecord;
  signal?: AbortSignal;
}

/**
 * 会话摘要服务。调用 LLM 把旧摘要和新增消息合并成结构化摘要。
 * 触发阈值可配置：triggerMessageCount（消息条数）、triggerCharacterCount（内容字符数）、
 * keepRecentMessages（保留最近原文条数）。两个阈值都满足才触发压缩。
 */
export class AgentSummaryService {
  private readonly triggerMessageCount: number;
  private readonly keepRecentMessages: number;
  private readonly triggerCharacterCount: number;

  constructor(private readonly options: AgentSummaryServiceOptions) {
    this.triggerMessageCount = options.triggerMessageCount ?? DEFAULT_TRIGGER_MESSAGE_COUNT;
    this.keepRecentMessages = options.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES;
    this.triggerCharacterCount = options.triggerCharacterCount ?? DEFAULT_TRIGGER_CHARACTER_COUNT;
  }

  /**
   * 刷新会话摘要。计算上一份摘要之后新增的消息，判断是否达到压缩阈值，
   * 达标则调用 LLM 生成新摘要。返回 undefined 表示不需要刷新。
   */
  async refreshSessionSummary(input: RefreshSessionSummaryInput): Promise<RefreshSessionSummaryResult | undefined> {
    const messages = toContextLikeMessages(input.messages);
    const uncoveredMessages = sliceAfterCoveredMessage(messages, input.previousSummary?.coveredMessageId);
    const refreshPlan = this.planRefresh(uncoveredMessages.length);

    // 摘要刷新是“够多再做”，不是每轮都调用模型。
    // 先看上一份摘要之后新增了多少可总结消息，再决定是否压缩旧上下文。
    if (!refreshPlan) {
      return undefined;
    }

    // 只有消息条数多还不够，内容太短时压缩收益很低。
    // 这个字符阈值能避免频繁花模型费用生成价值不大的摘要。
    if (!this.hasEnoughContextRefreshContent(uncoveredMessages)) {
      return undefined;
    }

    return this.summarizeContextMessages({
      previousSummary: input.previousSummary,
      messagesToSummarize: uncoveredMessages.slice(0, refreshPlan.messagesToSummarizeLimit)
    });
  }

  /**
   * 根据未覆盖消息数判断是否需要压缩，返回需要压缩的消息条数上限。
   * 返回 undefined 表示不需要压缩。coordinator 在正式回答前调用此方法决策。
   */
  planRefresh(uncoveredMessageCount: number): AgentSummaryRefreshPlan | undefined {
    if (this.triggerMessageCount <= 0 || uncoveredMessageCount <= this.triggerMessageCount) {
      return undefined;
    }

    // keepRecentMessages 是“保留最近原文”的数量。
    // 被压缩进摘要的是更早的部分，最近几轮保留原文可以减少摘要丢细节带来的误解。
    const keepRecentMessages = Math.max(1, this.keepRecentMessages);
    const messagesToSummarizeLimit = Math.max(0, uncoveredMessageCount - keepRecentMessages);

    return messagesToSummarizeLimit > 0 ? { messagesToSummarizeLimit } : undefined;
  }

  hasEnoughRefreshContent(messagesToSummarize: AgentMessageRecord[]): boolean {
    if (this.triggerCharacterCount <= 0) {
      return true;
    }

    return countSummaryCharacters(messagesToSummarize) >= this.triggerCharacterCount;
  }

  private hasEnoughContextRefreshContent(messagesToSummarize: ContextLikeMessage[]): boolean {
    if (this.triggerCharacterCount <= 0) {
      return true;
    }

    return countSummaryCharacters(messagesToSummarize) >= this.triggerCharacterCount;
  }

  /**
   * 对指定消息列表生成结构化摘要。coordinator 在决定压缩后调用此方法。
   * 返回的 summary 和 coveredMessageId 由 coordinator 写入 SQLite。
   * 支持 AbortSignal，coordinator 在 run 被取消时可以中断摘要生成。
   */
  async summarizeSessionMessages(input: SummarizeSessionMessagesInput): Promise<RefreshSessionSummaryResult | undefined> {
    return this.summarizeContextMessages({
      previousSummary: input.previousSummary,
      messagesToSummarize: toContextLikeMessages(input.messagesToSummarize),
      signal: input.signal
    });
  }

  private async summarizeContextMessages(input: {
    previousSummary?: AgentSessionSummaryRecord;
    messagesToSummarize: ContextLikeMessage[];
    signal?: AbortSignal;
  }): Promise<RefreshSessionSummaryResult | undefined> {
    const coveredMessageId = input.messagesToSummarize.at(-1)?.id;

    if (!input.messagesToSummarize.length || !coveredMessageId) {
      return undefined;
    }

    // 摘要模型不允许用工具：它只是把旧摘要 + 新消息合并成结构化 JSON。
    // 这里的输出后面会写入 SQLite，再由 ContextBuilder 转成 system 记忆喂回主 Agent。
    const response = await this.options.provider.complete({
      tools: [],
      signal: input.signal,
      messages: [
        {
          role: "system",
          content:
            "你是会话记忆压缩器。只基于用户提供的旧摘要和新增消息，输出严格 JSON，不要输出 Markdown。不要编造信息，不要保留完整密钥、token 或长链接。"
        },
        {
          role: "user",
          content: buildSummaryPrompt(input.previousSummary?.summary, input.messagesToSummarize)
        }
      ]
    });

    return {
      summary: normalizeSummary(parseSummaryJson(response.content ?? "")),
      coveredMessageId,
      schemaVersion: SUMMARY_SCHEMA_VERSION
    };
  }
}

function buildSummaryPrompt(previousSummary: AgentSessionSummary | undefined, messages: ContextLikeMessage[]): string {
  const previousSummaryText = previousSummary ? JSON.stringify(previousSummary, null, 2) : "无";
  const messageText = messages.map((message) => `${message.role}：${message.content}`).join("\n\n");

  return [
    "请把旧摘要与新增消息合并为新的结构化会话摘要。",
    "输出 JSON 必须包含这些字段：userGoal, currentTask, decisions, preferences, constraints, importantFacts, openQuestions, recentProgress。",
    "其中 userGoal/currentTask 是字符串，其余字段是字符串数组。",
    "如果某字段没有信息，字符串用空字符串，数组用空数组。",
    "",
    "旧摘要：",
    previousSummaryText,
    "",
    "新增消息：",
    messageText
  ].join("\n");
}

function toContextLikeMessages(messages: AgentMessageRecord[]): ContextLikeMessage[] {
  return messages
    .map((message) => toContextLikeMessage(message))
    .filter((message): message is ContextLikeMessage => message !== undefined)
    .sort((leftMessage, rightMessage) => leftMessage.createdAt.localeCompare(rightMessage.createdAt));
}

function toContextLikeMessage(message: AgentMessageRecord): ContextLikeMessage | undefined {
  const content = partsToLlmText(message.parts);

  // 摘要服务和真正对话上下文使用同一套“可被 LLM 理解的文本投影”。
  // 媒体、失败、取消都会被转成短文本，避免摘要模型看到前端专用的结构化对象。
  if (message.role === "user" && content) {
    return { id: message.id, role: "user", content, createdAt: message.createdAt };
  }

  if (message.role !== "assistant") {
    return undefined;
  }

  if (message.status === "completed" && content) {
    return { id: message.id, role: "assistant", content, createdAt: message.createdAt };
  }

  if (message.status === "failed") {
    return {
      id: message.id,
      role: "assistant",
      content: message.error?.message ? `上一轮失败：${message.error.message}` : "上一轮没有完成。",
      createdAt: message.createdAt
    };
  }

  if (message.status === "cancelled") {
    return { id: message.id, role: "assistant", content: "上一轮回答被用户中断。", createdAt: message.createdAt };
  }

  return undefined;
}

function sliceAfterCoveredMessage(messages: ContextLikeMessage[], coveredMessageId?: string): ContextLikeMessage[] {
  if (!coveredMessageId) {
    return messages;
  }

  const coveredMessageIndex = messages.findIndex((message) => message.id === coveredMessageId);

  if (coveredMessageIndex === -1) {
    return messages;
  }

  return messages.slice(coveredMessageIndex + 1);
}

function countSummaryCharacters(messages: AgentMessageRecord[] | ContextLikeMessage[]): number {
  return messages.reduce((total, message) => {
    if (isContextLikeMessage(message)) {
      return total + message.content.trim().length;
    }

    return total + countRecordCharacters(message);
  }, 0);
}

function isContextLikeMessage(message: AgentMessageRecord | ContextLikeMessage): message is ContextLikeMessage {
  return "content" in message;
}

function countRecordCharacters(message: AgentMessageRecord): number {
  if (message.role === "user") {
    return partsToLlmText(message.parts).trim().length;
  }

  if (message.role === "assistant" && message.status === "completed") {
    return partsToLlmText(message.parts).trim().length;
  }

  if (message.role === "assistant" && message.status === "failed") {
    return partsToLlmText(message.parts).trim().length || message.error?.message.trim().length || 0;
  }

  return 0;
}

function parseSummaryJson(content: string): unknown {
  const trimmedContent = content.trim();
  const fencedMatch = trimmedContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const jsonText = fencedMatch?.[1] ?? trimmedContent;

  // 虽然提示要求“只输出 JSON”，兼容模型偶尔包一层 ```json。
  // 解析失败直接抛出，让调用方把摘要步骤标记失败；主回答流程不应该吃到半坏摘要。
  return JSON.parse(jsonText) as unknown;
}

function normalizeSummary(value: unknown): AgentSessionSummary {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

  return {
    userGoal: readOptionalString(record.userGoal),
    currentTask: readOptionalString(record.currentTask),
    decisions: readStringArray(record.decisions),
    preferences: readStringArray(record.preferences),
    constraints: readStringArray(record.constraints),
    importantFacts: readStringArray(record.importantFacts),
    openQuestions: readStringArray(record.openQuestions),
    recentProgress: readStringArray(record.recentProgress)
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}
