/**
 * 模型工厂：根据配置创建 LangChain ChatOpenAI 实例。
 *
 * 本文件是 LLM 实例的统一创建入口，把"如何构造一个 ChatOpenAI"的知识
 * 集中在一处。这样上层（AgentService、ProviderShim）不需要关心 apiKey、
 * baseUrl、model 名字等细节从哪来，只需要拿一个造好的实例用。
 *
 * 边界说明：本文件只负责"创建实例"，不负责"如何调用实例"——
 * 调用逻辑在 provider-shim.ts 和 langchain-agent-service.ts 里。
 * 之所以用 ChatOpenAI 而非其他 LangChain 模型类，是因为项目对接的是
 * OpenAI-compatible 接口（通过 baseUrl 指向自建/第三方网关）。
 */
import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";
import type { Env } from "../../../platform/config/env.js";

/**
 * 创建 LLM 模型实例所需的配置项。
 *
 * - apiKey/baseUrl/model：OpenAI-compatible 接口的三要素；
 * - streaming：是否启用流式输出，影响模型是否逐 token 返回；
 * - signal：可选的取消信号，透传到底层 HTTP 请求。
 */
export interface LlmModelOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  streaming: boolean;
  signal?: AbortSignal;
}

/**
 * 根据显式配置创建一个 ChatOpenAI 实例。
 *
 * 把 apiKey、model、streaming 放在顶层，baseUrl 放在 configuration.baseURL
 * 里——这是 LangChain ChatOpenAI 的字段约定，不能混用。
 *
 * 为什么不在这里 bindTools：因为工具列表是每次运行时动态决定的
 * （受权限策略过滤），而模型实例通常是单例复用的，不适合在创建时绑定工具。
 */
export function createLlmModel(options: LlmModelOptions): ChatOpenAI {
  const fields: ChatOpenAIFields = {
    apiKey: options.apiKey,
    model: options.model,
    streaming: options.streaming,
    configuration: {
      baseURL: options.baseUrl
    }
  };

  return new ChatOpenAI(fields);
}

/**
 * 从环境变量配置创建 LLM 模型实例（便捷方法）。
 *
 * 直接读 Env 里的 OPENAI_* 变量，省去调用方手动拼配置的麻烦。
 * apiKey/model 用 ?? "" 兜底，是为了让缺配置时由 LangChain 在真正
 * 发请求时报错，而不是在创建实例时就炸——这样错误信息更明确
 * （"Invalid API key" 比 "Cannot read property of undefined" 好懂）。
 *
 * streaming 默认 true，因为 Agent 场景几乎都需要流式输出给前端。
 */
export function createLlmModelFromEnv(env: Env, streaming = true): ChatOpenAI {
  return createLlmModel({
    apiKey: env.OPENAI_API_KEY ?? "",
    baseUrl: env.OPENAI_BASE_URL,
    model: env.OPENAI_MODEL ?? "",
    streaming
  });
}
