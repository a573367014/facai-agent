import { z } from "zod";
import type { RegisteredTool } from "../agent/types.js";

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
