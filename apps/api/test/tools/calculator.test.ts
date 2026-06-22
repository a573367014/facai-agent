import { describe, expect, it } from "vitest";
import { calculatorTool } from "../../src/tools/calculator.js";

describe("calculatorTool", () => {
  it("计算安全算术表达式", async () => {
    await expect(calculatorTool.execute({ expression: "12 * (9 + 1)" })).resolves.toEqual({ value: 120 });
  });

  it("拒绝非算术表达式", async () => {
    await expect(calculatorTool.execute({ expression: "process.exit()" })).rejects.toThrow("只支持安全的算术表达式");
  });
});
