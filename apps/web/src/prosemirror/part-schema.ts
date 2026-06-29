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
    media_part: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: {
        mime: { default: "" },
        url: { default: "" },
        name: { default: "" },
        size: { default: null }
      },
      parseDOM: [
        {
          tag: "span.pm-part--media",
          getAttrs: (dom) => {
            const element = dom as HTMLElement;

            return {
              mime: element.dataset.mime ?? "",
              url: element.dataset.url ?? "",
              name: element.dataset.name ?? "",
              size: element.dataset.size ? Number(element.dataset.size) : null
            };
          }
        }
      ],
      toDOM: (node) => {
        const label = node.attrs.name || "图片";
        const attrs: Record<string, string> = {
          class: "pm-part pm-part--media",
          contenteditable: "false",
          "data-mime": String(node.attrs.mime ?? ""),
          "data-url": String(node.attrs.url ?? ""),
          "data-name": String(node.attrs.name ?? ""),
          title: "点击替换图片"
        };

        if (node.attrs.size !== null && node.attrs.size !== undefined) {
          attrs["data-size"] = String(node.attrs.size);
        }

        return [
          "span",
          attrs,
          node.attrs.url
            ? ["img", { class: "pm-part-media-thumb", src: node.attrs.url, alt: label, draggable: "false" }]
            : ["span", { class: "pm-part-media-placeholder" }, "图片"],
          ["span", { class: "pm-part-media-name" }, label],
          [
            "button",
            {
              class: "pm-part-media-remove",
              type: "button",
              title: "删除图片",
              "aria-label": `删除图片 ${label}`,
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
