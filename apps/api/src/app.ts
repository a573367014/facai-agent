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
  const agentService =
    options.agentService ??
    new AgentService({
      provider: new OpenAiCompatibleProvider({
        apiKey: env.OPENAI_API_KEY ?? "",
        baseUrl: env.OPENAI_BASE_URL,
        model: env.OPENAI_MODEL ?? ""
      }),
      toolRegistry: createDefaultToolRegistry(),
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
