import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { MessagePart } from "../api/agent-client";
import { partSchema } from "./part-schema";

export type RuntimePart = MessagePart & Record<`$${string}`, unknown>;

export function stripRuntimeFields(parts: RuntimePart[]): MessagePart[] {
  return parts.map((part) => Object.fromEntries(Object.entries(part).filter(([key]) => !key.startsWith("$"))) as MessagePart);
}

export function partsToDoc(parts: RuntimePart[]): ProseMirrorNode {
  const inlineNodes = parts.flatMap((part) => {
    if (part.type === "text") {
      return textToInlineNodes(part.value);
    }

    return [
      partSchema.nodes.media_part.create({
        mime: part.mime,
        url: part.url,
        name: part.name ?? ""
      })
    ];
  });

  return partSchema.nodes.doc.create(null, [partSchema.nodes.paragraph.create(null, inlineNodes)]);
}

export function docToParts(doc: ProseMirrorNode): MessagePart[] {
  const parts: MessagePart[] = [];
  let textBuffer = "";

  function flushText() {
    if (textBuffer) {
      parts.push({ type: "text", value: textBuffer });
      textBuffer = "";
    }
  }

  doc.descendants((node) => {
    if (node.isText) {
      textBuffer += node.text ?? "";
      return false;
    }

    if (node.type.name === "hard_break") {
      textBuffer += "\n";
      return false;
    }

    if (node.type.name === "media_part") {
      flushText();
      parts.push({
        type: "media",
        mime: String(node.attrs.mime ?? ""),
        url: String(node.attrs.url ?? ""),
        ...(node.attrs.name ? { name: String(node.attrs.name) } : {})
      });
      return false;
    }

    return true;
  });

  flushText();
  return parts;
}

function textToInlineNodes(value: string): ProseMirrorNode[] {
  return value.split("\n").flatMap((line, index) => {
    const nodes: ProseMirrorNode[] = [];

    if (index > 0) {
      nodes.push(partSchema.nodes.hard_break.create());
    }

    if (line) {
      nodes.push(partSchema.text(line));
    }

    return nodes;
  });
}
