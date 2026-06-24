import cors from "@fastify/cors";
import Fastify from "fastify";
import { AgentService } from "./agent/agent-service.js";
import { AgentRunCoordinator } from "./agent/run-coordinator.js";
import { InMemoryAgentRunStore } from "./agent/run-store.js";
import { SqliteAgentRunStore } from "./agent/sqlite-run-store.js";
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
  runCoordinator?: AgentRunCoordinator;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: ["http://localhost:4000", "http://127.0.0.1:4000"]
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

  const env = loadEnv();
  // 同一个 registry 同时服务两条路径：
  // 1. getDefinitions() 给 LLM 看有哪些工具；
  // 2. ToolExecutor 执行时按 toolName 找到真实工具。
  const toolRegistry = createDefaultToolRegistry({
    tavilyApiKey: env.TAVILY_API_KEY,
    searchMaxResults: env.SEARCH_MAX_RESULTS
  });
  // 当前先用 allow-list 做最小权限控制。未配置时 demo 仍开放所有默认工具；
  // 配了 AGENT_ALLOWED_TOOLS 后，LLM 只能看到这些工具，执行层也只允许这些工具。
  const toolAccessPolicy = new ToolAccessPolicy({ allowedToolNames: env.AGENT_ALLOWED_TOOLS });
  const agentService =
    options.agentService ??
    new AgentService({
      provider: new OpenAiCompatibleProvider({
        apiKey: env.OPENAI_API_KEY ?? "",
        baseUrl: env.OPENAI_BASE_URL,
        model: env.OPENAI_MODEL ?? ""
      }),
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
  let runCoordinator = options.runCoordinator;

  if (!runCoordinator) {
    const runStore =
      env.AGENT_STORE === "sqlite"
        ? await SqliteAgentRunStore.create({ databasePath: env.AGENT_SQLITE_PATH })
        : new InMemoryAgentRunStore();

    if (runStore instanceof SqliteAgentRunStore) {
      app.addHook("onClose", async () => {
        runStore.close();
      });
    }

    runCoordinator = new AgentRunCoordinator(agentService, runStore);
  }

  await registerHealthRoutes(app);
  await registerAgentRoutes(app, agentService, runCoordinator);

  return app;
}
