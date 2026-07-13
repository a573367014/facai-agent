import { describe, expect, it } from "vitest";
import {
  buildClearedSessionUrlPath,
  buildSessionUrlPath,
  readSessionIdFromUrl
} from "./session-url";

describe("session URL", () => {
  it("读取并 trim 第一个 sessionId", () => {
    expect(
      readSessionIdFromUrl(
        "https://example.com/chat?sessionId=%20session_1%20&sessionId=session_2"
      )
    ).toBe("session_1");
    expect(readSessionIdFromUrl("https://example.com/chat?sessionId=%20%20")).toBeUndefined();
  });

  it("写入 sessionId 时保留 pathname、其他 query 和 hash", () => {
    expect(
      buildSessionUrlPath("https://example.com/chat?view=compact#latest", "session 1")
    ).toBe("/chat?view=compact&sessionId=session+1#latest");
  });

  it("sessionId 未变化时不产生 history 写入路径", () => {
    expect(
      buildSessionUrlPath(
        "https://example.com/chat?sessionId=session_1#latest",
        "session_1"
      )
    ).toBeUndefined();
  });

  it("清理 sessionId 时保留其他 URL 部分", () => {
    expect(
      buildClearedSessionUrlPath(
        "https://example.com/chat?view=compact&sessionId=session_1#latest"
      )
    ).toBe("/chat?view=compact#latest");
  });

  it("compare-and-clear 不会清理已切换到其他会话的 URL", () => {
    expect(
      buildClearedSessionUrlPath(
        "https://example.com/chat?sessionId=session_2",
        "session_1"
      )
    ).toBeUndefined();
    expect(
      buildClearedSessionUrlPath(
        "https://example.com/chat?sessionId=session_1",
        "session_1"
      )
    ).toBe("/chat");
  });
});
