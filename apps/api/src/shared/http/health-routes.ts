/**
 * 健康检查路由。
 *
 * 职责：向负载均衡器/容器编排（K8s liveness probe、Nginx upstream check 等）
 * 暴露一个极轻量的存活探针，只回答「进程是否在跑」。
 * 边界：只做存活检查（liveness），不做就绪检查（readiness）——
 * 不检查 Redis/S3/DB 等依赖是否可用，因为依赖不可用时应让探针失败触发重启，
 * 还是应让进程继续承载降级流量，是部署策略问题，不应耦合在此处。
 * 不这么做会怎样：把依赖检查塞进 /health，任一依赖抖动都会导致 Pod 被反复重启，
 * 造成雪崩。依赖就绪应放在独立的 /ready 路由。
 */
import type { FastifyInstance } from "fastify";

/**
 * 注册健康检查路由。
 *
 * 返回固定 { status: "ok" } 而非查询任何状态：存活探针要求「快且无副作用」，
 * 任何 IO 都会增加响应延迟，在编排器高频探测下放大为资源浪费。
 */
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok" }));
}
