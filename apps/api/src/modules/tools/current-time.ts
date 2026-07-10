/**
 * 当前时间工具（current_time）
 *
 * 让 LLM 能拿到"现在的真实时间"。模型自身没有实时时钟，
 * 不借助工具时往往会给出训练截止时的旧时间或直接编造。
 *
 * 边界：只负责返回当前时间，不做时间换算、时区推导、日程计算等复杂逻辑——
 * 那些交给 LLM 根据返回的 iso / localized 文本自行推理，工具保持单一职责。
 */
import { z } from "zod";
import type { RegisteredTool } from "./types.js";

const currentTimeArgsSchema = z.object({
  timezone: z.string().optional().default("UTC")
});

export const currentTimeTool: RegisteredTool = {
  name: "current_time",
  description: "返回指定时区的当前时间。",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA 时区名称，例如 Asia/Shanghai"
      }
    }
  },
  argumentSchema: currentTimeArgsSchema,
  async execute(args) {
    const { timezone } = currentTimeArgsSchema.parse(args);
    const now = new Date();

    return {
      iso: now.toISOString(),
      timezone,
      localized: new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: timezone
      }).format(now)
    };
  }
};
