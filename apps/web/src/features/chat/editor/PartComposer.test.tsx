import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartComposer } from "./PartComposer";
import { readAppStyles } from "@/test/read-app-styles";

const maxAttachmentBytes = 20 * 1024 * 1024;

function createFileWithSize(name: string, type: string, size: number) {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

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

  it("粘贴图片后会在当前光标位置插入 resource part", async () => {
    const onChange = vi.fn();
    const onUploadImage = vi.fn().mockResolvedValue({
      type: "resource",
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
          type: "resource",
          mime: "image/png",
          url: "http://localhost:4001/uploads/images/paste.png",
          name: "paste.png"
        },
        { type: "text", value: "后" }
      ]);
    });
  });

  it("拖拽文档后会上传并插入 resource part", async () => {
    const onChange = vi.fn();
    const onUploadDocument = vi.fn().mockResolvedValue({
      type: "resource",
      mime: "text/markdown",
      url: "http://localhost:4001/uploads/agent-documents/report.md",
      name: "report.md",
      size: 8,
      extra: {
        inputResource: {
          type: "document"
        }
      }
    });

    render(
      <PartComposer
        parts={[{ type: "text", value: "" }]}
        onCancel={vi.fn()}
        onChange={onChange}
        onSubmit={vi.fn()}
        onUploadDocument={onUploadDocument}
      />
    );

    const textbox = screen.getByRole("textbox", { name: "发消息" });
    fireEvent.drop(textbox, {
      dataTransfer: {
        files: [new File(["# report"], "report.md", { type: "text/markdown" })]
      }
    });

    await waitFor(() => {
      expect(onUploadDocument).toHaveBeenCalledWith(expect.objectContaining({ name: "report.md", type: "text/markdown" }));
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith([
        {
          type: "resource",
          mime: "text/markdown",
          url: "http://localhost:4001/uploads/agent-documents/report.md",
          name: "report.md",
          size: 8,
          extra: {
            inputResource: {
              type: "document"
            }
          }
        }
      ]);
    });
  });

  it("拖拽文档后立即显示上传中占位，成功后原地替换", async () => {
    const onChange = vi.fn();
    const deferred = createDeferred<Parameters<typeof PartComposer>[0]["parts"][number]>();
    const onUploadDocument = vi.fn().mockReturnValue(deferred.promise);

    render(
      <PartComposer
        parts={[{ type: "text", value: "" }]}
        onCancel={vi.fn()}
        onChange={onChange}
        onSubmit={vi.fn()}
        onUploadDocument={onUploadDocument}
      />
    );

    const textbox = screen.getByRole("textbox", { name: "发消息" });
    fireEvent.drop(textbox, {
      dataTransfer: {
        files: [new File(["# report"], "report.md", { type: "text/markdown" })]
      }
    });

    const uploadingPart = await screen.findByText("report.md");
    const uploadingResource = uploadingPart.closest(".pm-part--resource");
    expect(uploadingResource).toHaveClass("is-uploading");
    expect(uploadingResource?.querySelector(".pm-part-resource-spinner")).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        type: "resource",
        mime: "text/markdown",
        name: "report.md",
        size: 8,
        $uploading: true,
        $uploadId: expect.any(String)
      })
    ]);

    deferred.resolve({
      type: "resource",
      mime: "text/markdown",
      url: "http://localhost:4001/uploads/agent-documents/report.md",
      name: "report.md",
      size: 8
    });

    await waitFor(() => {
      expect(screen.getByText("report.md").closest(".pm-part--resource")).not.toHaveClass("is-uploading");
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith([
        {
          type: "resource",
          mime: "text/markdown",
          url: "http://localhost:4001/uploads/agent-documents/report.md",
          name: "report.md",
          size: 8
        }
      ]);
    });
  });

  it("上传中撤销后，上传完成再重做会续上真实资源", async () => {
    const onChange = vi.fn();
    const deferred = createDeferred<Parameters<typeof PartComposer>[0]["parts"][number]>();
    const onUploadDocument = vi.fn().mockReturnValue(deferred.promise);

    render(
      <PartComposer
        parts={[{ type: "text", value: "" }]}
        onCancel={vi.fn()}
        onChange={onChange}
        onSubmit={vi.fn()}
        onUploadDocument={onUploadDocument}
      />
    );

    const textbox = screen.getByRole("textbox", { name: "发消息" });
    fireEvent.drop(textbox, {
      dataTransfer: {
        files: [new File(["# report"], "report.md", { type: "text/markdown" })]
      }
    });

    expect(await screen.findByText("report.md")).toBeInTheDocument();

    fireEvent.keyDown(textbox, { key: "z", code: "KeyZ", ctrlKey: true });

    await waitFor(() => {
      expect(screen.queryByText("report.md")).not.toBeInTheDocument();
    });

    deferred.resolve({
      type: "resource",
      mime: "text/markdown",
      url: "http://localhost:4001/uploads/agent-documents/report.md",
      name: "report.md",
      size: 8
    });

    await waitFor(() => {
      expect(onUploadDocument).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("report.md")).not.toBeInTheDocument();

    fireEvent.keyDown(textbox, { key: "y", code: "KeyY", ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByText("report.md").closest(".pm-part--resource")).not.toHaveClass("is-uploading");
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith([
        {
          type: "resource",
          mime: "text/markdown",
          url: "http://localhost:4001/uploads/agent-documents/report.md",
          name: "report.md",
          size: 8
        }
      ]);
    });
  });

  it("上传成功后的自动替换不进入历史，撤销不会回到上传中状态", async () => {
    const onChange = vi.fn();
    const deferred = createDeferred<Parameters<typeof PartComposer>[0]["parts"][number]>();
    const onUploadDocument = vi.fn().mockReturnValue(deferred.promise);

    render(
      <PartComposer
        parts={[{ type: "text", value: "" }]}
        onCancel={vi.fn()}
        onChange={onChange}
        onSubmit={vi.fn()}
        onUploadDocument={onUploadDocument}
      />
    );

    const textbox = screen.getByRole("textbox", { name: "发消息" });
    fireEvent.drop(textbox, {
      dataTransfer: {
        files: [new File(["# report"], "report.md", { type: "text/markdown" })]
      }
    });

    expect(await screen.findByText("report.md")).toBeInTheDocument();

    deferred.resolve({
      type: "resource",
      mime: "text/markdown",
      url: "http://localhost:4001/uploads/agent-documents/report.md",
      name: "report.md",
      size: 8
    });

    await waitFor(() => {
      expect(screen.getByText("report.md").closest(".pm-part--resource")).not.toHaveClass("is-uploading");
    });

    fireEvent.keyDown(textbox, { key: "z", code: "KeyZ", ctrlKey: true });

    await waitFor(() => {
      expect(screen.queryByText("report.md")).not.toBeInTheDocument();
    });

    fireEvent.keyDown(textbox, { key: "y", code: "KeyY", ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByText("report.md").closest(".pm-part--resource")).not.toHaveClass("is-uploading");
    });
  });

  it("前端会拦截超过 20MB 的附件并提示", async () => {
    const onUploadError = vi.fn();
    const onUploadImage = vi.fn();

    render(
      <PartComposer
        parts={[{ type: "text", value: "" }]}
        onCancel={vi.fn()}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onUploadError={onUploadError}
        onUploadImage={onUploadImage}
      />
    );

    await userEvent.upload(screen.getByLabelText("选择图片"), createFileWithSize("large.png", "image/png", maxAttachmentBytes + 1));

    expect(onUploadImage).not.toHaveBeenCalled();
    expect(onUploadError).toHaveBeenCalledWith("附件不能超过 20MB");
  });

  it("点击资源主体会打开预览，点击替换按钮后会原位替换", async () => {
    const onChange = vi.fn();
    const onUploadImage = vi.fn().mockResolvedValue({
      type: "resource",
      mime: "image/png",
      url: "http://localhost:4001/uploads/images/new.png",
      name: "new.png"
    });

    render(
      <PartComposer
        parts={[
          { type: "text", value: "看" },
          { type: "resource", mime: "image/png", url: "http://localhost:4001/uploads/images/old.png", name: "old.png" },
          { type: "text", value: "这张" }
        ]}
        onCancel={vi.fn()}
        onChange={onChange}
        onSubmit={vi.fn()}
        onUploadImage={onUploadImage}
      />
    );

    await userEvent.click(screen.getByText("old.png"));
    expect(screen.getByRole("dialog", { name: "图片预览" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "替换资源" }));
    await userEvent.upload(screen.getByLabelText("选择资源"), new File(["image"], "new.png", { type: "image/png" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith([
        { type: "text", value: "看" },
        {
          type: "resource",
          mime: "image/png",
          url: "http://localhost:4001/uploads/images/new.png",
          name: "new.png"
        },
        { type: "text", value: "这张" }
      ]);
    });
  });

  it("全选后点击 resource part 会先清除范围选中态", async () => {
    render(
      <PartComposer
        parts={[
          { type: "text", value: "看" },
          { type: "resource", mime: "image/png", url: "http://localhost:4001/uploads/images/old.png", name: "old.png" },
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

    const resourcePart = screen.getByText("old.png").closest(".pm-part--resource");
    expect(resourcePart).toBeInstanceOf(HTMLElement);

    await waitFor(() => {
      expect(resourcePart).toHaveClass("is-range-selected");
    });

    await userEvent.click(screen.getByText("old.png"));

    await waitFor(() => {
      expect(resourcePart).not.toHaveClass("is-range-selected");
    });
  });

  it("全选后点击输入框外部会清除 resource part 选中态", async () => {
    render(
      <>
        <button type="button">外部区域</button>
        <PartComposer
          parts={[
            { type: "text", value: "看" },
            { type: "resource", mime: "image/png", url: "http://localhost:4001/uploads/images/old.png", name: "old.png" },
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

    const resourcePart = screen.getByText("old.png").closest(".pm-part--resource");
    expect(resourcePart).toBeInstanceOf(HTMLElement);

    await waitFor(() => {
      expect(resourcePart).toHaveClass("is-range-selected");
    });

    await userEvent.click(screen.getByRole("button", { name: "外部区域" }));

    await waitFor(() => {
      expect(resourcePart).not.toHaveClass("is-range-selected");
    });
  });

  it("点击 resource part 删除按钮会移除当前 part 并保留周围文本", async () => {
    const onChange = vi.fn();
    const onUploadImage = vi.fn();

    render(
      <PartComposer
        parts={[
          { type: "text", value: "看" },
          { type: "resource", mime: "image/png", url: "http://localhost:4001/uploads/images/old.png", name: "old.png" },
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

  it("视频 resource part 在输入框里显示为视频占位，不把 mp4 当图片缩略图", () => {
    const { container } = render(
      <PartComposer
        parts={[
          {
            type: "resource",
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

    const resourcePart = screen.getByText("节日主图动态视频").closest(".pm-part--resource");
    expect(resourcePart).toBeInstanceOf(HTMLElement);
    expect(resourcePart).toHaveTextContent("视频");
    expect(resourcePart).toHaveAttribute("data-mime", "video/mp4");
    expect(container.querySelector('img.pm-part-resource-thumb[src$=".mp4"]')).toBeNull();
  });

  it("点击视频 resource part 不会打开图片选择器", async () => {
    render(
      <PartComposer
        parts={[
          {
            type: "resource",
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
    expect(screen.getByRole("dialog", { name: "视频预览" })).toBeInTheDocument();
  });

  it("resource part 不使用外部 margin，并让拖选态和文本选区颜色一致", () => {
    const styles = readAppStyles();

    expect(styles).toMatch(/\.pm-part--resource\s*{[^}]*margin:\s*0;/s);
    expect(styles).toMatch(/\.pm-part--resource\s*{[^}]*max-width:\s*min\(176px,\s*100%\);/s);
    expect(styles).toMatch(/\.pm-part-resource-name\s*{[^}]*max-width:\s*118px;/s);
    expect(styles).toMatch(/\.pm-part--resource\s*{[^}]*height:\s*var\(--part-composer-line-height\);/s);
    expect(styles).toMatch(/\.pm-part--resource\s*{[^}]*padding:\s*0\s+[^;]+;/s);
    expect(styles).not.toMatch(/\.pm-part--resource\s*{[^}]*margin-right:/s);
    expect(styles).not.toMatch(/\.pm-part--resource\s*{[^}]*user-select:\s*none;/s);
    expect(styles).toMatch(/\.pm-part-resource-remove\s*{[^}]*width:\s*18px;[^}]*height:\s*18px;/s);
    expect(styles).toMatch(/\.pm-part-resource-remove:hover\s*{[^}]*background:\s*var\(--eye-primary\);/s);
    expect(styles).toMatch(/\.pm-part--resource\.ProseMirror-selectednode\s*{[^}]*box-shadow:/s);
    expect(styles).toMatch(/\.part-composer-editor\s*{[^}]*--part-composer-selection-background:\s*#[0-9a-fA-F]{6};/s);
    expect(styles).toMatch(
      /\.part-composer-editor::selection,\s*\.part-composer-editor \*::selection\s*{[^}]*background:\s*var\(--part-composer-selection-background\);/s
    );
    expect(styles).toMatch(
      /\.pm-part--resource\.is-range-selected\s*{[^}]*background:\s*var\(--part-composer-selection-background\);[^}]*color:\s*var\(--part-composer-selection-color\);/s
    );
    expect(styles).toMatch(
      /\.pm-part--resource\.is-range-selected\s*{[^}]*height:\s*var\(--part-composer-line-height\);[^}]*border-radius:\s*0;/s
    );
  });
});
