import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4001),
  HOST: z.string().default("0.0.0.0"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_MODEL: z.string().optional(),
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(8).default(4)
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
