import type { MessagePart } from "../api/agent-client";

export const AGENT_MESSAGE_PARTS_MIME = "application/x-agent-message-parts";

export function serializeMessagePartsForClipboard(parts: MessagePart[]) {
  return JSON.stringify(parts);
}

export function parseMessagePartsFromClipboard(value: string): MessagePart[] | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);

    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const parts = parsed.filter(isMessagePart);
    return parts.length > 0 ? parts : undefined;
  } catch {
    return undefined;
  }
}

export function messagePartsToPlainText(parts: MessagePart[]) {
  return parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.value)
    .join("");
}

function isMessagePart(value: unknown): value is MessagePart {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<MessagePart>;

  if (candidate.type === "text") {
    return typeof candidate.value === "string";
  }

  if (candidate.type === "resource") {
    return true;
  }

  return false;
}
