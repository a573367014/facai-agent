/**
 * Worker 进程入口
 *
 * 职责：作为后台任务消费者的进程启动点。负责加载环境变量、初始化可观测性、
 * 装配运行时容器、创建 BullMQ Worker 消费 Agent run 与知识索引任务，
 * 并采集队列深度指标；同样注册优雅停机逻辑。
 *
 * 边界：
 * - 与 server.ts 平级但职责互补：server 处理 HTTP 请求并把耗时任务入队，
 *   worker 从队列取出任务实际执行（调用 LLM、工具、写库）。
 * - 本文件不创建 Fastify、不注册 HTTP 路由或鉴权。
 */
import { config } from "dotenv";

// 加载环境变量：先加载仓库根的 .env（pnpm workspace 下相对 apps/api 上溯两级），
// 再加载默认 .env 兜底。已存在的变量不会被后加载的覆盖。
config({ path: "../../.env" });
config();

import { setupObservability } from "../platform/observability/otel.js";

// 初始化 OpenTelemetry：必须在引入业务模块、执行业务逻辑前调用，
// 以便 SDK 能 patch 运行时 API（如 pg 驱动、Redis 客户端）完成自动埋点。
setupObservability({
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318",
  serviceName: "agent-worker"
});

import { Worker, Queue } from "bullmq";
import { resolve } from "node:path";
import { createWorkerRuntimeContainer } from "../bootstrap/runtime-container.js";
import { agentRunJobName, type AgentRunJobPayload } from "../modules/agent/agent-run-queue.js";
import { knowledgeIndexJobName, type KnowledgeIndexJobPayload } from "../modules/knowledge/knowledge-run-queue.js";
import { loadEnv } from "../platform/config/env.js";
import { getMeter } from "../platform/observability/otel.js";
import { runWithParentSpan } from "../platform/observability/trace-context.js";
import { toBullMqRedisConnectionOptions } from "../platform/redis/runtime.js";

const env = loadEnv();
// Worker 进程不使用 pino，直接用 console 输出。
// 这里保持与 RuntimeLogger 兼容的最小接口，供运行时容器上报事件。
const logger = {
  info(bindings: Record<string, unknown>, message: string) {
    console.info(message, bindings);
  },
  warn(bindings: Record<string, unknown>, message: string) {
    console.warn(message, bindings);
  },
  error(bindings: Record<string, unknown>, message: string) {
    console.error(message, bindings);
  }
};

// Worker 只装配执行 Agent/Knowledge job 需要的运行时。它不创建 Fastify，
// 也不注册鉴权、multipart、static、HTTP routes 或 request hooks。
const runtimeContainer = await createWorkerRuntimeContainer({
  env,
  logger,
  uploadDirectory: resolve(env.AGENT_UPLOAD_DIR)
});
const { coordinator, knowledgeIndexingService } = runtimeContainer;

// Worker 同时消费两种 job（Agent 运行 / 知识索引），统一到一个联合类型便于 BullMQ 的泛型签名。
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

    logger.warn({ jobName: job.name, jobId: job.id }, "unknown agent queue job skipped");
  },
  {
    connection: toBullMqRedisConnectionOptions(env.REDIS_URL),
    concurrency: env.AGENT_WORKER_CONCURRENCY
  }
);

// ── 队列深度监控 ──────────────────────────────────────────────
// 每 10 秒采集 BullMQ 队列状态，上报为 OTel 自定义指标。
// 在 Grafana (Prometheus) 里可查：
//   bullmq_jobs_waiting   — 等待中的 job 数（堆积量）
//   bullmq_jobs_active    — 正在处理的 job 数
//   bullmq_jobs_failed    — 失败的 job 数
const monitorQueue = new Queue(env.AGENT_QUEUE_NAME, {
  connection: toBullMqRedisConnectionOptions(env.REDIS_URL)
});
const meter = getMeter("agent-worker");
const jobsWaiting = meter.createObservableGauge("bullmq_jobs_waiting", {
  description: "BullMQ 等待中的 job 数量"
});
const jobsActive = meter.createObservableGauge("bullmq_jobs_active", {
  description: "BullMQ 正在处理的 job 数量"
});
const jobsFailed = meter.createObservableGauge("bullmq_jobs_failed", {
  description: "BullMQ 失败的 job 数量"
});

// 用一个可变快照桥接"定时采集"与"指标回调采集"两个异步周期：
// 定时器每 10s 写入最新值，OTel 导出时通过回调读取该值。
let lastCounts = { waiting: 0, active: 0, failed: 0 };

jobsWaiting.addCallback((result) => {
  result.observe(lastCounts.waiting);
});
jobsActive.addCallback((result) => {
  result.observe(lastCounts.active);
});
jobsFailed.addCallback((result) => {
  result.observe(lastCounts.failed);
});

const queueMonitorTimer = setInterval(async () => {
  try {
    const counts = await monitorQueue.getJobCounts("waiting", "active", "failed");
    lastCounts = { waiting: counts.waiting, active: counts.active, failed: counts.failed };
  } catch (error) {
    logger.warn({ error }, "queue depth monitor: getJobCounts failed");
  }
}, 10000);
// unref：让该定时器不阻止进程退出——若它成为事件循环中唯一的句柄，进程仍可正常结束；
// 停机时由 shutdown 中的 clearInterval 显式清理。
queueMonitorTimer.unref();

// 幂等停机标志：防止重复信号触发二次关闭、中断正在进行的清理流程。
let isShuttingDown = false;

/**
 * 优雅停机：按依赖顺序关闭各组件——先停定时器，再停 Worker（停止消费新 job、
 * 等待在途 job 处理完），接着关队列监控连接，最后关运行时容器（释放 PG/Redis）。
 *
 * 顺序的意义：先停止"消费入口"避免新 job 进来，再释放底层连接，
 * 防止在途 job 写入已关闭的连接。isShuttingDown 守卫防止重复信号二次关闭。
 *
 * @param signal 触发停机的信号（SIGINT / SIGTERM）
 */
async function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info({ signal }, "worker received shutdown signal");

  try {
    clearInterval(queueMonitorTimer);
    await worker.close();
    await monitorQueue.close();
    await runtimeContainer.close("服务关闭");
    process.exit(0);
  } catch (error) {
    logger.error({ error, signal }, "failed to close worker during shutdown");
    process.exit(1);
  }
}

// 监听容器编排系统（K8s）的 SIGTERM 与手动 Ctrl+C 的 SIGINT。
// 用 once 而非 on：第一次信号进入优雅停机流程，避免每次信号都重复触发。
process.once("SIGINT", (signal) => {
  void shutdown(signal);
});
process.once("SIGTERM", (signal) => {
  void shutdown(signal);
});

logger.info(
  {
    queueName: env.AGENT_QUEUE_NAME,
    concurrency: env.AGENT_WORKER_CONCURRENCY
  },
  "agent worker started"
);
