import { z } from "zod";

const optionalEnvString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional()
);
const optionalEnvUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional()
);
const envUrlWithDefault = (defaultValue: string) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().url().default(defaultValue)
  );
const envStringWithDefault = (defaultValue: string) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(1).default(defaultValue)
  );

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4001),
  HOST: z.string().default("0.0.0.0"),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((value) => value?.split(",").map((origin) => origin.trim()).filter(Boolean)),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_MODEL: z.string().optional(),
  EMBEDDING_PROVIDER: z.enum(["openai-compatible", "ollama"]).default("openai-compatible"),
  OPENAI_EMBEDDING_API_KEY: optionalEnvString,
  OPENAI_EMBEDDING_BASE_URL: optionalEnvUrl,
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  OLLAMA_BASE_URL: envUrlWithDefault("http://localhost:11434"),
  OLLAMA_EMBEDDING_MODEL: envStringWithDefault("embeddinggemma"),
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(8).default(4),
  AGENT_CONTEXT_MAX_MESSAGES: z.coerce.number().int().min(0).max(50).default(12),
  AGENT_CONTEXT_MAX_HISTORY_CHARS: z.coerce.number().int().min(0).max(200_000).default(12_000),
  AGENT_SUMMARY_TRIGGER_MESSAGES: z.coerce.number().int().min(0).max(100).default(16),
  AGENT_SUMMARY_KEEP_RECENT_MESSAGES: z.coerce.number().int().min(1).max(50).default(8),
  AGENT_SUMMARY_TRIGGER_CHARS: z.coerce.number().int().min(0).max(200_000).default(2000),
  AGENT_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  AGENT_EVENT_LOG_PATH: z.string().default("./data/agent-events.jsonl"),
  AGENT_PUBLIC_BASE_URL: z.string().url().optional(),
  AGENT_TOOL_RESOURCE_MAX_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),
  AGENT_TOOL_RESOURCE_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  AGENT_RUNNING_STATE_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(7200),
  AGENT_RUNNING_STATE_REDIS_KEY_PREFIX: z.string().min(1).default("agent"),
  AGENT_QUEUE_NAME: z.string().min(1).default("agent-runs"),
  AGENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  AGENT_RUN_LOCK_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(1800),
  AGENT_CANCEL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(7200),
  AGENT_ALLOWED_TOOLS: z
    .string()
    .optional()
    .transform((value) => value?.split(",").map((name) => name.trim()).filter(Boolean)),
  TAVILY_API_KEY: z.string().optional(),
  SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(10).default(5),
  VOLCENGINE_ACCESS_KEY_ID: z.string().optional(),
  VOLCENGINE_SECRET_ACCESS_KEY: z.string().optional(),
  AGENT_UPLOAD_DIR: z.string().default("./data/uploads"),
  AGENT_SQLITE_PATH: z.string().default("./data/agent.sqlite")
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
