/**
 * 网页搜索工具（web_search，基于 Tavily）
 *
 * 让 LLM 能拿到互联网实时信息（新闻、近期数据、模型知识可能过期的问题）。
 *
 * 边界：本工具只对接 Tavily Search API；
 * 第一版只把短摘要（content）喂回模型，不取 raw_content，避免一次搜索把上下文窗口撑爆。
 * 只有配置了 Tavily Key 时才会被 index.ts 注册，避免 LLM 看到不可用的工具。
 */
import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import type { JsonObject, RegisteredTool, ToolExecutionContext } from "./types.js";

const tavilySearchArgsSchema = z.object({
  query: z.string().trim().min(1),
  maxResults: z.number().int().min(1).max(10).optional()
});

const tavilyResultSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  content: z.string().optional(),
  raw_content: z.string().nullable().optional(),
  score: z.number().optional()
});

const tavilyResponseSchema = z.object({
  query: z.string().optional(),
  answer: z.string().nullable().optional(),
  results: z.array(tavilyResultSchema).optional(),
  response_time: z.number().optional()
});

interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

interface WebSearchResult {
  provider: "tavily";
  query: string;
  answer?: string;
  results: WebSearchResultItem[];
  resultCount: number;
  responseTimeSeconds?: number;
}

export interface TavilySearchToolOptions {
  apiKey: string;
  maxResults: number;
  fetchImpl?: typeof fetch;
}

const MAX_LLM_RESULTS = 5;
const MAX_LLM_SNIPPET_CHARS = 500;

function toPositiveMaxResults(value: number) {
  return Math.min(10, Math.max(1, Math.trunc(value)));
}

function toSnippet(result: z.infer<typeof tavilyResultSchema>) {
  // Tavily 的 content 通常是适合 LLM 阅读的摘要；raw_content 可能很长。
  // 第一版只把短摘要喂回模型，避免一次搜索把上下文撑爆。
  return (result.content ?? result.raw_content ?? "").trim();
}

function truncateForLlm(text: string, maxChars: number) {
  const normalizedText = text.replace(/\s+/g, " ").trim();

  if (normalizedText.length <= maxChars) {
    return normalizedText;
  }

  return `${normalizedText.slice(0, maxChars).trimEnd()}...`;
}

/**
 * 把搜索结果渲染成给 LLM 看的文本。
 *
 * 只取前 MAX_LLM_RESULTS 条，每条摘要截断到 MAX_LLM_SNIPPET_CHARS 字符，
 * 在"给模型足够依据"和"不撑爆上下文窗口"之间做平衡。
 */
function renderSearchResultForLlm(result: WebSearchResult) {
  const lines = [`搜索 query：${result.query}`];

  if (result.answer) {
    lines.push("", `Tavily 摘要：${result.answer}`);
  }

  if (result.results.length === 0) {
    lines.push("", "搜索结果：未找到可用来源。");
    return lines.join("\n");
  }

  lines.push("", "搜索结果：");

  for (const [index, item] of result.results.slice(0, MAX_LLM_RESULTS).entries()) {
    lines.push(
      `${index + 1}. ${item.title}`,
      `   URL: ${item.url}`,
      `   摘要: ${truncateForLlm(item.snippet, MAX_LLM_SNIPPET_CHARS)}`
    );
  }

  return lines.join("\n");
}

/**
 * 构造 Tavily 网页搜索工具。
 *
 * fetchImpl 可注入，便于测试时替换为 mock；默认走全局 fetch。
 * execute 内部仍会检查 apiKey，是为了防止有人绕过 index.ts 直接实例化工具——
 * 缺 key 属于服务配置错误，不应让 LLM 反复重试。
 */
export function createTavilySearchTool(options: TavilySearchToolOptions): RegisteredTool {
  const defaultMaxResults = toPositiveMaxResults(options.maxResults);
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: "web_search",
    description: "搜索互联网实时信息，适合查询新闻、近期数据、资料来源或模型知识可能过期的问题。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词或完整问题，尽量具体，例如：Node.js Fastify 最新版本"
        },
        maxResults: {
          type: "number",
          description: "返回结果数量，1 到 10，默认使用服务端配置"
        }
      },
      required: ["query"]
    },
    argumentSchema: tavilySearchArgsSchema,
    async execute(args: JsonObject, context: ToolExecutionContext) {
      const parsedArgs = tavilySearchArgsSchema.parse(args);
      const maxResults = toPositiveMaxResults(parsedArgs.maxResults ?? defaultMaxResults);

      // 工具内部仍然检查 key，是为了防止未来有人绕过 index.ts 直接实例化工具。
      // 缺少 key 是服务配置错误，不适合让 LLM 反复重试。
      if (!options.apiKey.trim()) {
        throw new AppError("TOOL_EXECUTION_ERROR", "Tavily API Key 未配置，无法使用互联网搜索", 500);
      }

      const response = await fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`
        },
        body: JSON.stringify({
          query: parsedArgs.query,
          search_depth: "basic",
          max_results: maxResults,
          include_answer: true,
          include_raw_content: false
        }),
        signal: context.signal
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const suffix = errorText ? `：${errorText.slice(0, 200)}` : "";
        throw new AppError("TOOL_EXECUTION_ERROR", `Tavily 搜索请求失败，HTTP ${response.status}${suffix}`, 502);
      }

      const rawPayload = (await response.json()) as unknown;
      const payload = tavilyResponseSchema.parse(rawPayload);
      const results = (payload.results ?? [])
        .map((result) => ({
          title: result.title ?? "无标题",
          url: result.url ?? "",
          snippet: toSnippet(result),
          score: result.score
        }))
        .filter((result) => result.url.length > 0);

      const searchResult: WebSearchResult = {
        provider: "tavily",
        query: payload.query ?? parsedArgs.query,
        answer: payload.answer ?? undefined,
        results,
        resultCount: results.length,
        responseTimeSeconds: payload.response_time
      };

      return {
        data: searchResult,
        llmContent: renderSearchResultForLlm(searchResult)
      };
    }
  };
}
