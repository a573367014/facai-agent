import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Redis } from "ioredis";
import { AgentService } from "./agent/agent-service.js";
import { AgentMessageCoordinator } from "./agent/agent-message-coordinator.js";
import { AgentSummaryService } from "./agent/agent-summary-service.js";
import { AgentContextBuilder } from "./agent/context-builder.js";
import { InMemoryRunningMessageStateStore, type RunningMessageStateStore } from "./agent/running-message-state-store.js";
import { RedisRunningMessageStateStore } from "./agent/redis-running-message-state-store.js";
import { SqliteAgentStore } from "./agent/sqlite-agent-store.js";
import { createCorsOriginChecker } from "./config/cors.js";
import { loadEnv } from "./config/env.js";
import { AppError } from "./errors/app-error.js";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible-provider.js";
import { registerAgentRoutes } from "./routes/agent-routes.js";
import { registerHealthRoutes } from "./routes/health-routes.js";
import { ToolAccessPolicy } from "./tools/access-policy.js";
import { ToolExecutor } from "./tools/executor.js";
import { createDefaultToolRegistry } from "./tools/index.js";

export interface BuildAppOptions {
  agentService?: AgentService;
  coordinator?: AgentMessageCoordinator;
  databasePath?: string;
  eventRetentionDays?: number;
  eventCleanupHour?: number;
  eventCleanupBatchSize?: number;
  eventCleanupMaxBatches?: number;
  runningStateStore?: RunningMessageStateStore;
  uploadDirectory?: string;
}

function getDelayUntilNextCleanupHour(now: Date, cleanupHour: number) {
  const nextCleanupAt = new Date(now);
  nextCleanupAt.setHours(cleanupHour, 0, 0, 0);

  if (nextCleanupAt.getTime() <= now.getTime()) {
    nextCleanupAt.setDate(nextCleanupAt.getDate() + 1);
  }

  return nextCleanupAt.getTime() - now.getTime();
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });
  const env = loadEnv();
  const isAllowedCorsOrigin = createCorsOriginChecker(env.CORS_ORIGINS);

  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isAllowedCorsOrigin(origin));
    }
  });

  const uploadDirectory = resolve(options.uploadDirectory ?? env.AGENT_UPLOAD_DIR);
  await mkdir(uploadDirectory, { recursive: true });

  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: 10 * 1024 * 1024
    }
  });

  await app.register(fastifyStatic, {
    root: uploadDirectory,
    prefix: "/uploads/"
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message
        }
      });
      return;
    }

    reply.status(500).send({
      error: {
        code: "PROVIDER_ERROR",
        message: error instanceof Error ? error.message : "发生未知错误"
      }
    });
  });

  // 同一个 registry 同时服务两条路径：
  // 1. getDefinitions() 给 LLM 看有哪些工具；
  // 2. ToolExecutor 执行时按 toolName 找到真实工具。
  const toolRegistry = createDefaultToolRegistry({
    tavilyApiKey: env.TAVILY_API_KEY,
    searchMaxResults: env.SEARCH_MAX_RESULTS,
    jimengImage: {
      accessKeyId: env.VOLCENGINE_ACCESS_KEY_ID,
      secretAccessKey: env.VOLCENGINE_SECRET_ACCESS_KEY,
      endpoint: env.VOLCENGINE_IMAGE_ENDPOINT,
      region: env.VOLCENGINE_IMAGE_REGION,
      service: env.VOLCENGINE_IMAGE_SERVICE,
      reqKey: env.VOLCENGINE_IMAGE_REQ_KEY,
      pollIntervalMs: env.VOLCENGINE_IMAGE_POLL_INTERVAL_MS,
      maxPollAttempts: env.VOLCENGINE_IMAGE_MAX_POLL_ATTEMPTS,
      timeoutMs: env.VOLCENGINE_IMAGE_TOOL_TIMEOUT_MS,
      batchConcurrency: env.VOLCENGINE_IMAGE_BATCH_CONCURRENCY
    },
    jimengImageEdit: {
      accessKeyId: env.VOLCENGINE_ACCESS_KEY_ID,
      secretAccessKey: env.VOLCENGINE_SECRET_ACCESS_KEY,
      uploadDirectory,
      endpoint: env.VOLCENGINE_IMAGE_ENDPOINT,
      region: env.VOLCENGINE_IMAGE_REGION,
      service: env.VOLCENGINE_IMAGE_SERVICE,
      version: env.VOLCENGINE_IMAGE_EDIT_VERSION,
      reqKey: env.VOLCENGINE_IMAGE_EDIT_REQ_KEY,
      pollIntervalMs: env.VOLCENGINE_IMAGE_POLL_INTERVAL_MS,
      maxPollAttempts: env.VOLCENGINE_IMAGE_MAX_POLL_ATTEMPTS,
      timeoutMs: env.VOLCENGINE_IMAGE_TOOL_TIMEOUT_MS
    }
  });
  // 当前先用 allow-list 做最小权限控制。未配置时 demo 仍开放所有默认工具；
  // 配了 AGENT_ALLOWED_TOOLS 后，LLM 只能看到这些工具，执行层也只允许这些工具。
  const toolAccessPolicy = new ToolAccessPolicy({ allowedToolNames: env.AGENT_ALLOWED_TOOLS });
  const defaultProvider = new OpenAiCompatibleProvider({
    apiKey: env.OPENAI_API_KEY ?? "",
    baseUrl: env.OPENAI_BASE_URL,
    model: env.OPENAI_MODEL ?? ""
  });
  const agentService =
    options.agentService ??
    new AgentService({
      provider: defaultProvider,
      toolRegistry,
      toolAccessPolicy,
      // 工具超时放在 executor，而不是每个工具自己处理，保证所有工具都有统一兜底。
      toolExecutor: new ToolExecutor({
        registry: toolRegistry,
        timeoutMs: env.AGENT_TOOL_TIMEOUT_MS,
        accessPolicy: toolAccessPolicy
      }),
      defaultMaxIterations: env.AGENT_MAX_ITERATIONS
    });
  let coordinator = options.coordinator;

  if (!coordinator) {
    const eventRetentionDays = options.eventRetentionDays ?? env.AGENT_EVENT_RETENTION_DAYS;
    const agentStore = await SqliteAgentStore.create({
      databasePath: options.databasePath ?? env.AGENT_SQLITE_PATH,
      eventRetentionDays
    });
    const eventCleanupHour = options.eventCleanupHour ?? env.AGENT_EVENT_CLEANUP_HOUR;
    const eventCleanupBatchSize = options.eventCleanupBatchSize ?? env.AGENT_EVENT_CLEANUP_BATCH_SIZE;
    const eventCleanupMaxBatches = options.eventCleanupMaxBatches ?? env.AGENT_EVENT_CLEANUP_MAX_BATCHES;
    let redisClient: Redis | undefined;
    const runningStateStore =
      options.runningStateStore ??
      (() => {
        if (env.AGENT_RUNNING_STATE_STORE !== "redis") {
          return new InMemoryRunningMessageStateStore();
        }

        redisClient = new Redis(env.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 2
        });
        redisClient.on("error", (error: Error) => {
          app.log.warn({ error }, "redis running state store error");
        });

        return new RedisRunningMessageStateStore({
          client: redisClient,
          keyPrefix: env.AGENT_RUNNING_STATE_REDIS_KEY_PREFIX,
          ttlSeconds: env.AGENT_RUNNING_STATE_TTL_SECONDS
        });
      })();
    const cleanupExpiredEvents = () => {
      const nowIso = new Date().toISOString();

      try {
        const result = agentStore.pruneExpiredEvents({
          nowIso,
          batchSize: eventCleanupBatchSize,
          maxBatches: eventCleanupMaxBatches
        });
        const deletedEvents = result.messageEvents + result.runEvents;

        if (deletedEvents > 0) {
          app.log.info(
            { nowIso, eventCleanupBatchSize, eventCleanupMaxBatches, ...result },
            "expired agent events pruned"
          );
        }

        if (result.reachedLimit) {
          app.log.warn(
            { nowIso, eventCleanupBatchSize, eventCleanupMaxBatches, ...result },
            "expired agent event cleanup reached batch limit"
          );
        }
      } catch (error) {
        app.log.warn({ error }, "failed to prune expired agent events");
      }
    };
    let eventCleanupTimer: NodeJS.Timeout | undefined;
    const scheduleNextEventCleanup = () => {
      const delayMs = getDelayUntilNextCleanupHour(new Date(), eventCleanupHour);
      eventCleanupTimer = setTimeout(() => {
        cleanupExpiredEvents();
        scheduleNextEventCleanup();
      }, delayMs);
      eventCleanupTimer.unref?.();
    };
    scheduleNextEventCleanup();

    app.addHook("onClose", async () => {
      if (eventCleanupTimer) {
        clearTimeout(eventCleanupTimer);
      }
      if (redisClient) {
        redisClient.disconnect();
      }
      agentStore.close();
    });

    coordinator = new AgentMessageCoordinator(
      agentService,
      agentStore,
      new AgentContextBuilder({
        maxHistoryMessages: env.AGENT_CONTEXT_MAX_MESSAGES,
        maxHistoryCharacters: env.AGENT_CONTEXT_MAX_HISTORY_CHARS
      }),
      options.agentService
        ? undefined
        : new AgentSummaryService({
            provider: defaultProvider,
            triggerMessageCount: env.AGENT_SUMMARY_TRIGGER_MESSAGES,
            keepRecentMessages: env.AGENT_SUMMARY_KEEP_RECENT_MESSAGES,
            triggerCharacterCount: env.AGENT_SUMMARY_TRIGGER_CHARS
          }),
      runningStateStore
    );
  }

  await registerHealthRoutes(app);
  await registerAgentRoutes(app, coordinator, { uploadDirectory });

  return app;
}
