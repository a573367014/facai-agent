/**
 * Fastify 应用工厂
 *
 * 职责：创建并配置一个完整的 Fastify 应用实例——注册插件（CORS、multipart、static）、
 * 挂载鉴权守卫与路由、装配运行时容器、设置请求追踪钩子与全局错误处理器。
 *
 * 边界：
 * - 本文件不启动 HTTP 监听（那是 server.ts 的职责），只负责"组装好一个 app 实例"。
 * - 通过 skip* 系列选项支持测试场景：测试可跳过 Agent 运行时、鉴权、陈旧清理，
 *   只装配需要的子集，从而隔离测试关注点、避免拉起重型依赖。
 */
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { resolve } from "node:path";
import type { AgentMessageCoordinator } from "../modules/agent/agent-message-coordinator.js";
import { AuthTokenService } from "../modules/auth/auth-token-service.js";
import { registerAuthGuard } from "../modules/auth/auth-guard.js";
import { HttpGithubOAuthClient } from "../modules/auth/github-oauth-client.js";
import type { KnowledgeIndexingService } from "../modules/knowledge/indexing-service.js";
import { createCorsOriginChecker } from "../platform/config/cors.js";
import { loadEnv } from "../platform/config/env.js";
import { endRequestSpan, getRequestSpan, getRequestTraceparent, startRequestSpan } from "../platform/observability/trace-context.js";
import { PostgresUserStore } from "../platform/postgres/postgres-user-store.js";
import { MAX_ATTACHMENT_BYTES } from "../platform/storage/attachment-upload.js";
import { AppError } from "../shared/errors/app-error.js";
import { toRuntimeDependencyAppError } from "../shared/errors/runtime-dependency-error.js";
import { registerAgentRoutes } from "../modules/agent/http/agent-routes.js";
import { registerAuthRoutes, type RegisterAuthRoutesOptions } from "../modules/auth/http/auth-routes.js";
import { registerKnowledgeRoutes } from "../modules/knowledge/http/knowledge-routes.js";
import { registerHealthRoutes } from "../shared/http/health-routes.js";
import {
  createApiRuntimeContainer,
  initializeAgentRuntimeStorage,
  type AgentRuntimeOverrides
} from "./runtime-container.js";

/**
 * 构建 Fastify 应用的选项。
 *
 * 除透传 AgentRuntimeOverrides（测试替身）外，提供一组 skip* 开关：
 * 控制是否装配某块功能（Agent 运行时 / 鉴权 / 陈旧任务清理）。
 * 测试常利用这些开关只初始化被测模块，避免拉起整个 S3/PG/Redis 栈。
 */
export interface BuildAppOptions extends AgentRuntimeOverrides {
  coordinator?: AgentMessageCoordinator;
  uploadDirectory?: string;
  uploadResponseDelayMs?: number;
  skipStaleCleanup?: boolean;
  skipAgentRuntime?: boolean;
  skipAuth?: boolean;
  auth?: RegisterAuthRoutesOptions;
}

/**
 * 带运行时句柄扩展的 Fastify 实例类型。
 *
 * buildApp 会把 coordinator / knowledgeIndexingService 挂到 app 实例上，
 * 方便测试或外部代码在拿到 app 后直接访问运行时服务（如主动触发清理、注入断言）。
 */
export type AgentRuntimeFastifyInstance = Awaited<ReturnType<typeof buildApp>> & {
  agentCoordinator?: AgentMessageCoordinator;
  knowledgeIndexingService?: KnowledgeIndexingService;
};

/**
 * Fastify 应用工厂：创建、配置并返回一个可用的 app 实例。
 *
 * 装配顺序（顺序敏感）：
 * 1. CORS —— 必须最先注册，否则后续路由的预检（OPTIONS）请求可能被拒。
 * 2. 存储初始化 + multipart/static 插件 —— 文件上传功能依赖这两者就绪。
 * 3. 错误处理器 + 追踪钩子 —— 在路由注册前装好，确保所有请求都被覆盖。
 * 4. 鉴权路由 + 守卫 —— 守卫需在受保护路由之前注册。
 * 5. 运行时容器（coordinator）+ 业务路由 —— 最后挂载。
 *
 * @returns 配置完成的 Fastify 实例，调用方负责 listen（server.ts）或直接使用（测试）
 */
export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });
  const env = loadEnv();
  const isAllowedCorsOrigin = createCorsOriginChecker(env.CORS_ORIGINS);

  await app.register(cors, {
    // 动态校验来源：用 env.CORS_ORIGINS 白名单判断，返回 boolean 决定是否放行该 Origin。
    origin: (origin, callback) => {
      callback(null, isAllowedCorsOrigin(origin));
    }
  });

  const uploadDirectory = resolve(options.uploadDirectory ?? env.AGENT_UPLOAD_DIR);
  const publicBaseUrl = env.AGENT_PUBLIC_BASE_URL ?? `http://127.0.0.1:${env.PORT}`;
  // 仅在需要 Agent 运行时功能时才初始化存储与上传相关插件。
  // skipAgentRuntime 让纯鉴权 / 纯健康检查测试不必拉起 S3、PG、Redis。
  if (!options.skipAgentRuntime) {
    await initializeAgentRuntimeStorage(env, uploadDirectory);

    await app.register(multipart, {
      limits: {
        files: 1,
        fileSize: MAX_ATTACHMENT_BYTES
      }
    });

    await app.register(fastifyStatic, {
      root: uploadDirectory,
      prefix: "/uploads/"
    });
  }

  // 全局错误处理器：按错误类型分三层响应，确保客户端拿到结构化错误体而非堆栈。
  // 1. AppError —— 业务领域错误（如参数非法、未授权），沿用其自带的 statusCode/code。
  // 2. runtimeDependencyError —— 基础设施依赖故障（如 DB/Redis 不可达），转译为对外的标准错误。
  // 3. 兜底 —— 未知异常统一 500，避免内部错误细节泄露给客户端。
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

  // 响应结束时关闭 span（据此计算请求耗时并记录最终状态码）。
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

  let coordinator = options.coordinator;
  let runtimeContainer: Awaited<ReturnType<typeof createApiRuntimeContainer>> | undefined;

  // 鉴权装配：当未跳过鉴权、且显式传入了 auth 配置或需要 Agent 运行时时进行。
  // 若调用方未提供 userStore，则创建独立的 PostgresUserStore，并在 app 关闭时释放。
  if (!options.skipAuth && (options.auth || !options.skipAgentRuntime)) {
    const createdAuthUserStore = options.auth
      ? undefined
      : await PostgresUserStore.create({ connectionString: options.databasePath ?? env.DATABASE_URL });
    const authTokenService =
      options.auth?.tokenService ??
      new AuthTokenService({
        accessSecret: env.JWT_ACCESS_SECRET,
        refreshSecret: env.JWT_REFRESH_SECRET,
        accessTokenTtlSeconds: env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
        refreshTokenTtlSeconds: env.AUTH_REFRESH_TOKEN_TTL_SECONDS
      });
    await registerAuthRoutes(app, {
      userStore: options.auth?.userStore ?? createdAuthUserStore!,
      githubClient:
        options.auth?.githubClient ??
        new HttpGithubOAuthClient({
          clientId: env.GITHUB_OAUTH_CLIENT_ID,
          clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
          redirectUri: env.GITHUB_OAUTH_REDIRECT_URI
        }),
      tokenService: authTokenService
    });
    registerAuthGuard(app, { tokenService: authTokenService });
    app.addHook("onClose", async () => {
      await createdAuthUserStore?.close();
    });
  }

  // 装配 Agent 运行时容器并取出 coordinator。
  // 把 coordinator / knowledgeIndexingService 挂到 app 上供外部（测试）访问；
  // 注册 onClose 钩子确保 app.close() 时运行时资源被释放。
  if (!coordinator && !options.skipAgentRuntime) {
    runtimeContainer = await createApiRuntimeContainer({
      ...options,
      env,
      logger: {
        warn: (bindings, message) => {
          app.log.warn(bindings, message);
        }
      },
      uploadDirectory,
      storageInitialized: true
    });
    coordinator = runtimeContainer.coordinator;
    (app as typeof app & { agentCoordinator?: AgentMessageCoordinator }).agentCoordinator = coordinator;
    (app as typeof app & { knowledgeIndexingService?: KnowledgeIndexingService }).knowledgeIndexingService =
      runtimeContainer.knowledgeIndexingService;

    app.addHook("onClose", async () => {
      await runtimeContainer?.close("服务关闭");
    });
  }

  // 进程重启后的"僵尸清理"：上次进程若崩溃，会留下处于"运行中"状态的 run/message。
  // 这里在启动时把它们标记为失败，避免其永久卡在 running 状态、阻塞后续操作或误导用户。
  const staleCleanup =
    !coordinator || options.skipStaleCleanup ? undefined : await coordinator.cleanupStaleRunningExecutions();

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
  if (coordinator) {
    await registerAgentRoutes(app, coordinator, {
      uploadDirectory,
      publicBaseUrl,
      uploadResponseDelayMs: options.uploadResponseDelayMs ?? env.AGENT_UPLOAD_RESPONSE_DELAY_MS
    });
  }
  if (runtimeContainer?.knowledgeIndexQueue) {
    await registerKnowledgeRoutes(app, {
      uploadDirectory,
      store: runtimeContainer.knowledgeStore,
      indexQueue: runtimeContainer.knowledgeIndexQueue,
      retriever: runtimeContainer.knowledgeRetriever
    });
  }

  return app;
}
