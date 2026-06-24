import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentConversation, type ChatMessage } from "./AgentConversation";

describe("AgentConversation", () => {
  it("renders assistant answers as Markdown", () => {
    const messages: ChatMessage[] = [
      {
        id: "run_1:assistant",
        role: "assistant",
        content: "**重点**\n\n- 第一项\n\n```ts\nconst value = 1;\n```",
        status: "completed"
      }
    ];

    const { container } = render(<AgentConversation messages={messages} isActive={false} />);

    expect(screen.getByText("重点").tagName.toLowerCase()).toBe("strong");
    expect(screen.getByText("第一项").tagName.toLowerCase()).toBe("li");
    expect(container.querySelector("pre code")).toHaveTextContent("const value = 1;");
  });
});
