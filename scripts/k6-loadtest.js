/**
 * k6 压测脚本 — agent 全链路压测
 *
 * 两种模式（通过 MODE 环境变量切换）：
 *
 * 1. MODE=ingress  只压 API 入口（发请求不等 worker 完成）
 *    测 agent-api 能承受多少 QPS（DB 写入 + BullMQ 入队）
 *
 * 2. MODE=e2e      全链路压测（发请求 + 轮询直到 run 完成）
 *    测系统整体吞吐（API + Redis + worker + DB + Mock LLM）
 *
 * 使用方法：
 *   k6 run scripts/k6-loadtest.js                          # 默认 e2e 模式
 *   MODE=ingress k6 run scripts/k6-loadtest.js             # ingress 模式
 *   BASE_URL=http://localhost:4001 k6 run scripts/k6-loadtest.js
 *
 * 前置条件：
 *   1. Mock LLM Server 已启动（pnpm mock:llm）
 *   2. dev 服务已用 mock 配置启动（OPENAI_BASE_URL=http://localhost:8088 pnpm dev）
 *   3. 已安装 k6（brew install k6）
 */
import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:4001";
const MODE = __ENV.MODE || "e2e";

export const options = {
  // 阶梯加压：逐步增加并发，观察拐点
  stages: [
    { duration: "30s", target: 5 }, // 阶段1：5 并发
    { duration: "1m", target: 10 }, // 阶段2：10 并发
    { duration: "1m", target: 20 }, // 阶段3：20 并发
    { duration: "30s", target: 0 }, // 回落
  ],
  thresholds: {
    // 错误率必须 < 5%
    http_req_failed: ["rate<0.05"],
  },
};

export default function () {
  // 1. 创建 session
  const sessionRes = http.post(
    `${BASE_URL}/agents/sessions`,
    JSON.stringify({}),
    { headers: { "Content-Type": "application/json" } }
  );

  check(sessionRes, {
    "session created": (r) => r.status === 201,
  });

  const sessionId = sessionRes.json("session.id");
  if (!sessionId) {
    console.error(`创建 session 失败: ${sessionRes.status} ${sessionRes.body}`);
    return;
  }

  // 2. 发消息启动 run
  const runRes = http.post(
    `${BASE_URL}/agents/sessions/${sessionId}/runs`,
    JSON.stringify({ input: "你好，这是压测消息" }),
    { headers: { "Content-Type": "application/json" } }
  );

  check(runRes, {
    "run accepted": (r) => r.status === 202,
    "has runId": (r) => r.json("run.id") !== undefined,
  });

  // ingress 模式：只测 API 入口，不等 worker 完成
  if (MODE === "ingress") {
    sleep(1);
    return;
  }

  // e2e 模式：轮询直到 run 完成
  const runId = runRes.json("run.id");
  let status = "running";
  let attempts = 0;
  const maxAttempts = 120; // 最多等 60 秒（每 0.5s 轮询一次）

  while (status === "running" && attempts < maxAttempts) {
    sleep(0.5);
    const statusRes = http.get(`${BASE_URL}/agents/runs/${runId}`);
    if (statusRes.status === 200) {
      status = statusRes.json("run.status");
    } else {
      // 请求失败，可能是 run 已过期，退出轮询
      break;
    }
    attempts++;
  }

  check(status, {
    "run completed": (s) => s === "completed",
  });

  if (status !== "completed") {
    console.warn(`run ${runId} 最终状态: ${status}（轮询 ${attempts} 次）`);
  }
}

// 压测结束时输出摘要
export function handleSummary(data) {
  const opts = data.options;
  const metrics = data.metrics;

  const summary = {
    mode: MODE,
    total_requests: metrics.http_reqs.values.count,
    avg_duration_ms: (metrics.http_req_duration.values.avg * 1000).toFixed(1),
    p50_duration_ms: (metrics.http_req_duration.values["p(50)"] * 1000).toFixed(1),
    p90_duration_ms: (metrics.http_req_duration.values["p(90)"] * 1000).toFixed(1),
    p99_duration_ms: (metrics.http_req_duration.values["p(99)"] * 1000).toFixed(1),
    failed_requests: metrics.http_req_failed.values.passes,
    error_rate: (metrics.http_req_failed.values.rate * 100).toFixed(2) + "%",
    vus_max: metrics.vus_max.values.max,
    iterations: metrics.iterations.values.count,
  };

  console.log("\n========== 压测摘要 ==========");
  console.log(`模式: ${summary.mode}`);
  console.log(`总请求数: ${summary.total_requests}`);
  console.log(`迭代次数: ${summary.iterations}`);
  console.log(`最大并发: ${summary.vus_max}`);
  console.log(`平均延迟: ${summary.avg_duration_ms}ms`);
  console.log(`P50: ${summary.p50_duration_ms}ms`);
  console.log(`P90: ${summary.p90_duration_ms}ms`);
  console.log(`P99: ${summary.p99_duration_ms}ms`);
  console.log(`失败请求: ${summary.failed_requests}`);
  console.log(`错误率: ${summary.error_rate}`);
  console.log("==============================\n");

  return {};
}
