import type {
  AgentMessageRecord,
  AgentProcessStepRecord,
  AgentRunRecord,
  AgentStreamEvent,
  MessagePart
} from "@/features/chat/api/agent-types";
import type { ChatMessage } from "./chat-message";

function toChatMessageStatus(status: AgentMessageRecord["status"]): ChatMessage["status"] {
  return status;
}

export function createMessageFromRecord(
  message: AgentMessageRecord,
  options: { version?: number; processSteps?: AgentProcessStepRecord[] } = {}
): ChatMessage {
  const error = message.error ? `${message.error.code}: ${message.error.message}` : undefined;

  return {
    id: message.id,
    role: message.role,
    parts: normalizeMessagePartsForDisplay(message),
    status: toChatMessageStatus(message.status),
    version: options.version,
    processSteps: options.processSteps ?? [],
    events: [],
    error,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    completedAt: message.completedAt
  };
}

function normalizeSummaryStatusText(value: string) {
  return value
    .replace("已自动压缩较早上下文，后续会基于摘要和最近消息继续对话", "上下文已自动压缩，后续会基于摘要和最近消息继续对话")
    .replace("已自动压缩较早上下文", "上下文已自动压缩")
    .replace("已自动整理较早上下文", "上下文已自动压缩")
    .replace("已自动压缩上下文", "上下文已自动压缩");
}

function normalizeMessagePartsForDisplay(message: AgentMessageRecord): MessagePart[] {
  if (message.role !== "system") {
    return message.parts;
  }

  return message.parts.map((part) =>
    part.type === "text" ? { ...part, value: normalizeSummaryStatusText(part.value) } : part
  );
}

function getMessageText(parts: MessagePart[]) {
  return parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.value.trim())
    .filter(Boolean)
    .join("\n");
}

function isSummarySystemMessage(message: ChatMessage) {
  if (message.role !== "system") {
    return false;
  }

  const text = getMessageText(message.parts);

  return text.includes("上下文") && (text.includes("压缩") || text.includes("整理"));
}

function shouldShowSummarySystemMessage(
  message: ChatMessage,
  options: { showRunningSummary?: boolean }
) {
  if (!isSummarySystemMessage(message)) {
    return true;
  }

  if (message.status === "completed") {
    return true;
  }

  return Boolean(options.showRunningSummary && message.status === "running");
}

export function normalizeVisibleMessages(
  messages: ChatMessage[],
  options: { showRunningSummary?: boolean } = {}
): ChatMessage[] {
  // system 消息主要承载“上下文压缩中/已压缩”这类状态。
  // 聊天窗口只保留最新一条已完成摘要提示，避免历史里堆一长串系统提示影响阅读。
  const latestSummarySystemMessageId = [...messages]
    .reverse()
    .find(
      (message) =>
        shouldShowSummarySystemMessage(message, options) && isSummarySystemMessage(message)
    )?.id;

  return messages.filter((message) => {
    if (!shouldShowSummarySystemMessage(message, options)) {
      return false;
    }

    return !isSummarySystemMessage(message) || message.id === latestSummarySystemMessageId;
  });
}

function groupProcessStepsByMessage(processSteps: AgentProcessStepRecord[] = []) {
  const stepsByMessage = new Map<string, AgentProcessStepRecord[]>();

  for (const step of processSteps) {
    stepsByMessage.set(step.messageId, [...(stepsByMessage.get(step.messageId) ?? []), step]);
  }

  return stepsByMessage;
}

export function sortProcessSteps(processSteps: AgentProcessStepRecord[] = []) {
  return [...processSteps].sort(
    (leftStep, rightStep) =>
      leftStep.orderIndex - rightStep.orderIndex ||
      leftStep.startedAt.localeCompare(rightStep.startedAt)
  );
}

export function upsertProcessStep(
  processSteps: AgentProcessStepRecord[] = [],
  step: AgentProcessStepRecord
): AgentProcessStepRecord[] {
  const withoutStep = processSteps.filter((candidate) => candidate.id !== step.id);
  return sortProcessSteps([...withoutStep, step]);
}

export function buildMessagesFromRecords(
  messages: AgentMessageRecord[],
  processSteps: AgentProcessStepRecord[] = []
): ChatMessage[] {
  const stepsByMessage = groupProcessStepsByMessage(processSteps);
  const chatMessages = [...messages]
    .sort((leftMessage, rightMessage) =>
      leftMessage.createdAt.localeCompare(rightMessage.createdAt)
    )
    .map((message) =>
      createMessageFromRecord(message, {
        processSteps: sortProcessSteps(stepsByMessage.get(message.id))
      })
    );

  return normalizeVisibleMessages(chatMessages);
}

export function prependMessagesFromRecords(
  currentMessages: ChatMessage[],
  olderMessages: AgentMessageRecord[],
  processSteps: AgentProcessStepRecord[] = []
): ChatMessage[] {
  const prependedMessages = buildMessagesFromRecords(olderMessages, processSteps);
  const prependedIds = new Set(prependedMessages.map((message) => message.id));

  return normalizeVisibleMessages(
    [
      ...prependedMessages,
      ...currentMessages.filter((message) => !prependedIds.has(message.id))
    ],
    { showRunningSummary: true }
  );
}

function replaceMessage(
  currentMessages: ChatMessage[],
  nextMessage: ChatMessage
): ChatMessage[] {
  const exists = currentMessages.some((message) => message.id === nextMessage.id);

  if (!exists) {
    const nextCreatedAt = nextMessage.createdAt;
    if (nextCreatedAt) {
      const insertIndex = currentMessages.findIndex((message) =>
        message.createdAt ? message.createdAt.localeCompare(nextCreatedAt) > 0 : false
      );
      if (insertIndex !== -1) {
        return [
          ...currentMessages.slice(0, insertIndex),
          nextMessage,
          ...currentMessages.slice(insertIndex)
        ];
      }
    }
    return [...currentMessages, nextMessage];
  }

  return currentMessages.map((message) =>
    message.id === nextMessage.id ? nextMessage : message
  );
}

export function upsertMessageRecord(
  currentMessages: ChatMessage[],
  message: AgentMessageRecord,
  options: { version?: number } = {}
): ChatMessage[] {
  const existingMessage = currentMessages.find(
    (currentMessage) => currentMessage.id === message.id
  );
  const version = options.version ?? existingMessage?.version;

  return normalizeVisibleMessages(
    replaceMessage(
      currentMessages,
      createMessageFromRecord(message, {
        version,
        processSteps: existingMessage?.processSteps
      })
    ),
    { showRunningSummary: true }
  );
}

export function upsertMessageSnapshot(
  currentMessages: ChatMessage[],
  event: Extract<AgentStreamEvent, { type: "message.snapshot" }>
): ChatMessage[] {
  const existingMessage = currentMessages.find(
    (message) => message.id === event.message.id
  );

  // snapshot 是后端给前端的“消息当前完整状态”，常用于重连后校准。
  // 如果本地已经收到更高版本的 part 事件，就不要被旧 snapshot 覆盖。
  if (isOlderSnapshotVersion(existingMessage, event.version)) {
    return currentMessages;
  }

  return normalizeVisibleMessages(
    replaceMessage(
      currentMessages,
      createMessageFromRecord(event.message, {
        version: event.version,
        processSteps: sortProcessSteps(event.processSteps)
      })
    ),
    { showRunningSummary: true }
  );
}

function isOlderSnapshotVersion(
  message: ChatMessage | undefined,
  eventVersion: number | undefined
) {
  return (
    typeof eventVersion === "number" &&
    typeof message?.version === "number" &&
    eventVersion < message.version
  );
}

export function markRunMessagesCancelled(
  currentMessages: ChatMessage[],
  run: AgentRunRecord
): ChatMessage[] {
  const cancelledMessageIds = new Set(
    [run.assistantMessageId, run.systemMessageId].filter(
      (messageId): messageId is string => Boolean(messageId)
    )
  );

  if (cancelledMessageIds.size === 0) {
    return currentMessages;
  }

  return normalizeVisibleMessages(
    currentMessages.flatMap((message) => {
      if (!cancelledMessageIds.has(message.id) || message.status !== "running") {
        return [message];
      }

      if (message.role === "system") {
        return [];
      }

      return [
        {
          ...message,
          status: "cancelled" as const,
          error: undefined,
          parts: message.parts
        }
      ];
    }),
    { showRunningSummary: true }
  );
}

export function appendStartedMessages(
  currentMessages: ChatMessage[],
  userMessage: AgentMessageRecord
): ChatMessage[] {
  const nextMessages = [createMessageFromRecord(userMessage)];
  const nextIds = new Set(nextMessages.map((message) => message.id));

  return [
    ...currentMessages.filter((message) => !nextIds.has(message.id)),
    ...nextMessages
  ];
}
