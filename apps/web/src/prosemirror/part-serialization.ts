import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { Selection } from "prosemirror-state";
import type { MessagePart } from "../api/agent-client";
import { partSchema } from "./part-schema";

export type RuntimePart = MessagePart | (MessagePart & Record<`$${string}`, unknown>);

export function stripRuntimeFields(parts: RuntimePart[]): MessagePart[] {
  // RuntimePart 允许前端临时挂 $xxx 字段，但发请求/比较内容时必须去掉。
  // 后端只认识稳定的 MessagePart，避免 UI 状态污染持久化数据。
  return parts.map((part) => Object.fromEntries(Object.entries(part).filter(([key]) => !key.startsWith("$"))) as MessagePart);
}

export function partsToDoc(parts: RuntimePart[]): ProseMirrorNode {
  // MessagePart 是业务数据，ProseMirror doc 是编辑器内部数据。
  // 文本会拆成 inline text/hard_break，资源会变成不可拆分的 resource_part atom。
  const inlineNodes = parts.flatMap((part) => {
    if (part.type === "text") {
      return textToInlineNodes(part.value);
    }

    return [
      partSchema.nodes.resource_part.create({
        mime: part.mime,
        url: part.url,
        name: part.name ?? "",
        size: part.size ?? null,
        width: part.width ?? null,
        height: part.height ?? null,
        extra: part.extra ?? null,
        uploading: getRuntimeBoolean(part, "$uploading"),
        uploadId: getRuntimeString(part, "$uploadId")
      })
    ];
  });

  return partSchema.nodes.doc.create(null, [partSchema.nodes.paragraph.create(null, inlineNodes)]);
}

export function docToParts(doc: ProseMirrorNode): MessagePart[] {
  const parts: MessagePart[] = [];
  let textBuffer = "";

  function flushText() {
    // 连续文本先攒在 textBuffer 里，遇到资源再 flush。
    // 这样 “文字 + 图片 + 文字” 会变成三个 part，而不是每个字符一个 part。
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

    if (node.type.name === "resource_part") {
      flushText();
      parts.push({
        type: "resource",
        mime: String(node.attrs.mime ?? ""),
        url: String(node.attrs.url ?? ""),
        ...(node.attrs.name ? { name: String(node.attrs.name) } : {}),
        ...(typeof node.attrs.size === "number" ? { size: node.attrs.size } : {}),
        ...(typeof node.attrs.width === "number" ? { width: node.attrs.width } : {}),
        ...(typeof node.attrs.height === "number" ? { height: node.attrs.height } : {}),
        ...(isPartExtra(node.attrs.extra) ? { extra: node.attrs.extra } : {}),
        ...(node.attrs.uploading === true ? { $uploading: true } : {}),
        ...(typeof node.attrs.uploadId === "string" ? { $uploadId: node.attrs.uploadId } : {})
      });
      return false;
    }

    return true;
  });

  flushText();
  return parts;
}

export function getSelectedParts(doc: ProseMirrorNode, selection: Selection): MessagePart[] | undefined {
  if (selection.empty) {
    return undefined;
  }

  // 复制/复用用户消息时，不一定取整条消息。
  // 这里把当前选区投影回 MessagePart，选中资源时会保留结构，选中文本时保留换行。
  const parts: MessagePart[] = [];
  let textBuffer = "";

  function flushText() {
    if (textBuffer) {
      parts.push({ type: "text", value: textBuffer });
      textBuffer = "";
    }
  }

  doc.nodesBetween(selection.from, selection.to, (node, position) => {
    if (node.isText) {
      const from = Math.max(selection.from, position);
      const to = Math.min(selection.to, position + node.nodeSize);
      const selectedText = (node.text ?? "").slice(from - position, to - position);

      if (selectedText) {
        textBuffer += selectedText;
      }

      return false;
    }

    if (node.type.name === "hard_break") {
      const nodeTo = position + node.nodeSize;

      if (selection.from < nodeTo && selection.to > position) {
        textBuffer += "\n";
      }

      return false;
    }

    if (node.type.name === "resource_part") {
      const nodeTo = position + node.nodeSize;

      if (selection.from < nodeTo && selection.to > position) {
        flushText();
        parts.push(resourceNodeToPart(node));
      }

      return false;
    }

    return true;
  });

  flushText();
  return parts.length > 0 ? parts : undefined;
}

function resourceNodeToPart(node: ProseMirrorNode): MessagePart {
  return {
    type: "resource",
    mime: String(node.attrs.mime ?? ""),
    url: String(node.attrs.url ?? ""),
    ...(node.attrs.name ? { name: String(node.attrs.name) } : {}),
    ...(typeof node.attrs.size === "number" ? { size: node.attrs.size } : {}),
    ...(typeof node.attrs.width === "number" ? { width: node.attrs.width } : {}),
    ...(typeof node.attrs.height === "number" ? { height: node.attrs.height } : {}),
    ...(isPartExtra(node.attrs.extra) ? { extra: node.attrs.extra } : {}),
    ...(node.attrs.uploading === true ? { $uploading: true } : {}),
    ...(typeof node.attrs.uploadId === "string" ? { $uploadId: node.attrs.uploadId } : {})
  };
}

function isPartExtra(value: unknown): value is NonNullable<MessagePart["extra"]> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRuntimeBoolean(part: RuntimePart, key: `$${string}`) {
  const value = (part as Record<`$${string}`, unknown>)[key];
  return value === true;
}

function getRuntimeString(part: RuntimePart, key: `$${string}`) {
  const value = (part as Record<`$${string}`, unknown>)[key];
  return typeof value === "string" ? value : null;
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
