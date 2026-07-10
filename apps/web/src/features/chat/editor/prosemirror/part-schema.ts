import { Schema } from "prosemirror-model";

export const partSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0]
    },
    text: { group: "inline" },
    hard_break: {
      inline: true,
      group: "inline",
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"]
    },
    resource_part: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: {
        mime: { default: "" },
        url: { default: "" },
        name: { default: "" },
        size: { default: null },
        width: { default: null },
        height: { default: null },
        extra: { default: null },
        uploading: { default: false },
        uploadId: { default: null }
      },
      parseDOM: [
        {
          tag: "span.pm-part--resource",
          getAttrs: (dom) => {
            const element = dom as HTMLElement;

            return {
              mime: element.dataset.mime ?? "",
              url: element.dataset.url ?? "",
              name: element.dataset.name ?? "",
              size: element.dataset.size ? Number(element.dataset.size) : null,
              width: element.dataset.width ? Number(element.dataset.width) : null,
              height: element.dataset.height ? Number(element.dataset.height) : null,
              extra: parseJsonDataAttribute(element.dataset.extra),
              uploading: element.dataset.uploading === "true",
              uploadId: element.dataset.uploadId ?? null
            };
          }
        }
      ],
      toDOM: (node) => {
        const isImage = isImageMime(node.attrs.mime);
        const isUploading = node.attrs.uploading === true;
        const resourceLabel = getResourceLabel(node.attrs.mime);
        const label = node.attrs.name || resourceLabel;
        const attrs: Record<string, string> = {
          class: `pm-part pm-part--resource${isUploading ? " is-uploading" : ""}`,
          contenteditable: "false",
          "data-mime": String(node.attrs.mime ?? ""),
          "data-url": String(node.attrs.url ?? ""),
          "data-name": String(node.attrs.name ?? ""),
          title: isUploading ? `正在上传${resourceLabel}` : isImage ? "点击替换图片" : `已引用${resourceLabel}`
        };

        if (node.attrs.size !== null && node.attrs.size !== undefined) {
          attrs["data-size"] = String(node.attrs.size);
        }
        if (node.attrs.width !== null && node.attrs.width !== undefined) {
          attrs["data-width"] = String(node.attrs.width);
        }
        if (node.attrs.height !== null && node.attrs.height !== undefined) {
          attrs["data-height"] = String(node.attrs.height);
        }
        if (node.attrs.extra !== null && node.attrs.extra !== undefined) {
          attrs["data-extra"] = JSON.stringify(node.attrs.extra);
        }
        if (isUploading) {
          attrs["data-uploading"] = "true";
        }
        if (node.attrs.uploadId !== null && node.attrs.uploadId !== undefined) {
          attrs["data-upload-id"] = String(node.attrs.uploadId);
        }

        const leadingNode = isUploading
          ? ["span", { class: "pm-part-resource-spinner", "aria-hidden": "true" }]
          : node.attrs.url && isImage
            ? ["img", { class: "pm-part-resource-thumb", src: node.attrs.url, alt: label, draggable: "false" }]
            : ["span", { class: "pm-part-resource-placeholder" }, resourceLabel];
        const nameNode = ["span", { class: "pm-part-resource-name" }, label];

        if (isUploading) {
          return ["span", attrs, leadingNode, nameNode];
        }

        return [
          "span",
          attrs,
          leadingNode,
          nameNode,
          [
            "button",
            {
              class: "pm-part-resource-remove",
              type: "button",
              title: `删除${resourceLabel}`,
              "aria-label": `删除${resourceLabel} ${label}`,
              contenteditable: "false",
              tabindex: "-1"
            },
            "×"
          ]
        ];
      }
    }
  }
});

function parseJsonDataAttribute(value?: string) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isVideoMime(value: unknown) {
  return typeof value === "string" && value.startsWith("video/");
}

function isImageMime(value: unknown) {
  return typeof value === "string" && value.startsWith("image/");
}

function isDocumentMime(value: unknown) {
  return (
    typeof value === "string" &&
    (value.startsWith("text/") ||
      value === "application/markdown" ||
      value === "application/pdf" ||
      value === "application/msword" ||
      value === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  );
}

function getResourceLabel(mime: unknown) {
  if (isVideoMime(mime)) {
    return "视频";
  }

  if (isDocumentMime(mime)) {
    return "文档";
  }

  return "图片";
}
