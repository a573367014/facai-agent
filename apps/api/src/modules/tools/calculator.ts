/**
 * 计算器工具（calculator）
 *
 * 让 LLM 能够做精确算术，避免模型自身在数字运算上的幻觉。
 *
 * 安全边界：采用"正则白名单 + 受限解析器"的双层防御——
 * 先用正则把表达式约束在数字和基本运算符内，
 * 再用关闭了赋值 / 逻辑 / 比较 / in 等能力的 expr-eval 解析器求值。
 * 不限制运算符的话，expr-eval 默认支持 assignment、in、conditional 等，
 * 可能被构造出有副作用或绕过预期的表达式。
 */
import { Parser } from "expr-eval";
import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import type { RegisteredTool } from "./types.js";

const calculatorArgsSchema = z.object({
  expression: z.string().min(1)
});

// 第一道防线：只允许数字、括号、加减乘除、取模和空白。
// 不在这个字符集里的输入直接拒绝，根本不进入解析器，避免解析器暴露更多攻击面。
const safeExpressionPattern = /^[0-9+\-*/%().\s]+$/;

// 第二道防线：即便正则放行，解析器本身也只开启算术能力，
// 关闭 power / factorial / assignment / logical / comparison / in / concatenate，
// 万一正则有遗漏，仍然不会被构造出有副作用或越界的表达式。
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

    // 即便表达式合法，结果也可能是 Infinity / NaN（例如除零）。
    // 这种值对 LLM 和用户都没有意义，统一拒绝，避免污染后续推理。
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AppError("TOOL_EXECUTION_ERROR", "表达式结果不是有限数字", 400);
    }

    return { value };
  }
};
