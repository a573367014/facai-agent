import { describe, expect, it } from "vitest";
import { createTavilySearchTool } from "../../src/modules/tools/web-search.js";

describe("createTavilySearchTool", () => {
  it("调用 Tavily Search API 并返回标准化搜索结果", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });

      return new Response(
        JSON.stringify({
          query: "Fastify latest",
          answer: "Fastify 是一个 Node.js Web 框架。",
          response_time: 0.42,
          results: [
            {
              title: "Fastify",
              url: "https://fastify.dev/",
              content: "Fastify is a fast and low overhead web framework.",
              score: 0.98
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    };
    const tool = createTavilySearchTool({
      apiKey: "tvly-test",
      maxResults: 5,
      fetchImpl
    });

    const output = await tool.execute({ query: "Fastify latest", maxResults: 3 }, {});

    // web_search 不再把完整搜索结果直接塞给 LLM。
    // data 保留结构化原文，方便前端展示、事件记录和后续排查；
    // llmContent 则是更短、更像“观察结果”的文本，专门给 LLM 综合回答。
    expect(output).toEqual({
      data: {
        provider: "tavily",
        query: "Fastify latest",
        answer: "Fastify 是一个 Node.js Web 框架。",
        results: [
          {
            title: "Fastify",
            url: "https://fastify.dev/",
            snippet: "Fastify is a fast and low overhead web framework.",
            score: 0.98
          }
        ],
        resultCount: 1,
        responseTimeSeconds: 0.42
      },
      llmContent: expect.stringContaining("搜索 query：Fastify latest")
    });
    expect((output as { llmContent: string }).llmContent).toContain("Tavily 摘要：Fastify 是一个 Node.js Web 框架。");
    expect((output as { llmContent: string }).llmContent).toContain("URL: https://fastify.dev/");
    expect((output as { llmContent: string }).llmContent).toContain(
      "摘要: Fastify is a fast and low overhead web framework."
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.tavily.com/search");
    expect(requests[0].init.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer tvly-test"
    });
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({
      query: "Fastify latest",
      search_depth: "basic",
      max_results: 3,
      include_answer: true,
      include_raw_content: false
    });
  });

  it("没有配置 Tavily API Key 时拒绝执行", async () => {
    const tool = createTavilySearchTool({
      apiKey: "",
      maxResults: 5,
      fetchImpl: async () => {
        throw new Error("不应该发起请求");
      }
    });

    await expect(tool.execute({ query: "Fastify" }, {})).rejects.toThrow("Tavily API Key 未配置");
  });
});
