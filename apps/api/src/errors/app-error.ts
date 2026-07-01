export type AppErrorCode =
  | "VALIDATION_ERROR"
  | "RUNTIME_DEPENDENCY_ERROR"
  | "PROVIDER_ERROR"
  | "PROVIDER_BAD_RESPONSE"
  | "TOOL_NOT_FOUND"
  | "TOOL_ARGUMENT_INVALID"
  | "TOOL_INVALID_ARGUMENTS"
  | "TOOL_TIMEOUT"
  | "TOOL_PERMISSION_DENIED"
  | "TOOL_EXECUTION_ERROR"
  | "AGENT_MAX_ITERATIONS";

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly statusCode = 500
  ) {
    super(message);
    this.name = "AppError";
  }
}
