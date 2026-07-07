import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { Queue } from "bullmq";
import Fastify from "fastify";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { JsonlAgentEventLogger, type AgentEventLogger } from "./agent/agent-event-logger.js";
import { AgentMessageCoordinator, type AgentRunner } from "./agent/agent-message-coordinator.js";
import { RedisAgentCancellationStore, type AgentCancellationStore } from "./agent/agent-cancellation-store.js";
import { RedisAgentEventBus, type AgentEventBus } from "./agent/agent-event-bus.js";
import {
  agentRunJobName,
  BullMqAgentRunQueue,
  type AgentRunJobPayload,
  type AgentRunQueue,
  type AgentRunQueueClient
} from "./agent/agent-run-queue.js";
import { RedisAgentRunLock, type AgentRunLock, type RedisRunLockClient } from "./agent/agent-run-lock.js";
import { AgentSummaryService } from "./agent/agent-summary-service.js";
import { AgentContextBuilder } from "./agent/context-builder.js";
import type { RunningMessageStateStore } from "./agent/running-message-state-store.js";
import { RedisRunningMessageStateStore } from "./agent/redis-running-message-state-store.js";
import { PostgresAgentStore } from "./agent/postgres-agent-store.js";
import { LocalToolResourceStorage, type ToolResourceStorage } from "./agent/tool-resource-storage.js";
import { createCorsOriginChecker } from "./config/cors.js";
import { loadEnv } from "./config/env.js";
import { AppError } from "./errors/app-error.js";
import { toRuntimeDependencyAppError } from "./errors/runtime-dependency-error.js";
import { createEmbeddingService, type EmbeddingService } from "./knowledge/embedding-service.js";
import { KnowledgeIndexingService } from "./knowledge/indexing-service.js";
import {
  BullMqKnowledgeIndexQueue,
  NoopKnowledgeIndexQueue,
  type KnowledgeIndexJobPayload,
  type KnowledgeIndexQueue
} from "./knowledge/knowledge-run-queue.js";
import { KnowledgeRetriever } from "./knowledge/retriever.js";
import { createLlmModelFromEnv } from "./langchain/model-factory.js";
import { LangChainProviderShim } from "./langchain/provider-shim.js";
import { LangChainAgentService } from "./langchain/langchain-agent-service.js";
import { createRedisRuntime, toBullMqRedisConnectionOptions, type RedisRuntime } from "./redis/runtime.js";
import { registerAgentRoutes } from "./routes/agent-routes.js";
import { registerHealthRoutes } from "./routes/health-routes.js";
import { registerKnowledgeRoutes } from "./routes/knowledge-routes.js";
import { endRequestSpan, getRequestSpan, getRequestTraceparent, startRequestSpan } from "./observability/trace-context.js";
import { ToolAccessPolicy } from "./tools/access-policy.js";
import { ToolExecutor } from "./tools/executor.js";
import { createDefaultToolRegistry } from "./tools/index.js";

export interface BuildAppOptions {
  agentService?: AgentRunner;
  coordinator?: AgentMessageCoordinator;
  databasePath?: string;
  agentEventLogPath?: string;
  agentEventLogger?: AgentEventLogger;
  runningStateStore?: RunningMessageStateStore;
  eventBus?: AgentEventBus;
  runQueue?: AgentRunQueue;
  knowledgeIndexQueue?: KnowledgeIndexQueue;
  embeddingService?: EmbeddingService;
  cancellationStore?: AgentCancellationStore;
  runLock?: AgentRunLock;
  toolResourceStorage?: ToolResourceStorage;
  uploadDirectory?: string;
  skipStaleCleanup?: boolean;
}

export type AgentRuntimeFastifyInstance = Awaited<ReturnType<typeof buildApp>> & {
  agentCoordinator?: AgentMessageCoordinator;
  knowledgeIndexingService?: KnowledgeIndexingService;
};

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
  const publicBaseUrl = env.AGENT_PUBLIC_BASE_URL ?? `http://127.0.0.1:${env.PORT}`;
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

    const runtimeDependencyError = toRuntimeDependencyAppError(error);

    if (runtimeDependencyError) {
      reply.status(runtimeDependencyError.statusCode).send({
        error: {
          code: runtimeDependencyError.code,
          message: runtimeDependencyError.message
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

  // 手动管理 Fastify 请求 span 并注入 W3C traceparent 响应头。
  // 背景：@opentelemetry/instrumentation-fastify 在 tsx 的 ESM loader 下不生效（依赖 CJS 模块 patch），
  // 所以这里用 onRequest 钩子手动创建 server span，挂到 request 上，onSend 时取出来构建 traceparent。
  // traceparent 是全行业通用的跨进程 trace 传递协议，前端开发者可以用它去 Jaeger 搜索完整链路。
  // SSE 流已经手动 writeHead 并会触发多次 onSend，这里跳过避免无效写入和干扰。
  app.addHook("onRequest", async (request) => {
    const routePath = request.routeOptions?.url ?? request.url;
    startRequestSpan(request, routePath, request.method);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (reply.getHeader("traceparent")) {
      return payload;
    }

    const isSseStream =
      request.routeOptions?.url?.endsWith("/stream") ||
      reply.getHeader("content-type") === "text/event-stream; charset=utf-8";
    if (isSseStream) {
      return payload;
    }

    const traceparent = getRequestTraceparent(request);
    if (!traceparent) {
      return payload;
    }

    reply.header("traceparent", traceparent);
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    endRequestSpan(request, reply.statusCode);
  });

  app.addHook("onError", async (request, reply, _error) => {
    // onError 后 Fastify 仍会调用 onResponse，这里只记录错误属性，span 由 onResponse 结束。
    const span = getRequestSpan(request);
    if (span) {
      span.setAttribute("error", true);
    }
  });

  // 当前先用 allow-list 做最小权限控制。未配置时 demo 仍开放所有默认工具；
  // 配了 AGENT_ALLOWED_TOOLS 后，LLM 只能看到这些工具，执行层也只允许这些工具。
  const toolAccessPolicy = new ToolAccessPolicy({ allowedToolNames: env.AGENT_ALLOWED_TOOLS });
  const defaultProvider = new LangChainProviderShim({ model: createLlmModelFromEnv(env) });
  const embeddingService =
    options.embeddingService ??
    createEmbeddingService({
      provider: env.EMBEDDING_PROVIDER,
      openAiCompatible: {
        apiKey: env.OPENAI_EMBEDDING_API_KEY ?? env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_EMBEDDING_BASE_URL ?? env.OPENAI_BASE_URL,
        model: env.OPENAI_EMBEDDING_MODEL
      },
      ollama: {
        baseUrl: env.OLLAMA_BASE_URL,
        model: env.OLLAMA_EMBEDDING_MODEL
      }
    });
  let coordinator = options.coordinator;
  let knowledgeIndexingService: KnowledgeIndexingService | undefined;
  let knowledgeRetriever: KnowledgeRetriever | undefined;
  let knowledgeStore: PostgresAgentStore | undefined;
  let knowledgeIndexQueue: KnowledgeIndexQueue | undefined;

  if (!coordinator) {
    const agentStore = await PostgresAgentStore.create({
      connectionString: options.databasePath ?? env.DATABASE_URL,
      ...(env.AGENT_EMBEDDING_DIMENSION ? { vectorDimension: env.AGENT_EMBEDDING_DIMENSION } : {})
    });
    knowledgeStore = agentStore;
    knowledgeIndexingService = new KnowledgeIndexingService({
      store: agentStore,
      embeddingService
    });
    knowledgeRetriever = new KnowledgeRetriever({
      store: agentStore,
      embeddingService
    });
    // 同一个 registry 同时服务两条路径：
    // 1. getDefinitions() 给 LLM 看有哪些工具；
    // 2. ToolExecutor 执行时按 toolName 找到真实工具。
    const toolRegistry = createDefaultToolRegistry({
      tavilyApiKey: env.TAVILY_API_KEY,
      searchMaxResults: env.SEARCH_MAX_RESULTS,
      knowledgeRetriever,
      jimengImage: {
        accessKeyId: env.VOLCENGINE_ACCESS_KEY_ID,
        secretAccessKey: env.VOLCENGINE_SECRET_ACCESS_KEY
      },
      jimengImageEdit: {
        accessKeyId: env.VOLCENGINE_ACCESS_KEY_ID,
        secretAccessKey: env.VOLCENGINE_SECRET_ACCESS_KEY,
        uploadDirectory
      },
      jimengVideo: {
        accessKeyId: env.VOLCENGINE_ACCESS_KEY_ID,
        secretAccessKey: env.VOLCENGINE_SECRET_ACCESS_KEY,
        uploadDirectory
      }
    });
    const toolExecutor = new ToolExecutor({
      registry: toolRegistry,
      timeoutMs: env.AGENT_TOOL_TIMEOUT_MS,
      accessPolicy: toolAccessPolicy
    });

    const agentService =
      options.agentService ??
      new LangChainAgentService({
        model: createLlmModelFromEnv(env),
        toolRegistry,
        toolAccessPolicy,
        toolExecutor,
        defaultMaxIterations: env.AGENT_MAX_ITERATIONS
      });

    const agentEventLogger =
      options.agentEventLogger ??
      new JsonlAgentEventLogger(resolve(options.agentEventLogPath ?? env.AGENT_EVENT_LOG_PATH));
    let redisRuntime: RedisRuntime | undefined;
    let runQueueClient: { close(): Promise<void> } | undefined;
    let knowledgeQueueClient: { close(): Promise<void> } | undefined;

    // 产品运行时固定用 Redis/BullMQ 做跨进程协调；内存实现只通过 BuildAppOptions 注入给单元测试。
    // 这里一次性创建 RedisRuntime，是为了让 API、SSE 和 Worker 共享同一套连接生命周期：
    // - commandClient 处理 running draft、cancel key、run lock；
    // - eventPublisher/eventSubscriber 专门给 Pub/Sub 使用，避免订阅连接阻塞普通命令；
    // - BullMQ 自己接收 connection options，它内部会管理队列连接。
    if (!options.runningStateStore || !options.eventBus || !options.cancellationStore || !options.runLock) {
      redisRuntime = createRedisRuntime({
        url: env.REDIS_URL,
        onError: (error) => {
          app.log.warn({ error }, "redis runtime error");
        }
      });
    }

    const runningStateStore =
      options.runningStateStore ??
      new RedisRunningMessageStateStore({
        client: redisRuntime!.commandClient,
        keyPrefix: env.AGENT_RUNNING_STATE_REDIS_KEY_PREFIX,
        ttlSeconds: env.AGENT_RUNNING_STATE_TTL_SECONDS
      });
    const eventBus =
      options.eventBus ??
      new RedisAgentEventBus({
        publisher: redisRuntime!.eventPublisher,
        subscriber: redisRuntime!.eventSubscriber,
        keyPrefix: env.AGENT_RUNNING_STATE_REDIS_KEY_PREFIX
      });
    // eventBus 只做 live fanout，不做可靠回放。SSE 建连时先从 SQLite/run snapshot 补当前状态，
    // 再通过 Redis Pub/Sub 接 Worker 后续发布的事件。
    // API 进程只负责接请求和 SSE，不直接长期执行模型调用。runQueue 把“要执行哪个 run”
    // 交给 Worker；payload 只放 id，Worker 再从 SQLite 读取最新上下文，避免队列里的大对象过期。
    const runQueue =
      options.runQueue ??
      (() => {
        const queueClient = new Queue<AgentRunJobPayload, unknown, typeof agentRunJobName>(env.AGENT_QUEUE_NAME, {
          connection: toBullMqRedisConnectionOptions(env.REDIS_URL)
        });
        runQueueClient = queueClient;
        return new BullMqAgentRunQueue({ queue: queueClient as AgentRunQueueClient });
      })();
    knowledgeIndexQueue =
      options.knowledgeIndexQueue ??
      (options.runQueue
        ? new NoopKnowledgeIndexQueue()
        : (() => {
            const queueClient = new Queue<KnowledgeIndexJobPayload>(env.AGENT_QUEUE_NAME, {
              connection: toBullMqRedisConnectionOptions(env.REDIS_URL)
            });
            knowledgeQueueClient = queueClient;
            return new BullMqKnowledgeIndexQueue({ queue: queueClient });
          })());
    // 取消和锁都按 run 维度存 Redis。这样即使 API 和 Worker 不在同一个 Node 进程，
    // API 写入的取消信号、Worker 抢到的执行锁也能被另一边看到。
    const cancellationStore =
      options.cancellationStore ??
      new RedisAgentCancellationStore({
        client: redisRuntime!.commandClient,
        keyPrefix: env.AGENT_RUNNING_STATE_REDIS_KEY_PREFIX,
        ttlSeconds: env.AGENT_CANCEL_TTL_SECONDS
      });
    const runLock =
      options.runLock ??
      new RedisAgentRunLock({
        client: redisRuntime!.commandClient as unknown as RedisRunLockClient,
        keyPrefix: env.AGENT_RUNNING_STATE_REDIS_KEY_PREFIX,
        ttlSeconds: env.AGENT_RUN_LOCK_TTL_SECONDS
      });
    const toolResourceStorage =
      options.toolResourceStorage ??
      new LocalToolResourceStorage({
        uploadDirectory,
        publicBaseUrl,
        maxBytes: env.AGENT_TOOL_RESOURCE_MAX_BYTES,
        timeoutMs: env.AGENT_TOOL_RESOURCE_DOWNLOAD_TIMEOUT_MS
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
      runningStateStore,
      toolResourceStorage,
      {
        eventBus,
        runQueue,
        cancellationStore,
        runLock,
        agentEventLogger
      }
    );
    (app as typeof app & { agentCoordinator?: AgentMessageCoordinator }).agentCoordinator = coordinator;
    (app as typeof app & { knowledgeIndexingService?: KnowledgeIndexingService }).knowledgeIndexingService = knowledgeIndexingService;

    app.addHook("onClose", async () => {
      await coordinator?.shutdown("服务关闭");
      // 关闭顺序从“还可能产生任务/事件的上层”到“底层连接”：先停 queue，再断 Redis，最后关 SQLite。
      await runQueueClient?.close();
      await knowledgeQueueClient?.close();
      redisRuntime?.close();
      await agentStore.close();
    });
  }

  const staleCleanup = options.skipStaleCleanup ? undefined : await coordinator.cleanupStaleRunningExecutions();

  if (
    staleCleanup &&
    (staleCleanup.runs > 0 ||
      staleCleanup.messages > 0 ||
      staleCleanup.toolCalls > 0 ||
      staleCleanup.resources > 0 ||
      staleCleanup.processSteps > 0)
  ) {
    app.log.warn(staleCleanup, "stale agent running executions marked failed");
  }

  await registerHealthRoutes(app);
  await registerAgentRoutes(app, coordinator, { uploadDirectory });
  if (knowledgeStore && knowledgeRetriever) {
    await registerKnowledgeRoutes(app, {
      uploadDirectory,
      store: knowledgeStore,
      indexQueue: knowledgeIndexQueue!,
      retriever: knowledgeRetriever
    });
  }

  return app;
}
