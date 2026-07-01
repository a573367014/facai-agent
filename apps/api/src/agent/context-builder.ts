import type { AgentMessageRecord, AgentSessionSummary, AgentSessionSummaryRecord } from "./agent-store.js";
import { partsToLlmText } from "./message-parts.js";
import type { AgentMessage } from "./types.js";

const DEFAULT_MAX_CONTEXT_MESSAGES = 12;
const DEFAULT_MAX_HISTORY_CHARACTERS = 12_000;
const MAX_FAILURE_REASON_LENGTH = 120;

export interface AgentContextBuilderOptions {
  maxHistoryMessages?: number;
  maxHistoryCharacters?: number;
}

export class AgentContextBuilder {
  private readonly maxHistoryMessages: number;
  private readonly maxHistoryCharacters: number;

  constructor(options: AgentContextBuilderOptions = {}) {
    this.maxHistoryMessages = options.maxHistoryMessages ?? DEFAULT_MAX_CONTEXT_MESSAGES;
    this.maxHistoryCharacters = options.maxHistoryCharacters ?? DEFAULT_MAX_HISTORY_CHARACTERS;
  }

  getHistoryMessageLimit(): number {
    return this.maxHistoryMessages;
  }

  buildConversationHistory(messages: AgentMessageRecord[], summary?: AgentSessionSummaryRecord): AgentMessage[] {
    // 给 LLM 的上下文不是简单“全量历史塞进去”：
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
  // 摘要以 system 消息注入，是为了让模型把它当“会话记忆”，而不是用户刚刚说的话。
  // 但提示里明确“以用户最新消息为准”，避免旧摘要压过当前意图。
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

function renderSingleLineSection(label: string, value?: string): string {
  const normalizedValue = value?.trim();
  return normalizedValue ? `${label}：${normalizedValue}` : "";
}

function renderListSection(label: string, values: string[]): string {
  const normalizedValues = values.map((value) => value.trim()).filter(Boolean);

  if (!normalizedValues.length) {
    return "";
  }

  return `${label}：\n${normalizedValues.map((value) => `- ${value}`).join("\n")}`;
}

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

function buildFailureSummary(message: AgentMessageRecord): string {
  const reason = sanitizeFailureReason(message.error?.message);

  if (!reason) {
    return "上一轮没有完成。";
  }

  return `上一轮没有完成，失败原因：${reason}`;
}

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
