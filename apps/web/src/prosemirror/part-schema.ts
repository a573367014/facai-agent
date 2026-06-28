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
        name: { default: "" }
      },
      parseDOM: [
        {
          tag: "span.pm-part--media",
          getAttrs: (dom) => {
            const element = dom as HTMLElement;

            return {
              mime: element.dataset.mime ?? "",
              url: element.dataset.url ?? "",
              name: element.dataset.name ?? ""
            };
          }
        }
      ],
      toDOM: (node) => [
        "span",
        {
          class: "pm-part pm-part--media",
          "data-mime": node.attrs.mime,
          "data-url": node.attrs.url,
          "data-name": node.attrs.name
        },
        node.attrs.name || node.attrs.url || "媒体"
      ]
    }
  }
});
