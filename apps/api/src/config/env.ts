import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4001),
  HOST: z.string().default("0.0.0.0"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_MODEL: z.string().optional(),
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(8).default(4),
  AGENT_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  AGENT_ALLOWED_TOOLS: z
    .string()
    .optional()
    .transform((value) => value?.split(",").map((name) => name.trim()).filter(Boolean)),
  TAVILY_API_KEY: z.string().optional(),
  SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(10).default(5),
  AGENT_STORE: z.enum(["memory", "sqlite"]).default("memory"),
  AGENT_SQLITE_PATH: z.string().default("./data/agent.sqlite")
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
