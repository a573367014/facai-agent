import { AppError } from "./app-error.js";

export const redisRuntimeUnavailableMessage = "运行时依赖 Redis 暂不可用，请确认 Redis 已启动并检查 REDIS_URL。";

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

export function toRuntimeDependencyAppError(error: unknown): AppError | undefined {
  if (!isRuntimeDependencyError(error)) {
    return undefined;
  }

  return new AppError("RUNTIME_DEPENDENCY_ERROR", redisRuntimeUnavailableMessage, 503);
}
