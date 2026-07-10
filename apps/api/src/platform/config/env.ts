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
  AGENT_EMBEDDING_DIMENSION: z.coerce.number().int().positive().optional(),
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
  AGENT_PUBLIC_BASE_URL: z.string().url().optional(),
  AGENT_TOOL_RESOURCE_MAX_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),
  AGENT_TOOL_RESOURCE_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  AGENT_UPLOAD_RESPONSE_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(0),
  GITHUB_OAUTH_CLIENT_ID: optionalEnvString,
  GITHUB_OAUTH_CLIENT_SECRET: optionalEnvString,
  GITHUB_OAUTH_REDIRECT_URI: optionalEnvUrl,
  JWT_ACCESS_SECRET: envStringWithDefault("dev-access-token-secret-change-me"),
  JWT_REFRESH_SECRET: envStringWithDefault("dev-refresh-token-secret-change-me"),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  AUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 24 * 60 * 60),
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
  AGENT_UPLOAD_DIR: z.string().default("../../var/uploads"),
  DATABASE_URL: z.string().url().default("postgres://postgres:postgres@localhost:5432/agent"),
  // S3 兼容对象存储（MinIO / Cloudflare R2 / AWS S3）。
  // 开发用本地 MinIO，生产把 endpoint 换成 R2 即可，代码不用动。
  S3_ENDPOINT: envUrlWithDefault("http://localhost:9000"),
  S3_REGION: envStringWithDefault("us-east-1"),
  S3_BUCKET: envStringWithDefault("agent-uploads"),
  S3_ACCESS_KEY_ID: envStringWithDefault("minioadmin"),
  S3_SECRET_ACCESS_KEY: envStringWithDefault("minioadmin"),
  // 访问图片用的公开 base URL。MinIO 默认就是 endpoint 本身；
  // R2 需要填绑定的公开域名。留空则自动用 S3_ENDPOINT。
  S3_PUBLIC_BASE_URL: optionalEnvUrl
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(withAuthEnvAliases(source));
}

function withAuthEnvAliases(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...source,
    GITHUB_OAUTH_CLIENT_ID: source.GITHUB_OAUTH_CLIENT_ID ?? source.GITHUB_CLIENT_ID,
    GITHUB_OAUTH_CLIENT_SECRET: source.GITHUB_OAUTH_CLIENT_SECRET ?? source.GITHUB_CLIENT_SECRET,
    GITHUB_OAUTH_REDIRECT_URI: source.GITHUB_OAUTH_REDIRECT_URI ?? source.GITHUB_REDIRECT_URI,
    AUTH_ACCESS_TOKEN_TTL_SECONDS: source.AUTH_ACCESS_TOKEN_TTL_SECONDS ?? source.JWT_ACCESS_TTL_SECONDS
  };
}
