import { config } from "dotenv";

config({ path: "../../.env" });
config();

import { setupObservability } from "./observability/otel.js";

setupObservability({
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318",
  serviceName: "agent-worker"
});

import { Worker } from "bullmq";
import { buildApp, type AgentRuntimeFastifyInstance } from "./app.js";
import { agentRunJobName, type AgentRunJobPayload } from "./agent/agent-run-queue.js";
import { loadEnv } from "./config/env.js";
import { knowledgeIndexJobName, type KnowledgeIndexJobPayload } from "./knowledge/knowledge-run-queue.js";
import { toBullMqRedisConnectionOptions } from "./redis/runtime.js";
import { runWithParentSpan } from "./observability/trace-context.js";

const env = loadEnv();

// Worker 复用 buildApp 的装配逻辑，是为了和 API 使用同一套 provider、tool registry、
// SQLite store、Redis runtime 和 coordinator。这里不监听 HTTP，只消费 BullMQ job。
// skipStaleCleanup 避免 API 和 Worker 启动时同时清理 running run，清理职责留给 API 启动阶段。
const app = (await buildApp({ skipStaleCleanup: true })) as AgentRuntimeFastifyInstance;
const coordinator = app.agentCoordinator;
const knowledgeIndexingService = app.knowledgeIndexingService;

if (!coordinator) {
  throw new Error("worker 启动失败：缺少 AgentMessageCoordinator");
}

if (!knowledgeIndexingService) {
  throw new Error("worker 启动失败：缺少 KnowledgeIndexingService");
}

type AgentWorkerJobPayload = AgentRunJobPayload | KnowledgeIndexJobPayload;

const worker = new Worker<AgentWorkerJobPayload>(
  env.AGENT_QUEUE_NAME,
  async (job) => {
    if (job.name === agentRunJobName) {
      // job.data 只是一组 id。真正执行前由 coordinator 从 SQLite 重新读取 run/message，
      // 再检查 cancel key 和 run lock，保证 Worker 拿到的是当前状态。
      const payload = job.data as AgentRunJobPayload;
      await runWithParentSpan(payload.traceContext ?? null, `agent.run ${payload.runId}`, () =>
        coordinator.executeQueuedRun(payload)
      );
      return;
    }

    if (job.name === knowledgeIndexJobName) {
      await knowledgeIndexingService.indexDocument((job.data as KnowledgeIndexJobPayload).documentId);
      return;
    }

    app.log.warn({ jobName: job.name, jobId: job.id }, "unknown agent queue job skipped");
  },
  {
    connection: toBullMqRedisConnectionOptions(env.REDIS_URL),
    concurrency: env.AGENT_WORKER_CONCURRENCY
  }
);

let isShuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  app.log.info({ signal }, "worker received shutdown signal");

  try {
    await worker.close();
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ error, signal }, "failed to close worker during shutdown");
    process.exit(1);
  }
}

process.once("SIGINT", (signal) => {
  void shutdown(signal);
});
process.once("SIGTERM", (signal) => {
  void shutdown(signal);
});

app.log.info(
  {
    queueName: env.AGENT_QUEUE_NAME,
    concurrency: env.AGENT_WORKER_CONCURRENCY
  },
  "agent worker started"
);
