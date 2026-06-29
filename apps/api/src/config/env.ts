import { z } from "zod";

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
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(8).default(4),
  AGENT_CONTEXT_MAX_MESSAGES: z.coerce.number().int().min(0).max(50).default(12),
  AGENT_CONTEXT_MAX_HISTORY_CHARS: z.coerce.number().int().min(0).max(200_000).default(12_000),
  AGENT_SUMMARY_TRIGGER_MESSAGES: z.coerce.number().int().min(0).max(100).default(16),
  AGENT_SUMMARY_KEEP_RECENT_MESSAGES: z.coerce.number().int().min(1).max(50).default(8),
  AGENT_SUMMARY_TRIGGER_CHARS: z.coerce.number().int().min(0).max(200_000).default(2000),
  AGENT_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  AGENT_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(3),
  AGENT_EVENT_CLEANUP_HOUR: z.coerce.number().int().min(0).max(23).default(3),
  AGENT_EVENT_CLEANUP_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(2000),
  AGENT_EVENT_CLEANUP_MAX_BATCHES: z.coerce.number().int().min(1).max(200).default(20),
  AGENT_RUNNING_STATE_STORE: z.enum(["memory", "redis"]).default("memory"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  AGENT_RUNNING_STATE_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(7200),
  AGENT_RUNNING_STATE_REDIS_KEY_PREFIX: z.string().min(1).default("agent"),
  AGENT_ALLOWED_TOOLS: z
    .string()
    .optional()
    .transform((value) => value?.split(",").map((name) => name.trim()).filter(Boolean)),
  TAVILY_API_KEY: z.string().optional(),
  SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(10).default(5),
  VOLCENGINE_ACCESS_KEY_ID: z.string().optional(),
  VOLCENGINE_SECRET_ACCESS_KEY: z.string().optional(),
  VOLCENGINE_IMAGE_ENDPOINT: z.string().url().default("https://visual.volcengineapi.com"),
  VOLCENGINE_IMAGE_REGION: z.string().default("cn-north-1"),
  VOLCENGINE_IMAGE_SERVICE: z.string().default("cv"),
  VOLCENGINE_IMAGE_REQ_KEY: z.string().default("high_aes_general_v30l_zt2i"),
  VOLCENGINE_IMAGE_EDIT_VERSION: z.string().default("2022-08-31"),
  VOLCENGINE_IMAGE_EDIT_REQ_KEY: z.string().default("seededit_v3.0"),
  VOLCENGINE_IMAGE_POLL_INTERVAL_MS: z.coerce.number().int().min(0).default(1500),
  VOLCENGINE_IMAGE_MAX_POLL_ATTEMPTS: z.coerce.number().int().min(1).max(120).default(40),
  VOLCENGINE_IMAGE_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(90000),
  VOLCENGINE_IMAGE_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(2),
  AGENT_UPLOAD_DIR: z.string().default("./data/uploads"),
  AGENT_SQLITE_PATH: z.string().default("./data/agent.sqlite")
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
