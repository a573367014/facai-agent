/**
 * 运行时容器（Composition Root）
 *
 * 本文件是整个后端的"依赖注入组装中心"。系统里所有的基础设施组件——
 * PostgreSQL 持久层、Redis（运行状态 / 事件总线 / 取消信号 / 分布式锁）、
 * BullMQ 任务队列、S3 对象存储、LLM 模型、工具执行器——都在这里被实例化，
 * 并按依赖顺序拼装成一个 AgentRuntimeContainer，供 API 与 Worker 两种进程使用。
 *
 * 边界：
 * - 本文件只负责"创建与销毁运行时组件"，不含任何业务流程编排
 *   （业务编排由 AgentMessageCoordinator 等模块负责）。
 * - 通过 AgentRuntimeOverrides 允许调用方注入测试替身，使生产与测试共用
 *   同一套组装逻辑，避免测试时复制粘贴装配代码、产生分叉。
 */
import { mkdir } from "node:fs/promises";
import { Queue } from "bullmq";
import { OtelAgentEventLogger, type AgentEventLogger } from "../modules/agent/agent-event-logger.js";
import { RedisAgentCancellationStore, type AgentCancellationStore } from "../modules/agent/agent-cancellation-store.js";
import { RedisAgentEventBus, type AgentEventBus } from "../modules/agent/agent-event-bus.js";
import { AgentMessageCoordinator, type AgentRunner } from "../modules/agent/agent-message-coordinator.js";
import {
  agentRunJobName,
  BullMqAgentRunQueue,
  type AgentRunJobPayload,
  type AgentRunQueue,
  type AgentRunQueueClient
} from "../modules/agent/agent-run-queue.js";
import { RedisAgentRunLock, type AgentRunLock, type RedisRunLockClient } from "../modules/agent/agent-run-lock.js";
import { AgentSummaryService } from "../modules/agent/agent-summary-service.js";
import { AgentContextBuilder } from "../modules/agent/context-builder.js";
import { LocalUploadInputResourceResolver } from "../modules/agent/input-resource-resolver.js";
import type { RunningMessageStateStore } from "../modules/agent/running-message-state-store.js";
import { LangChainAgentService } from "../modules/agent/runtime/langchain-agent-service.js";
import { createLlmModelFromEnv } from "../modules/agent/runtime/model-factory.js";
import { LangChainProviderShim } from "../modules/agent/runtime/provider-shim.js";
import { S3ToolResourceStorage, type ToolResourceStorage } from "../modules/agent/tool-resource-storage.js";
import { createEmbeddingService, type EmbeddingService } from "../modules/knowledge/embedding-service.js";
import { KnowledgeIndexingService } from "../modules/knowledge/indexing-service.js";
import {
  BullMqKnowledgeIndexQueue,
  NoopKnowledgeIndexQueue,
  type KnowledgeIndexJobPayload,
  type KnowledgeIndexQueue
} from "../modules/knowledge/knowledge-run-queue.js";
import { KnowledgeRetriever } from "../modules/knowledge/retriever.js";
import { ToolAccessPolicy } from "../modules/tools/access-policy.js";
import { ToolExecutor } from "../modules/tools/executor.js";
import { createDefaultToolRegistry } from "../modules/tools/index.js";
import type { Env } from "../platform/config/env.js";
import { PostgresAgentStore } from "../platform/postgres/postgres-agent-store.js";
import { RedisRunningMessageStateStore } from "../platform/redis/redis-running-message-state-store.js";
import { createRedisRuntime, toBullMqRedisConnectionOptions, type RedisRuntime } from "../platform/redis/runtime.js";
import { initS3Storage } from "../platform/storage/s3-client.js";

/** 当前进程角色：api（HTTP 服务，可入队任务）或 worker（消费任务，禁止入队）。区分角色是为了让同一套组装逻辑适配两种进程。 */
type RuntimeProcess = "api" | "worker";

/**
 * 运行时所需的最小日志接口。
 *
 * 只暴露 warn 一个方法：容器内部需要上报的都是"非致命但需关注"的事件
 * （如 Redis 连接抖动）。刻意不绑定具体日志库，让上层（Fastify 的 pino / Worker 的 console）
 * 自行适配，保持本模块的纯净。
 */
export interface RuntimeLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

/**
 * 运行时组件覆盖项（主要用于测试注入替身）。
 *
 * 设计动机：集成测试常需用内存版 / mock 版的 store、queue、event bus 替换真实
 * Redis/Postgres 依赖，以降低环境要求并提速。只要传入全部 Redis 相关替身
 * （runningStateStore + eventBus + cancellationStore + runLock），容器就不会
 * 创建真实 Redis 连接（见 createAgentRuntimeContainer 中的惰性创建逻辑）。
 */
export interface AgentRuntimeOverrides {
  agentService?: AgentRunner;
  databasePath?: string;
  agentEventLogger?: AgentEventLogger;
  runningStateStore?: RunningMessageStateStore;
  eventBus?: AgentEventBus;
  runQueue?: AgentRunQueue;
  knowledgeIndexQueue?: KnowledgeIndexQueue;
  embeddingService?: EmbeddingService;
  cancellationStore?: AgentCancellationStore;
  runLock?: AgentRunLock;
  toolResourceStorage?: ToolResourceStorage;
}

export interface RuntimeContainerOptions extends AgentRuntimeOverrides {
  env: Env;
  logger: RuntimeLogger;
  uploadDirectory: string;
  storageInitialized?: boolean;
}

interface CreateAgentRuntimeContainerOptions extends RuntimeContainerOptions {
  process: RuntimeProcess;
}

/**
 * 组装完成的运行时容器。
 *
 * 对外暴露的表面：消息编排核心 coordinator、知识库索引/检索服务、知识库存储，
 * 以及幂等的 close 方法。其余组件（queue、redis、lock 等）作为内部实现细节被封装，
 * 调用方无需感知，关闭时由 close 统一释放。
 */
export interface AgentRuntimeContainer {
  coordinator: AgentMessageCoordinator;
  knowledgeIndexingService: KnowledgeIndexingService;
  knowledgeRetriever: KnowledgeRetriever;
  knowledgeStore: PostgresAgentStore;
  knowledgeIndexQueue?: KnowledgeIndexQueue;
  close(reason?: string): Promise<void>;
}

interface CloseableQueue {
  close(): Promise<void>;
}

/**
 * Worker 进程专用的"只读"队列占位实现。
 *
 * 为什么需要它：Worker 是消费者而非生产者，绝不应 enqueue 新任务，但
 * AgentMessageCoordinator 的构造签名要求传入一个 queue 依赖。这里给一个
 * enqueue 必抛错的实现，比传 null/undefined 更安全——一旦代码误在 worker 侧
 * 调用 enqueue，会立即在开发阶段抛错暴露 bug，而不是静默丢任务。
 */
const workerExecutionQueue: AgentRunQueue = {
  async enqueueRun() {
    throw new Error("Worker runtime cannot enqueue agent runs");
  }
};

/**
 * 初始化运行时所需的存储后端：本地上传目录 + S3 桶。
 *
 * 在容器组装前调用，确保后续组件（如 S3ToolResourceStorage）可用。
 * mkdir 的 recursive 选项保证幂等；S3 初始化负责桶的存在性校验。
 */
export async function initializeAgentRuntimeStorage(env: Env, uploadDirectory: string): Promise<void> {
  await mkdir(uploadDirectory, { recursive: true });
  await initS3Storage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    publicBaseUrl: env.S3_PUBLIC_BASE_URL
  });
}

/**
 * 创建 API 进程的运行时容器。
 * API 角色会创建可入队的真实 BullMQ Queue 客户端（生产者）。
 */
export function createApiRuntimeContainer(options: RuntimeContainerOptions): Promise<AgentRuntimeContainer> {
  return createAgentRuntimeContainer({ ...options, process: "api" });
}

/**
 * 创建 Worker 进程的运行时容器。
 * Worker 角色使用 workerExecutionQueue 占位（禁止入队），且不创建 knowledge 队列客户端句柄。
 */
export function createWorkerRuntimeContainer(options: RuntimeContainerOptions): Promise<AgentRuntimeContainer> {
  return createAgentRuntimeContainer({ ...options, process: "worker" });
}

/**
 * 核心组装函数：按依赖顺序实例化并连接所有运行时组件。
 *
 * 关键设计点：
 * 1. Redis 连接惰性创建——仅当调用方未提供全部 Redis 相关替身时才打开真实连接，
 *    避免纯单元测试场景下无谓占用连接资源。
 * 2. 进程角色分流——runQueue / knowledgeIndexQueue 根据 process 决定创建真实
 *    客户端还是占位实现。
 * 3. 失败回滚——组装过程中任意步骤抛错，会清理已创建的资源（连接、队列等），防止泄漏。
 * 4. close 幂等——返回的 close 方法内部缓存 Promise，多次调用只执行一次清理。
 *
 * @returns 组装完成的运行时容器
 */
async function createAgentRuntimeContainer(
  options: CreateAgentRuntimeContainerOptions
): Promise<AgentRuntimeContainer> {
  const { env } = options;
  // app.ts 在注册 multipart/static 插件前可能已调用过 initializeAgentRuntimeStorage，
  // 这里通过标志位避免重复初始化 S3（重复创建桶客户端是无意义开销）。
  if (!options.storageInitialized) {
    await initializeAgentRuntimeStorage(env, options.uploadDirectory);
  }

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
  const agentStore = await PostgresAgentStore.create({
    connectionString: options.databasePath ?? env.DATABASE_URL
  });
  let redisRuntime: RedisRuntime | undefined;
  let runQueueClient: CloseableQueue | undefined;
  let knowledgeQueueClient: CloseableQueue | undefined;
  let coordinator: AgentMessageCoordinator | undefined;

  try {
    const knowledgeIndexingService = new KnowledgeIndexingService({
      store: agentStore,
      embeddingService
    });
    const knowledgeRetriever = new KnowledgeRetriever({
      store: agentStore,
      embeddingService
    });
    const toolRegistry = createDefaultToolRegistry({
      tavilyApiKey: env.TAVILY_API_KEY,
      searchMaxResults: env.SEARCH_MAX_RESULTS,
      knowledgeRetriever,
      jimengImage: {
        accessKeyId: env.VOLCENGINE_ACCESS_KEY_ID,
        secretAccessKey: env.VOLCENGINE_SECRET_ACCESS_KEY,
        uploadDirectory: options.uploadDirectory
      },
      jimengImageEdit: {
        accessKeyId: env.VOLCENGINE_ACCESS_KEY_ID,
        secretAccessKey: env.VOLCENGINE_SECRET_ACCESS_KEY,
        uploadDirectory: options.uploadDirectory
      },
      jimengVideo: {
        accessKeyId: env.VOLCENGINE_ACCESS_KEY_ID,
        secretAccessKey: env.VOLCENGINE_SECRET_ACCESS_KEY,
        uploadDirectory: options.uploadDirectory
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
    const agentEventLogger = options.agentEventLogger ?? new OtelAgentEventLogger();
    // 仅当调用方没有提供"全部"Redis 依赖替身时，才创建真实 Redis 连接。
    // 这样单元测试传入内存版 store/bus/lock 后，容器完全不触碰 Redis，
    // 既加快测试又避免需要测试环境跑 Redis。
    if (!options.runningStateStore || !options.eventBus || !options.cancellationStore || !options.runLock) {
      redisRuntime = createRedisRuntime({
        url: env.REDIS_URL,
        onError: (error) => {
          options.logger.warn({ error }, "redis runtime error");
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
    // 运行队列策略按进程角色分流：
    // - 优先使用调用方注入的 runQueue（测试场景）
    // - worker：用抛错的占位实现，禁止入队（消费者不应生产）
    // - api：创建真实 BullMQ Queue 客户端，并把句柄存入 runQueueClient 供关闭时释放
    const runQueue =
      options.runQueue ??
      (options.process === "worker"
        ? workerExecutionQueue
        : (() => {
            const queueClient = new Queue<AgentRunJobPayload, unknown, typeof agentRunJobName>(env.AGENT_QUEUE_NAME, {
              connection: toBullMqRedisConnectionOptions(env.REDIS_URL)
            });
            runQueueClient = queueClient;
            return new BullMqAgentRunQueue({ queue: queueClient as AgentRunQueueClient });
          })());
    // 知识索引队列策略：
    // - worker：不需要索引队列句柄（知识索引 job 由 worker 直接处理）
    // - api 且调用方已注入 runQueue（测试场景）：用 Noop 队列，避免打开真实 Redis 连接
    // - api 生产：创建真实 BullMQ 客户端
    const knowledgeIndexQueue =
      options.knowledgeIndexQueue ??
      (options.process === "worker"
        ? undefined
        : options.runQueue
          ? new NoopKnowledgeIndexQueue()
          : (() => {
              const queueClient = new Queue<KnowledgeIndexJobPayload>(env.AGENT_QUEUE_NAME, {
                connection: toBullMqRedisConnectionOptions(env.REDIS_URL)
              });
              knowledgeQueueClient = queueClient;
              return new BullMqKnowledgeIndexQueue({ queue: queueClient });
            })());
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
      new S3ToolResourceStorage({
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
      // 若注入了自定义 agentService（测试场景），则不创建摘要服务——
      // 摘要服务依赖真实 LLM provider，测试中通常不需要且会拖慢测试。
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
        agentEventLogger,
        inputResourceResolver: new LocalUploadInputResourceResolver({ uploadDirectory: options.uploadDirectory })
      }
    );

    // close 做成幂等：把清理 Promise 缓存到闭包变量，
    // 即使外部多次调用 close（如 app onClose 钩子 + 进程退出钩子重叠）也只执行一次。
    let closePromise: Promise<void> | undefined;
    const close = async (reason = "服务关闭") => {
      if (!closePromise) {
        closePromise = closeRuntimeResources({
          coordinator,
          runQueueClient,
          knowledgeQueueClient,
          redisRuntime,
          agentStore,
          reason
        });
      }
      await closePromise;
    };

    return {
      coordinator,
      knowledgeIndexingService,
      knowledgeRetriever,
      knowledgeStore: agentStore,
      knowledgeIndexQueue,
      close
    };
  } catch (error) {
    // 组装中途失败时，必须清理已创建的连接/队列，否则会泄漏 Redis 连接和 PG 连接池。
    // 清理本身若再失败只记录警告，不让清理错误掩盖原始的初始化错误。
    try {
      await closeRuntimeResources({
        coordinator,
        runQueueClient,
        knowledgeQueueClient,
        redisRuntime,
        agentStore,
        reason: "运行时初始化失败"
      });
    } catch (cleanupError) {
      options.logger.warn({ error: cleanupError }, "failed to close partially initialized runtime");
    }
    throw error;
  }
}

/**
 * 按依赖逆序关闭运行时资源。
 *
 * 关闭顺序的意义（见下方原英文注释）：先停止"生产者"（coordinator 不再产生新工作），
 * 再关闭它们依赖的连接（队列客户端、Redis），最后关闭持久层（PG store）。
 * 若反过来先关连接再停 coordinator，coordinator 可能仍在尝试写入已关闭的连接，
 * 导致难以诊断的错误。
 *
 * 容错策略：逐个执行，任一步抛错不中断后续步骤，最终只把第一个错误重新抛出。
 * 这样即使某个组件关闭失败，其他资源仍能被正确释放，避免"一个坏组件拖垮全部清理"。
 */
async function closeRuntimeResources(options: {
  coordinator?: AgentMessageCoordinator;
  runQueueClient?: CloseableQueue;
  knowledgeQueueClient?: CloseableQueue;
  redisRuntime?: RedisRuntime;
  agentStore: PostgresAgentStore;
  reason: string;
}): Promise<void> {
  // Stop work producers before their connections, then close persistence last.
  const steps: Array<() => void | Promise<void>> = [
    () => options.coordinator?.shutdown(options.reason),
    () => options.runQueueClient?.close(),
    () => options.knowledgeQueueClient?.close(),
    () => options.redisRuntime?.close(),
    () => options.agentStore.close()
  ];
  let firstError: unknown;

  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      firstError ??= error;
    }
  }

  if (firstError) {
    throw firstError;
  }
}
