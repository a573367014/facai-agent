/**
 * 运行时依赖错误识别与转换。
 *
 * 职责：把底层基础设施（主要是 Redis，也覆盖通用网络错误）抛出的异构错误，
 * 识别为「运行时依赖不可用」这一语义，并转换为统一的 AppError(503)。
 * 边界：只做「识别 + 转换」，不做重试、不做降级逻辑、不直接处理错误恢复。
 * 不这么做会怎样：Redis 断连时抛出的 MaxRetriesPerRequestError / ECONNREFUSED
 * 会以 500 暴露给前端，前端无法区分「服务自身 bug」与「依赖暂时不可用」，
 * 也就无法做合理的重试提示。映射成 503 后，前端可按「服务降级」语义处理。
 */
import { AppError } from "./app-error.js";

export const redisRuntimeUnavailableMessage = "运行时依赖 Redis 暂不可用，请确认 Redis 已启动并检查 REDIS_URL。";

/**
 * 判断一个未知错误是否属于「运行时依赖不可用」。
 *
 * 为什么用多重启发式而非 instanceof：底层错误来源多样——ioredis 自有错误类、
 * Node 原生网络错误（ECONNREFUSED/ETIMEDOUT/ENOTFOUND）、甚至被包装后的对象，
 * 无法用一个基类覆盖。因此从 error.name、error.code、message 关键词三个维度交叉判断，
 * 宁可多识别也不漏识别（漏识别会导致 503 降级失效）。
 * 为什么先排除非 Error：unknown 类型可能传入字符串/null，直接访问属性会抛异常。
 */
export function isRuntimeDependencyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const maybeErrorWithCode = error as Error & { code?: string };
  const message = error.message.toLowerCase();

  return (
    error.name === "MaxRetriesPerRequestError" ||
    maybeErrorWithCode.code === "ECONNREFUSED" ||
    maybeErrorWithCode.code === "ETIMEDOUT" ||
    maybeErrorWithCode.code === "ENOTFOUND" ||
    message.includes("max retries per request") ||
    message.includes("redis")
  );
}

/**
 * 将运行时依赖错误转换为 AppError；非该类错误返回 undefined。
 *
 * 返回 undefined 而非抛异常：调用方常在 catch 链里「尝试转换」，转换失败说明
 * 不是依赖类错误，应继续走原有错误处理路径。用 undefined 让调用方用 ?? 链式处理，
 * 避免强制 try/catch 嵌套。503 表示 Service Unavailable，语义上即「临时不可用，稍后重试」。
 */
export function toRuntimeDependencyAppError(error: unknown): AppError | undefined {
  if (!isRuntimeDependencyError(error)) {
    return undefined;
  }

  return new AppError("RUNTIME_DEPENDENCY_ERROR", redisRuntimeUnavailableMessage, 503);
}
