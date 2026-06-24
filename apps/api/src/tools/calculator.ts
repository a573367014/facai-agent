import { Parser } from "expr-eval";
import { z } from "zod";
import { AppError } from "../errors/app-error.js";
import type { RegisteredTool } from "./types.js";

const calculatorArgsSchema = z.object({
  expression: z.string().min(1)
});

const safeExpressionPattern = /^[0-9+\-*/%().\s]+$/;
const parser = new Parser({
  operators: {
    add: true,
    subtract: true,
    multiply: true,
    divide: true,
    remainder: true,
    power: false,
    factorial: false,
    concatenate: false,
    conditional: false,
    logical: false,
    comparison: false,
    in: false,
    assignment: false
  }
});

export const calculatorTool: RegisteredTool = {
  name: "calculator",
  description: "计算安全的基础算术表达式，只支持数字、括号、加减乘除和取模。",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "要计算的算术表达式，例如 12 * (9 + 1)"
      }
    },
    required: ["expression"]
  },
  argumentSchema: calculatorArgsSchema,
  async execute(args) {
    const { expression } = calculatorArgsSchema.parse(args);

    if (!safeExpressionPattern.test(expression)) {
      throw new AppError("TOOL_EXECUTION_ERROR", "只支持安全的算术表达式", 400);
    }

    const value = parser.evaluate(expression);

    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AppError("TOOL_EXECUTION_ERROR", "表达式结果不是有限数字", 400);
    }

    return { value };
  }
};
