import type { AgentStreamEvent, MessagePart } from "@/features/chat/api/agent-types";
import type { ChatMessage } from "./chat-message";
import { upsertProcessStep } from "./message-projection";

function isDuplicateOrOlderPartVersion(message: ChatMessage, event: AgentStreamEvent) {
  if (
    event.type !== "message.part.created" &&
    event.type !== "message.part.delta" &&
    event.type !== "message.part.updated"
  ) {
    return false;
  }

  // part 事件可能因为重连回放而重复到达。
  // version 是消息级别的递增号，用它挡住重复/更旧事件，可以避免 delta 被追加两次。
  return (
    typeof event.version === "number" &&
    typeof message.version === "number" &&
    event.version <= message.version
  );
}

function compactMessageParts(parts: Array<MessagePart | undefined> = []): MessagePart[] {
  // SSE 事件乱序或缺少前置 part 时，直接 parts[1] = xxx 会制造“空洞数组”。
  // React 渲染和 final_answer 都会遍历 parts，所以进入核心逻辑前先压成真正连续的数组。
  return parts.filter((part): part is MessagePart => Boolean(part));
}

function createEmptyTextPart(): MessagePart {
  return { type: "text", value: "" };
}

function normalizePartIndex(partIndex: number) {
  return Number.isInteger(partIndex) && partIndex >= 0 ? partIndex : 0;
}

function padMissingPartsBeforeIndex(
  parts: MessagePart[] = [],
  partIndex: number
): MessagePart[] {
  const safePartIndex = normalizePartIndex(partIndex);
  const nextParts = compactMessageParts(parts);

  // 后端的 partIndex 是“最终消息里的位置”。
  // 比如视频 partIndex=1 先到，但文本 partIndex=0 还没到，前端先补一个空文本位；
  // 后面的 final_answer 或 message.part.updated 再把这个空位填成真正正文。
  while (nextParts.length < safePartIndex) {
    nextParts.push(createEmptyTextPart());
  }

  return nextParts;
}

function setTextPartValue(parts: MessagePart[] = [], value: string): MessagePart[] {
  const denseParts = compactMessageParts(parts);
  const textPartIndex = denseParts.findIndex((part) => part.type === "text");

  if (textPartIndex === -1) {
    return value ? [{ type: "text", value }, ...denseParts] : denseParts;
  }

  return denseParts.map((part, index) =>
    index === textPartIndex && part.type === "text" ? { ...part, value } : part
  );
}

export function applyPartEventToMessage(
  message: ChatMessage,
  event: AgentStreamEvent
): ChatMessage {
  // 后端不会每次都重发整条消息：流式文本用 delta，resource/占位用 created/updated。
  // 这个函数只负责把“一个 part 事件”折叠到当前 ChatMessage 上。
  if (event.type === "message.part.created") {
    const partIndex = normalizePartIndex(event.partIndex);
    const parts = padMissingPartsBeforeIndex(message.parts, partIndex);
    parts.splice(partIndex, 0, event.part);
    return { ...message, parts, version: event.version ?? message.version };
  }

  if (event.type === "message.part.delta") {
    const partIndex = normalizePartIndex(event.partIndex);
    const parts = padMissingPartsBeforeIndex(message.parts, partIndex);
    const targetPart = parts[partIndex];

    if (!targetPart) {
      parts[partIndex] = { type: "text", value: event.delta };
      return {
        ...message,
        version: event.version ?? message.version,
        parts
      };
    }

    if (targetPart.type !== "text") {
      parts.splice(partIndex, 0, { type: "text", value: event.delta });
      return {
        ...message,
        version: event.version ?? message.version,
        parts
      };
    }

    return {
      ...message,
      version: event.version ?? message.version,
      parts: parts.map((part, index) =>
        index === partIndex && part.type === "text"
          ? { ...part, value: part.value + event.delta }
          : part
      )
    };
  }

  if (event.type === "message.part.updated") {
    const partIndex = normalizePartIndex(event.partIndex);
    const parts = padMissingPartsBeforeIndex(message.parts, partIndex);

    if (!parts[partIndex]) {
      parts[partIndex] = event.part;
      return {
        ...message,
        version: event.version ?? message.version,
        parts
      };
    }

    return {
      ...message,
      version: event.version ?? message.version,
      parts: parts.map((part, index) => (index === partIndex ? event.part : part))
    };
  }

  return message;
}

export function createStreamingAssistantMessage(
  messageId: string,
  event: AgentStreamEvent,
  now: string
): ChatMessage {
  return {
    id: messageId,
    role: "assistant",
    parts: event.type === "message.part.created" ? [] : [{ type: "text", value: "" }],
    status: "running",
    processSteps: [],
    events: [],
    createdAt: now,
    updatedAt: now
  };
}

export function shouldCreateAssistantMessageForEvent(event: AgentStreamEvent) {
  return (
    event.type === "message.part.created" ||
    event.type === "message.part.delta" ||
    event.type === "message.part.updated" ||
    event.type === "final_answer"
  );
}

export function reduceMessageStreamEvent(
  message: ChatMessage,
  event: AgentStreamEvent
): ChatMessage {
  if (isDuplicateOrOlderPartVersion(message, event)) {
    return message;
  }

  const nextEvents = [...(message.events ?? []), event];

  if (event.type === "process.step.created" || event.type === "process.step.updated") {
    return {
      ...message,
      processSteps: upsertProcessStep(message.processSteps, event.step),
      events: nextEvents
    };
  }

  if (
    event.type === "message.part.created" ||
    event.type === "message.part.delta" ||
    event.type === "message.part.updated"
  ) {
    return {
      ...applyPartEventToMessage(message, event),
      events: nextEvents
    };
  }

  if (event.type === "final_answer") {
    return {
      ...message,
      parts: setTextPartValue(message.parts, event.answer),
      status: "completed",
      events: nextEvents,
      error: undefined
    };
  }

  if (event.type === "error") {
    return {
      ...message,
      status: "failed",
      events: nextEvents,
      error: `${event.code}: ${event.message}`
    };
  }

  if (event.type === "cancelled") {
    return {
      ...message,
      status: "cancelled",
      events: nextEvents,
      error: undefined
    };
  }

  return {
    ...message,
    status: message.status === "completed" ? "completed" : "running",
    events: nextEvents
  };
}

export function reduceAssistantMessageEvent(
  currentMessages: ChatMessage[],
  messageId: string,
  event: AgentStreamEvent,
  now: string
): ChatMessage[] {
  let didUpdate = false;
  const nextMessages = currentMessages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }

    didUpdate = true;
    return reduceMessageStreamEvent(message, event);
  });

  if (didUpdate || !shouldCreateAssistantMessageForEvent(event)) {
    return nextMessages;
  }

  return [
    ...currentMessages,
    reduceMessageStreamEvent(
      createStreamingAssistantMessage(messageId, event, now),
      event
    )
  ];
}
