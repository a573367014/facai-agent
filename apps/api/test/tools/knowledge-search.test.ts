import { describe, expect, it } from "vitest";
import { createKnowledgeSearchTool } from "../../src/modules/tools/knowledge-search.js";

describe("knowledge_search tool", () => {
  it("返回结构化检索结果并提供带来源的 LLM 文本", async () => {
    const tool = createKnowledgeSearchTool({
      retriever: {
        search: async () => [
          {
            content: "请假需要在飞书提交申请，由直属主管审批。",
            source: "员工手册.txt #1",
            score: 0.92,
            documentId: "doc_1",
            chunkId: "chunk_1",
            documentName: "员工手册.txt"
          }
        ]
      }
    });

    const output = await tool.execute({ query: "请假找谁审批？", limit: 3 }, {});

    expect(output).toMatchObject({
      data: {
        query: "请假找谁审批？",
        results: [
          {
            content: "请假需要在飞书提交申请，由直属主管审批。",
            source: "员工手册.txt #1",
            score: 0.92
          }
        ]
      },
      llmContent: expect.stringContaining("来源：员工手册.txt #1")
    });
  });

  it("没有结果时给 LLM 明确的空结果观察", async () => {
    const tool = createKnowledgeSearchTool({
      retriever: {
        search: async () => []
      }
    });

    const output = await tool.execute({ query: "不存在的制度" }, {});

    expect(output).toMatchObject({
      data: {
        query: "不存在的制度",
        results: []
      },
      llmContent: "本地知识库没有检索到相关资料。请直接说明没有找到依据，不要编造。"
    });
  });
});
