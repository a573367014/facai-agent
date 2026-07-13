/**
 * LangChain 运行时上下文类型。
 *
 * 本文件定义 Agent 运行时（runtime/ 目录下各模块）在调用链路中传递的
 * 上下文信息，职责是给运行时各环节提供"这次执行属于哪条消息、哪个会话、
 * 能否被取消"的最小元数据。
 *
 * 边界说明：这里只承载运行时调度需要的标识与信号，不承载业务输入/输出
 * （那些由 AgentExecutionInput / AgentExecutionResult 负责），也不承载
 * 存储模型字段。保持精简是为了让运行时函数签名不依赖持久化层。
 */
export interface RuntimeContext {
  messageId?: string;
  sessionId?: string;
  signal?: AbortSignal;
}
