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
