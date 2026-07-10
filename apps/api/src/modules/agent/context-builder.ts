/**
 * 上下文构建器：把会话历史 + 摘要加工成喂给 LLM 的 messages。
 *
 * 核心问题：会话越长，历史越大，token 成本越高，模型也越容易被旧内容带偏。
 * 本模块的策略是"摘要兜底 + 近期消息按预算补齐"：
 * 1. 已被摘要覆盖的旧消息不再原文进入上下文，而是浓缩成一条 system 摘要；
 * 2. 摘要之后的新消息按"时间顺序 + 条数上限 + 字符预算"截取；
 * 3. 失败/取消等异常轮次也会被翻译成对 LLM 友好的简短描述。
 *
 * 边界：本文件只负责"读历史 → 产出 AgentMessage[]"，不调用 LLM、不落库。
 */
import type { AgentMessageRecord, AgentSessionSummary, AgentSessionSummaryRecord } from "./agent-store.js";
import { partsToLlmText } from "./message-parts.js";
import type { AgentMessage } from "./types.js";

/** 默认最多带入的历史消息条数。条数过多会稀释模型注意力、增加成本。 */
const DEFAULT_MAX_CONTEXT_MESSAGES = 12;
/** 默认历史字符预算。与条数上限配合，防止少数超长消息把上下文撑爆。 */
const DEFAULT_MAX_HISTORY_CHARACTERS = 12_000;
/** 失败原因展示给 LLM 时的最大长度，超长截断，避免错误堆栈污染上下文。 */
const MAX_FAILURE_REASON_LENGTH = 120;

/** 上下文构建器可调参数。未传时使用上方默认值。 */
export interface AgentContextBuilderOptions {
  maxHistoryMessages?: number;
  maxHistoryCharacters?: number;
}

/**
 * 上下文构建器。
 *
 * 通过构造参数固化"条数/字符"两个预算，对外暴露 buildConversationHistory
 * 作为唯一入口。把策略收敛在一个类里，便于不同场景（测试、不同套餐配额）
 * 注入不同预算，而不必到处传参；同时 maxHistoryMessages=0 可用于完全关闭
 * 历史只保留摘要。
 */
export class AgentContextBuilder {
  private readonly maxHistoryMessages: number;
  private readonly maxHistoryCharacters: number;

  constructor(options: AgentContextBuilderOptions = {}) {
    this.maxHistoryMessages = options.maxHistoryMessages ?? DEFAULT_MAX_CONTEXT_MESSAGES;
    this.maxHistoryCharacters = options.maxHistoryCharacters ?? DEFAULT_MAX_HISTORY_CHARACTERS;
  }

  /** 暴露条数上限给上层，便于做配额展示或断言。 */
  getHistoryMessageLimit(): number {
    return this.maxHistoryMessages;
  }

  buildConversationHistory(messages: AgentMessageRecord[], summary?: AgentSessionSummaryRecord): AgentMessage[] {
    // 给 LLM 的上下文不是简单"全量历史塞进去"：
    // 旧消息先压成 summary，当作一条 system 记忆；summary 覆盖之后的新消息再按时间和字符预算补上。
    // 这样能让模型记住长期目标，同时避免上下文越来越长、成本越来越高。
    const summaryMessage = summary ? renderSummaryMessage(summary.summary) : undefined;

    if (this.maxHistoryMessages === 0) {
      return summaryMessage ? [summaryMessage] : [];
    }

    const sourceMessages = summary ? sliceMessagesAfterCoveredMessage(messages, summary.coveredMessageId) : messages;
    const contextMessages = sourceMessages
      .filter((message) => toContextMessage(message) !== undefined)
      .sort((leftMessage, rightMessage) => leftMessage.createdAt.localeCompare(rightMessage.createdAt))
      .slice(-this.maxHistoryMessages);
    const selectedMessages = this.selectMessagesWithinBudget(contextMessages);

    const historyMessages = selectedMessages.flatMap((message) => {
      const contextMessage = toContextMessage(message);
      return contextMessage ? [contextMessage] : [];
    });

    return summaryMessage ? [summaryMessage, ...historyMessages] : historyMessages;
  }

  private selectMessagesWithinBudget(messages: AgentMessageRecord[]): AgentMessageRecord[] {
    const selectedMessages: AgentMessageRecord[] = [];
    let usedCharacters = 0;

    // 从最新消息往前挑，优先保证最近对话完整。
    // 第一条即使超预算也会保留，否则极端情况下模型会拿不到任何历史。
    for (const message of [...messages].reverse()) {
      const messageCharacters = countMessageCharacters(message);

      if (selectedMessages.length > 0 && usedCharacters + messageCharacters > this.maxHistoryCharacters) {
        continue;
      }

      selectedMessages.push(message);
      usedCharacters += messageCharacters;
    }

    return selectedMessages.reverse();
  }
}

/**
 * 切出"摘要已覆盖消息"之后的所有消息。
 *
 * 摘要对应的最后一条消息 id 记录在 summary.coveredMessageId，该条及之前的
 * 旧消息已被浓缩进摘要，不再重复进入上下文。找不到对应 id 时（例如消息已被
 * 清理）安全降级为返回全部消息，避免上下文突然清空。
 */
function sliceMessagesAfterCoveredMessage(messages: AgentMessageRecord[], coveredMessageId: string): AgentMessageRecord[] {
  const sortedMessages = [...messages].sort((leftMessage, rightMessage) =>
    leftMessage.createdAt.localeCompare(rightMessage.createdAt)
  );
  const coveredMessageIndex = sortedMessages.findIndex((message) => message.id === coveredMessageId);

  if (coveredMessageIndex === -1) {
    return sortedMessages;
  }

  return sortedMessages.slice(coveredMessageIndex + 1);
}

function renderSummaryMessage(summary: AgentSessionSummary): AgentMessage | undefined {
  // 摘要以 system 消息注入，是为了让模型把它当"会话记忆"，而不是用户刚刚说的话。
  // 但提示里明确"以用户最新消息为准"，避免旧摘要压过当前意图。
  const sections = [
    renderSingleLineSection("用户目标", summary.userGoal),
    renderSingleLineSection("当前任务", summary.currentTask),
    renderListSection("已确认决策", summary.decisions),
    renderListSection("用户偏好", summary.preferences),
    renderListSection("约束条件", summary.constraints),
    renderListSection("重要事实", summary.importantFacts),
    renderListSection("未解决问题", summary.openQuestions),
    renderListSection("近期进展", summary.recentProgress)
  ].filter(Boolean);

  if (!sections.length) {
    return undefined;
  }

  return {
    role: "system",
    content: ["以下是此前对话的结构化摘要，请把它当作会话记忆使用，但以用户最新消息为准。", ...sections].join("\n\n")
  };
}

/** 渲染"标签：单行值"形式的摘要小节，值为空时返回空串（由上层统一过滤）。 */
function renderSingleLineSection(label: string, value?: string): string {
  const normalizedValue = value?.trim();
  return normalizedValue ? `${label}：${normalizedValue}` : "";
}

/** 渲染"标签 + 列表项"形式的摘要小节，没有非空项时返回空串。 */
function renderListSection(label: string, values: string[]): string {
  const normalizedValues = values.map((value) => value.trim()).filter(Boolean);

  if (!normalizedValues.length) {
    return "";
  }

  return `${label}：\n${normalizedValues.map((value) => `- ${value}`).join("\n")}`;
}

/** 估算一条消息进入上下文后的字符成本，用作字符预算的计量单位。 */
function countMessageCharacters(message: AgentMessageRecord): number {
  const contextMessage = toContextMessage(message);
  return contextMessage?.content?.length ?? 0;
}

function toContextMessage(message: AgentMessageRecord): AgentMessage | undefined {
  const content = partsToLlmText(message.parts);

  // 上下文只放 user/assistant。system 状态消息、运行中的 assistant 都不放，
  // 因为它们更多是 UI/流程状态，直接喂给 LLM 反而容易干扰下一轮推理。
  if (message.role === "user" && content) {
    return { role: "user", content };
  }

  if (message.role !== "assistant") {
    return undefined;
  }

  if (message.status === "completed" && content) {
    return { role: "assistant", content };
  }

  if (message.status === "failed") {
    return { role: "assistant", content: buildFailureSummary(message) };
  }

  if (message.status === "cancelled") {
    return { role: "assistant", content: "上一轮回答被用户中断。" };
  }

  return undefined;
}

/**
 * 把失败轮次翻译成一句对 LLM 友好的简短描述。
 *
 * 直接把原始 error.message 喂给模型既不安全（可能含敏感信息/链接），也容易
 * 让模型陷入"反复道歉"。这里只保留经过清洗的简短原因，没有原因时给固定文案。
 */
function buildFailureSummary(message: AgentMessageRecord): string {
  const reason = sanitizeFailureReason(message.error?.message);

  if (!reason) {
    return "上一轮没有完成。";
  }

  return `上一轮没有完成，失败原因：${reason}`;
}

/**
 * 清洗失败原因后再展示给 LLM：
 * - 长串链接与疑似密钥/token（32+ 字符的连续标识）统一替换为占位，避免泄露与噪音；
 * - 折叠多余空白；
 * - 超长截断，防止一段错误日志吃掉大量上下文预算。
 */
function sanitizeFailureReason(message?: string): string {
  if (!message) {
    return "";
  }

  const withoutLinks = message
    .replace(/https?:\/\/\S+/g, "[链接]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[已隐藏]")
    .replace(/\s+/g, " ")
    .trim();

  return withoutLinks.length > MAX_FAILURE_REASON_LENGTH
    ? `${withoutLinks.slice(0, MAX_FAILURE_REASON_LENGTH)}...`
    : withoutLinks;
}
