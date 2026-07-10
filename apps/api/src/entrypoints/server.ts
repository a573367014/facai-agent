/**
 * API 进程入口
 *
 * 职责：作为 HTTP 服务的进程启动点。负责加载环境变量、初始化可观测性（OTel）、
 * 构建 Fastify 应用并监听端口；同时注册优雅停机逻辑（SIGINT/SIGTERM）。
 *
 * 边界：
 * - 本文件只做"进程级"的启动与停机编排，不含任何业务逻辑。
 * - 业务路由、插件、运行时容器的装配全部委托给 buildApp（见 app.ts）。
 */
import { config } from "dotenv";

// 加载环境变量：先加载仓库根的 .env（pnpm workspace 下相对 apps/api 上溯两级），
// 再加载默认 .env 兜底。已存在的变量不会被后加载的覆盖。
config({ path: "../../.env" });
config();

import { setupObservability } from "../platform/observability/otel.js";

// 初始化 OpenTelemetry：必须在引入业务模块、执行业务逻辑前调用，
// 以便 SDK 能 patch 运行时 API（如 http、pg 驱动）完成自动埋点。
setupObservability({
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318",
  serviceName: "agent-api"
});

import { buildApp } from "../bootstrap/app.js";
import { loadEnv } from "../platform/config/env.js";

const env = loadEnv();
const app = await buildApp();

// 幂等停机标志：防止重复信号触发二次关闭、中断正在进行的清理流程。
let isShuttingDown = false;

/**
 * 优雅停机：收到信号后调用 app.close()，触发所有 onClose 钩子
 * （释放运行时资源、关闭数据库/Redis 连接），完成后退出进程。
 *
 * 为什么需要幂等守卫：K8s 滚动更新或用户连按 Ctrl+C 会发出多次终止信号，
 * 若不加保护，第二次信号会在第一次清理未完成时再次进入 close，可能引发
 * 资源重复释放或竞态。这里用 isShuttingDown 让后续信号被直接忽略。
 *
 * @param signal 触发停机的信号（SIGINT / SIGTERM）
 */
async function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  app.log.info({ signal }, "received shutdown signal");

  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ error, signal }, "failed to close app during shutdown");
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

// 开始监听端口。顶层的 await 使进程在此常驻，直到收到停机信号触发 shutdown。
await app.listen({
  port: env.PORT,
  host: env.HOST
});
