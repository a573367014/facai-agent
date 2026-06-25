import type { AgentRunRecord } from "./run-store.js";
import type { AgentMessage } from "./types.js";

const DEFAULT_MAX_CONTEXT_RUNS = 6;
const DEFAULT_MAX_HISTORY_CHARACTERS = 12_000;
const MAX_FAILURE_REASON_LENGTH = 120;

export interface AgentContextBuilderOptions {
  maxHistoryRuns?: number;
  maxCompletedRuns?: number;
  maxHistoryCharacters?: number;
}

export class AgentContextBuilder {
  private readonly maxHistoryRuns: number;
  private readonly maxHistoryCharacters: number;

  constructor(options: AgentContextBuilderOptions = {}) {
    this.maxHistoryRuns = options.maxHistoryRuns ?? options.maxCompletedRuns ?? DEFAULT_MAX_CONTEXT_RUNS;
    this.maxHistoryCharacters = options.maxHistoryCharacters ?? DEFAULT_MAX_HISTORY_CHARACTERS;
  }

  buildConversationHistory(runs: AgentRunRecord[]): AgentMessage[] {
    if (this.maxHistoryRuns === 0) {
      return [];
    }

    const contextRuns = runs
      .filter((run) => toRunMessages(run).length > 0)
      .sort((leftRun, rightRun) => leftRun.createdAt.localeCompare(rightRun.createdAt))
      .slice(-this.maxHistoryRuns);

    const selectedRuns = this.selectRunsWithinBudget(contextRuns);

    return selectedRuns.flatMap(toRunMessages);
  }

  private selectRunsWithinBudget(runs: AgentRunRecord[]): AgentRunRecord[] {
    const selectedRuns: AgentRunRecord[] = [];
    let usedCharacters = 0;

    for (const run of [...runs].reverse()) {
      const runCharacters = countRunCharacters(run);

      // 最近一轮即使超过预算也保留。否则一次很长的上一轮对话会导致“完全没有上下文”，
      // 体验上比软性超预算更糟。后续接 tokenizer 后，可以把这里升级成截断或摘要。
      if (selectedRuns.length > 0 && usedCharacters + runCharacters > this.maxHistoryCharacters) {
        continue;
      }

      selectedRuns.push(run);
      usedCharacters += runCharacters;
    }

    return selectedRuns.reverse();
  }
}

function countRunCharacters(run: AgentRunRecord): number {
  return toRunMessages(run).reduce((total, message) => total + (message.content?.length ?? 0), 0);
}

function toRunMessages(run: AgentRunRecord): AgentMessage[] {
  if (run.status === "completed" && run.answer) {
    return [
      { role: "user", content: run.input },
      { role: "assistant", content: run.answer }
    ];
  }

  if (run.status === "failed") {
    return [
      { role: "user", content: run.input },
      { role: "assistant", content: buildFailureSummary(run) }
    ];
  }

  if (run.status === "cancelled") {
    return [
      { role: "user", content: run.input },
      { role: "assistant", content: "上一轮回答被用户中断。" }
    ];
  }

  return [];
}

function buildFailureSummary(run: AgentRunRecord): string {
  const reason = sanitizeFailureReason(run.error?.message);

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
