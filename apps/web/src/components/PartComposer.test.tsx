import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartComposer } from "./PartComposer";

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
});
