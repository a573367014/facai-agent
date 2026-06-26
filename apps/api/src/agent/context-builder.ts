import type { AgentMessageRecord } from "./agent-store.js";
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

  buildConversationHistory(messages: AgentMessageRecord[]): AgentMessage[] {
    if (this.maxHistoryMessages === 0) {
      return [];
    }

    const contextMessages = messages
      .filter((message) => toContextMessage(message) !== undefined)
      .sort((leftMessage, rightMessage) => leftMessage.createdAt.localeCompare(rightMessage.createdAt))
      .slice(-this.maxHistoryMessages);
    const selectedMessages = this.selectMessagesWithinBudget(contextMessages);

    return selectedMessages.flatMap((message) => {
      const contextMessage = toContextMessage(message);
      return contextMessage ? [contextMessage] : [];
    });
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

function countMessageCharacters(message: AgentMessageRecord): number {
  const contextMessage = toContextMessage(message);
  return contextMessage?.content?.length ?? 0;
}

function toContextMessage(message: AgentMessageRecord): AgentMessage | undefined {
  if (message.role === "user" && message.content) {
    return { role: "user", content: message.content };
  }

  if (message.role !== "assistant") {
    return undefined;
  }

  if (message.status === "completed" && message.content) {
    return { role: "assistant", content: message.content };
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
