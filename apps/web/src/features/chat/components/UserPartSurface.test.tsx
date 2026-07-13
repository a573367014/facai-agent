import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { UserPartSurface, type UserPartSurfaceHandle } from "./UserPartSurface";
import { readAppStyles } from "@/test/read-app-styles";


function createParts() {
  return [
    { type: "text" as const, value: "看这个 " },
    { type: "resource" as const, mime: "image/png", url: "https://example.com/image.png", name: "image.png" },
    { type: "text" as const, value: " 继续" }
  ];
}

afterEach(() => {
  cleanup();
});

describe("UserPartSurface", () => {
  it("readonly resource part 点击后打开预览，但不会进入 ProseMirror 选中态", async () => {
    const { container } = render(
      <UserPartSurface
        parts={[
          { type: "text", value: "看这个 " },
          { type: "resource", mime: "image/png", url: "https://example.com/image.png", name: "image.png" }
        ]}
      />
    );

    const editor = container.querySelector(".user-part-surface-editor");
    const resourcePart = screen.getByText("image.png").closest(".pm-part--resource");
    expect(editor).toBeInstanceOf(HTMLElement);
    expect(resourcePart).toBeInstanceOf(HTMLElement);

    await userEvent.click(resourcePart as HTMLElement);

    expect(editor).not.toHaveFocus();
    expect(resourcePart).not.toHaveClass("ProseMirror-selectednode");
    expect(resourcePart).not.toHaveClass("is-range-selected");
    expect(screen.getByRole("dialog", { name: "图片预览" })).toBeInTheDocument();
  });

  it("readonly resource part 暴露预览入口，但不暴露替换动作", () => {
    render(
      <UserPartSurface
        parts={[
          { type: "text", value: "看这个 " },
          { type: "resource", mime: "image/png", url: "https://example.com/image.png", name: "image.png" }
        ]}
      />
    );
    const styles = readAppStyles();
    const resourcePart = screen.getByText("image.png").closest(".pm-part--resource");

    expect(resourcePart).toHaveAttribute("title", "预览图片");
    expect(resourcePart).not.toHaveAttribute("title", "点击替换图片");
    expect(styles).toMatch(/\.user-part-surface-editor\s+\.pm-part--resource,\s*\.user-part-surface-editor\s+\.pm-part--resource:hover\s*{[^}]*cursor:\s*pointer;/s);
  });

  it("拖选经过 readonly resource part 后不会被后续 click 事件清掉", () => {
    const { container } = render(<UserPartSurface parts={createParts()} />);
    const editor = container.querySelector(".user-part-surface-editor");
    const textParts = editor?.querySelectorAll("[data-user-part-kind='text']");
    const firstTextNode = textParts?.[0]?.firstChild;
    const resourcePart = screen.getByText("image.png").closest(".pm-part--resource");
    const lastTextNode = textParts?.[1]?.firstChild;

    expect(editor).toBeInstanceOf(HTMLElement);
    expect(firstTextNode).toBeInstanceOf(Text);
    expect(resourcePart).toBeInstanceOf(HTMLElement);
    expect(lastTextNode).toBeInstanceOf(Text);

    const firstText = firstTextNode as Text;
    const lastText = lastTextNode as Text;
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.setEnd(lastText, (lastText.textContent ?? "").length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));

    expect(selection?.isCollapsed).toBe(false);
    expect(resourcePart).toHaveClass("is-range-selected");

    fireEvent.click(resourcePart as HTMLElement);

    expect(document.getSelection()?.isCollapsed).toBe(false);
    expect(resourcePart).toHaveClass("is-range-selected");
  });

  it("用户气泡不使用 ProseMirror 接管原生框选", () => {
    const { container } = render(<UserPartSurface parts={createParts()} />);

    expect(container.querySelector(".ProseMirror")).toBeNull();
  });

  it("从用户气泡原生 DOM 选区提取 text 和 resource parts", () => {
    const surfaceRef = createRef<UserPartSurfaceHandle>();
    const { container } = render(<UserPartSurface ref={surfaceRef} parts={createParts()} />);
    const editor = container.querySelector(".user-part-surface-editor");
    const textParts = editor?.querySelectorAll("[data-user-part-kind='text']");
    const firstTextNode = textParts?.[0]?.firstChild;
    const resourcePart = screen.getByText("image.png").closest(".pm-part--resource");
    const lastTextNode = textParts?.[1]?.firstChild;

    expect(firstTextNode).toBeInstanceOf(Text);
    expect(resourcePart).toBeInstanceOf(HTMLElement);
    expect(lastTextNode).toBeInstanceOf(Text);

    const range = document.createRange();
    range.setStart(firstTextNode as Text, 1);
    range.setEnd(lastTextNode as Text, 2);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));

    expect(surfaceRef.current?.getSelectedParts()).toEqual([
      { type: "text", value: "这个 " },
      { type: "resource", mime: "image/png", url: "https://example.com/image.png", name: "image.png" },
      { type: "text", value: " 继" }
    ]);
  });

  it("复制用户气泡选区时不会把 resource 文件名写进 plain text", () => {
    const { container } = render(<UserPartSurface parts={createParts()} />);
    const editor = container.querySelector(".user-part-surface-editor");
    const textParts = editor?.querySelectorAll("[data-user-part-kind='text']");
    const firstTextNode = textParts?.[0]?.firstChild;
    const resourcePart = screen.getByText("image.png").closest(".pm-part--resource");
    const lastTextNode = textParts?.[1]?.firstChild;
    const clipboardValues = new Map<string, string>();
    const clipboardData = {
      setData: (type: string, value: string) => {
        clipboardValues.set(type, value);
      }
    };

    expect(editor).toBeInstanceOf(HTMLElement);
    expect(firstTextNode).toBeInstanceOf(Text);
    expect(resourcePart).toBeInstanceOf(HTMLElement);
    expect(lastTextNode).toBeInstanceOf(Text);

    const firstText = firstTextNode as Text;
    const lastText = lastTextNode as Text;
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.setEnd(lastText, (lastText.textContent ?? "").length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.copy(editor as HTMLElement, { clipboardData });

    expect(clipboardValues.get("text/plain")).toBe("看这个  继续");
    expect(clipboardValues.get("text/plain")).not.toContain("image.png");
    expect(clipboardValues.get("application/x-agent-message-parts")).toContain("\"type\":\"resource\"");
  });
});
