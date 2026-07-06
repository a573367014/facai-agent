import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";
import type { Env } from "../config/env.js";

export interface LlmModelOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  streaming: boolean;
  signal?: AbortSignal;
}

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

export function createLlmModelFromEnv(env: Env, streaming = true): ChatOpenAI {
  return createLlmModel({
    apiKey: env.OPENAI_API_KEY ?? "",
    baseUrl: env.OPENAI_BASE_URL,
    model: env.OPENAI_MODEL ?? "",
    streaming
  });
}
