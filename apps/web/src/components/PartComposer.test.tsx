import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartComposer } from "./PartComposer";

const stylesPath = join(process.cwd(), "src/styles.css");

afterEach(() => {
  cleanup();
});

describe("PartComposer", () => {
  it("changes text through ProseMirror and submits on Enter", async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();

    render(
      <PartComposer
        parts={[{ type: "text", value: "" }]}
        onCancel={vi.fn()}
        onChange={onChange}
        onSubmit={onSubmit}
      />
    );

    const textbox = screen.getByRole("textbox", { name: "发消息" });
    await userEvent.click(textbox);
    await userEvent.keyboard("你好");
    await userEvent.keyboard("{Enter}");

    expect(onChange).toHaveBeenLastCalledWith([{ type: "text", value: "你好" }]);
    expect(onSubmit).toHaveBeenCalled();
  });

  it("inserts a newline on Shift+Enter", async () => {
    const onChange = vi.fn();

    render(
      <PartComposer
        parts={[{ type: "text", value: "" }]}
        onCancel={vi.fn()}
        onChange={onChange}
        onSubmit={vi.fn()}
      />
    );

    const textbox = screen.getByRole("textbox", { name: "发消息" });
    await userEvent.click(textbox);
    await userEvent.keyboard("第一行{Shift>}{Enter}{/Shift}第二行");

    expect(onChange).toHaveBeenLastCalledWith([{ type: "text", value: "第一行\n第二行" }]);
  });

  it("粘贴图片后会在当前光标位置插入 media part", async () => {
    const onChange = vi.fn();
    const onUploadImage = vi.fn().mockResolvedValue({
      type: "media",
      mime: "image/png",
      url: "http://localhost:4001/uploads/images/paste.png",
      name: "paste.png"
    });

    render(
      <PartComposer
        parts={[{ type: "text", value: "前后" }]}
        onCancel={vi.fn()}
        onChange={onChange}
        onSubmit={vi.fn()}
        onUploadImage={onUploadImage}
      />
    );

    const textbox = screen.getByRole("textbox", { name: "发消息" });
    await userEvent.click(textbox);
    const textNode = textbox.querySelector("p")?.firstChild;
    if (!textNode) {
      throw new Error("未找到编辑器文本节点");
    }
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    fireEvent.paste(textbox, {
      clipboardData: {
        files: [new File(["image"], "paste.png", { type: "image/png" })],
        getData: () => ""
      }
    });

    await waitFor(() => {
      expect(onUploadImage).toHaveBeenCalledWith(expect.objectContaining({ name: "paste.png", type: "image/png" }));
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith([
        { type: "text", value: "前" },
        {
          type: "media",
          mime: "image/png",
          url: "http://localhost:4001/uploads/images/paste.png",
          name: "paste.png"
        },
        { type: "text", value: "后" }
      ]);
    });
  });

  it("点击已有图片 part 后重新上传会替换原 part", async () => {
    const onChange = vi.fn();
    const onUploadImage = vi.fn().mockResolvedValue({
      type: "media",
      mime: "image/png",
      url: "http://localhost:4001/uploads/images/new.png",
      name: "new.png"
    });

    render(
      <PartComposer
        parts={[
          { type: "text", value: "看" },
          { type: "media", mime: "image/png", url: "http://localhost:4001/uploads/images/old.png", name: "old.png" },
          { type: "text", value: "这张" }
        ]}
        onCancel={vi.fn()}
        onChange={onChange}
        onSubmit={vi.fn()}
        onUploadImage={onUploadImage}
      />
    );

    await userEvent.click(screen.getByText("old.png"));
    await userEvent.upload(screen.getByLabelText("选择图片"), new File(["image"], "new.png", { type: "image/png" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith([
        { type: "text", value: "看" },
        {
          type: "media",
          mime: "image/png",
          url: "http://localhost:4001/uploads/images/new.png",
          name: "new.png"
        },
        { type: "text", value: "这张" }
      ]);
    });
  });

  it("全选后点击 media part 会先清除范围选中态", async () => {
    render(
      <PartComposer
        parts={[
          { type: "text", value: "看" },
          { type: "media", mime: "image/png", url: "http://localhost:4001/uploads/images/old.png", name: "old.png" },
          { type: "text", value: "这张" }
        ]}
        onCancel={vi.fn()}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onUploadImage={vi.fn()}
      />
    );

    const textbox = screen.getByRole("textbox", { name: "发消息" });
    await userEvent.click(textbox);
    await userEvent.keyboard("{Control>}a{/Control}");

    const mediaPart = screen.getByText("old.png").closest(".pm-part--media");
    expect(mediaPart).toBeInstanceOf(HTMLElement);

    await waitFor(() => {
      expect(mediaPart).toHaveClass("is-range-selected");
    });

    await userEvent.click(screen.getByText("old.png"));

    await waitFor(() => {
      expect(mediaPart).not.toHaveClass("is-range-selected");
    });
  });

  it("全选后点击输入框外部会清除 media part 选中态", async () => {
    render(
      <>
        <button type="button">外部区域</button>
        <PartComposer
          parts={[
            { type: "text", value: "看" },
            { type: "media", mime: "image/png", url: "http://localhost:4001/uploads/images/old.png", name: "old.png" },
            { type: "text", value: "这张" }
          ]}
          onCancel={vi.fn()}
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          onUploadImage={vi.fn()}
        />
      </>
    );

    const textbox = screen.getByRole("textbox", { name: "发消息" });
    await userEvent.click(textbox);
    await userEvent.keyboard("{Control>}a{/Control}");

    const mediaPart = screen.getByText("old.png").closest(".pm-part--media");
    expect(mediaPart).toBeInstanceOf(HTMLElement);

    await waitFor(() => {
      expect(mediaPart).toHaveClass("is-range-selected");
    });

    await userEvent.click(screen.getByRole("button", { name: "外部区域" }));

    await waitFor(() => {
      expect(mediaPart).not.toHaveClass("is-range-selected");
    });
  });

  it("点击 media part 删除按钮会移除当前 part 并保留周围文本", async () => {
    const onChange = vi.fn();
    const onUploadImage = vi.fn();

    render(
      <PartComposer
        parts={[
          { type: "text", value: "看" },
          { type: "media", mime: "image/png", url: "http://localhost:4001/uploads/images/old.png", name: "old.png" },
          { type: "text", value: "这张" }
        ]}
        onCancel={vi.fn()}
        onChange={onChange}
        onSubmit={vi.fn()}
        onUploadImage={onUploadImage}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "删除图片 old.png" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith([{ type: "text", value: "看这张" }]);
    });
    expect(onUploadImage).not.toHaveBeenCalled();
  });

  it("视频 media part 在输入框里显示为视频占位，不把 mp4 当图片缩略图", () => {
    const { container } = render(
      <PartComposer
        parts={[
          {
            type: "media",
            mime: "video/mp4",
            url: "http://localhost:4001/uploads/resources/videos/demo.mp4",
            name: "节日主图动态视频"
          }
        ]}
        onCancel={vi.fn()}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const mediaPart = screen.getByText("节日主图动态视频").closest(".pm-part--media");
    expect(mediaPart).toBeInstanceOf(HTMLElement);
    expect(mediaPart).toHaveTextContent("视频");
    expect(mediaPart).toHaveAttribute("data-mime", "video/mp4");
    expect(container.querySelector('img.pm-part-media-thumb[src$=".mp4"]')).toBeNull();
  });

  it("点击视频 media part 不会打开图片选择器", async () => {
    render(
      <PartComposer
        parts={[
          {
            type: "media",
            mime: "video/mp4",
            url: "http://localhost:4001/uploads/resources/videos/demo.mp4",
            name: "节日主图动态视频"
          }
        ]}
        onCancel={vi.fn()}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onUploadImage={vi.fn()}
      />
    );

    const imageInput = screen.getByLabelText("选择图片") as HTMLInputElement;
    const inputClick = vi.spyOn(imageInput, "click");

    await userEvent.click(screen.getByText("节日主图动态视频"));

    expect(inputClick).not.toHaveBeenCalled();
  });

  it("media part 不使用外部 margin，并让拖选态和文本选区颜色一致", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).toMatch(/\.pm-part--media\s*{[^}]*margin:\s*0;/s);
    expect(styles).toMatch(/\.pm-part--media\s*{[^}]*max-width:\s*min\(176px,\s*100%\);/s);
    expect(styles).toMatch(/\.pm-part-media-name\s*{[^}]*max-width:\s*118px;/s);
    expect(styles).toMatch(/\.pm-part--media\s*{[^}]*height:\s*var\(--part-composer-line-height\);/s);
    expect(styles).toMatch(/\.pm-part--media\s*{[^}]*padding:\s*0\s+[^;]+;/s);
    expect(styles).not.toMatch(/\.pm-part--media\s*{[^}]*margin-right:/s);
    expect(styles).not.toMatch(/\.pm-part--media\s*{[^}]*user-select:\s*none;/s);
    expect(styles).toMatch(/\.pm-part-media-remove\s*{[^}]*width:\s*18px;[^}]*height:\s*18px;/s);
    expect(styles).toMatch(/\.pm-part-media-remove:hover\s*{[^}]*background:\s*var\(--eye-primary\);/s);
    expect(styles).toMatch(/\.pm-part--media\.ProseMirror-selectednode\s*{[^}]*box-shadow:/s);
    expect(styles).toMatch(/\.part-composer-editor\s*{[^}]*--part-composer-selection-background:\s*#[0-9a-fA-F]{6};/s);
    expect(styles).toMatch(
      /\.part-composer-editor::selection,\s*\.part-composer-editor \*::selection\s*{[^}]*background:\s*var\(--part-composer-selection-background\);/s
    );
    expect(styles).toMatch(
      /\.pm-part--media\.is-range-selected\s*{[^}]*background:\s*var\(--part-composer-selection-background\);[^}]*color:\s*var\(--part-composer-selection-color\);/s
    );
    expect(styles).toMatch(
      /\.pm-part--media\.is-range-selected\s*{[^}]*height:\s*var\(--part-composer-line-height\);[^}]*border-radius:\s*0;/s
    );
  });
});
