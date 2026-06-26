import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentComposer } from "./AgentComposer";

function renderForm(overrides: Partial<Parameters<typeof AgentComposer>[0]> = {}) {
  const props = {
    parts: [{ type: "text", value: "你好" }] as Parameters<typeof AgentComposer>[0]["parts"],
    maxIterations: 4,
    isStreaming: false,
    onPartsChange: vi.fn(),
    onMaxIterationsChange: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  };

  render(<AgentComposer {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
});

describe("AgentComposer", () => {
  it("输入框中按 Enter 直接提交", async () => {
    const props = renderForm();

    screen.getByLabelText("发消息").focus();
    await userEvent.keyboard("{Enter}");

    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(props.onPartsChange).not.toHaveBeenCalledWith([{ type: "text", value: "你好\n" }]);
  });

  it("输入框中按 Shift+Enter 换行，不提交", async () => {
    const props = renderForm();

    screen.getByLabelText("发消息").focus();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");

    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("生成中按 Enter 会提交新输入，不直接停止", async () => {
    const props = renderForm({ isStreaming: true, parts: [{ type: "text", value: "新的问题" }] });

    screen.getByLabelText("发消息").focus();
    await userEvent.keyboard("{Enter}");

    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("生成中提交按钮切换为停止按钮", async () => {
    const props = renderForm({ isStreaming: true });

    expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "停止" }));

    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});
