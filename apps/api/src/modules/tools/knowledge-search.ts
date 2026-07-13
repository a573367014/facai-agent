/**
 * 知识库检索工具（knowledge_search）
 *
 * 让 LLM 能查询本地知识库（已上传的公司文档、制度、流程、产品资料等），
 * 解决模型对私有 / 实时业务信息不了解的问题。
 *
 * 边界：本工具只负责"检索 + 渲染给 LLM"，不负责向量化和存储（那是 knowledge/retriever 的事）；
 * 渲染时刻意加上"只基于资料回答、找不到就说找不到、不要编造"的约束，降低 RAG 场景的幻觉。
 */
import { z } from "zod";
import type { KnowledgeRetriever, KnowledgeSearchResult } from "../knowledge/retriever.js";
import type { JsonObject, RegisteredTool, ToolExecutionContext } from "./types.js";

const knowledgeSearchArgsSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(10).optional()
});

export interface KnowledgeSearchToolOptions {
  retriever: Pick<KnowledgeRetriever, "search">;
}

interface KnowledgeSearchToolResult {
  query: string;
  results: KnowledgeSearchResult[];
  resultCount: number;
  error?: {
    message: string;
  };
}

const MAX_LLM_RESULTS = 5;
const MAX_LLM_CONTENT_CHARS = 700;

/**
 * 构造知识库检索工具。
 *
 * retriever 由外部注入（Pick<KnowledgeRetriever, "search">），
 * 工具只依赖这一个最小接口，便于替换底层检索实现或在测试中 mock。
 */
export function createKnowledgeSearchTool(options: KnowledgeSearchToolOptions): RegisteredTool {
  return {
    name: "knowledge_search",
    description: "搜索本地公司知识库。适合查询已上传的公司文档、制度、流程、产品资料或项目文档。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "要在本地知识库中检索的问题，例如：请假流程是什么？"
        },
        limit: {
          type: "number",
          description: "返回来源片段数量，1 到 10，默认 5"
        }
      },
      required: ["query"]
    },
    argumentSchema: knowledgeSearchArgsSchema,
    async execute(args: JsonObject, context: ToolExecutionContext) {
      const parsedArgs = knowledgeSearchArgsSchema.parse(args);

      try {
        const results = await options.retriever.search({
          query: parsedArgs.query,
          limit: parsedArgs.limit ?? 5,
          signal: context.signal
        });
        const result: KnowledgeSearchToolResult = {
          query: parsedArgs.query,
          results,
          resultCount: results.length
        };

        return {
          data: result,
          llmContent: renderKnowledgeResultsForLlm(result)
        };
      } catch (error) {
        // 检索失败时不抛异常，而是返回结构化结果 + 引导性 llmContent：
        // 这样 LLM 会转告用户"暂时无法检索"，而不是触发 tool_error 中断会话；
        // llmContent 里显式写"不要编造"，防止模型在没拿到资料时自行胡编。
        const message = error instanceof Error ? error.message : "知识库检索失败";
        const result: KnowledgeSearchToolResult = {
          query: parsedArgs.query,
          results: [],
          resultCount: 0,
          error: { message }
        };

        return {
          data: result,
          llmContent: `本地知识库暂不可用：${message}。请直接说明暂时无法检索知识库，不要编造。`
        };
      }
    }
  };
}

/**
 * 把检索结果渲染成给 LLM 看的文本。
 *
 * 这是 RAG 防幻觉的关键一环：除了列出资料片段，还在末尾显式约束
 * "只能基于上述资料回答、资料不足就说明、保留来源"。
 * 不加这段约束，模型很容易在资料不足时仍自信地编造答案。
 */
function renderKnowledgeResultsForLlm(result: KnowledgeSearchToolResult): string {
  if (result.results.length === 0) {
    return "本地知识库没有检索到相关资料。请直接说明没有找到依据，不要编造。";
  }

  const lines = [
    `本地知识库 query：${result.query}`,
    "",
    "检索结果："
  ];

  for (const [index, item] of result.results.slice(0, MAX_LLM_RESULTS).entries()) {
    lines.push(
      `${index + 1}. ${truncateForLlm(item.content, MAX_LLM_CONTENT_CHARS)}`,
      `   来源：${item.source}`
    );
  }

  lines.push("", "回答要求：只能基于上述资料回答；如果资料不足，请说明没有找到依据；回答末尾保留来源。");
  return lines.join("\n");
}

function truncateForLlm(text: string, maxCharacters: number) {
  const normalizedText = text.replace(/\s+/g, " ").trim();

  if (normalizedText.length <= maxCharacters) {
    return normalizedText;
  }

  return `${normalizedText.slice(0, maxCharacters).trimEnd()}...`;
}
