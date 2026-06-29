import { describe, expect, it } from "vitest";
import { appTheme } from "./mui-theme";

describe("appTheme", () => {
  it("Tooltip 默认不响应浮层 hover，避免提示粘住", () => {
    expect(appTheme.components?.MuiTooltip?.defaultProps?.disableInteractive).toBe(true);
  });
});
