/**
 * 统一应用错误类型。
 *
 * 职责：为整个 API 层提供唯一的、可携带「错误码 + HTTP 状态码」的错误基类。
 * 边界：只定义错误的结构与分类，不负责错误的具体抛出场景、不负责错误转换、
 * 不耦合任何具体依赖（Redis/S3/LLM 等）。具体依赖的错误识别由各自模块完成，
 * 再转换为 AppError，从而让上层错误处理中间件只需面对一种类型。
 *
 * 设计动机：如果每个模块各自抛原生 Error，上层无法用稳定的 code 做分支，
 * 也无法统一映射 HTTP 状态码；用枚举码 + statusCode 让「业务语义」与「传输语义」
 * 在一处对齐，避免散落的魔法字符串和硬编码状态码。
 */
export type AppErrorCode =
  | "VALIDATION_ERROR"
  | "AUTHENTICATION_ERROR"
  | "AUTHORIZATION_ERROR"
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

/**
 * 应用统一错误基类。
 *
 * 为什么继承 Error 而不是自定义普通对象：只有 Error 子类才能保留调用栈，
 * 且能被 try/catch 自然捕获，与生态（日志、APM）兼容。
 * 为什么 code 用枚举字符串而非数字：字符串自描述、跨服务可读、避免「4043 是什么」的映射表。
 * statusCode 默认 500：未显式指定时按服务端未知错误处理，避免遗漏分类时暴露 200 成功假象。
 */
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
