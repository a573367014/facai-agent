import { describe, expect, it } from "vitest";
import type { AgentStreamEvent } from "@agent/contracts";
import { buildToolTraces } from "./tool-traces";

describe("buildToolTraces", () => {
  it("按 toolCallId 把工具准备、开始和结果聚合成一条成功轨迹", () => {
    const events: AgentStreamEvent[] = [
      {
        type: "tool_call_ready",
        iteration: 0,
        toolCallId: "call_search",
        toolName: "web_search",
        arguments: { query: "Fastify 最新版本" }
      },
      {
        type: "tool_start",
        iteration: 0,
        toolCallId: "call_search",
        toolName: "web_search",
        arguments: { query: "Fastify 最新版本" }
      },
      {
        type: "tool_result",
        iteration: 0,
        toolCallId: "call_search",
        toolName: "web_search",
        durationMs: 812,
        result: {
          provider: "tavily",
          query: "Fastify 最新版本",
          resultCount: 2,
          results: [
            { title: "Fastify", url: "https://fastify.dev/", snippet: "Fast and low overhead web framework." }
          ]
        }
      }
    ];

    expect(buildToolTraces(events)).toEqual([
      {
        id: "call_search",
        iteration: 0,
        toolName: "web_search",
        status: "success",
        arguments: { query: "Fastify 最新版本" },
        result: {
          provider: "tavily",
          query: "Fastify 最新版本",
          resultCount: 2,
          results: [
            { title: "Fastify", url: "https://fastify.dev/", snippet: "Fast and low overhead web framework." }
          ]
        },
        durationMs: 812
      }
    ]);
  });

  it("没有 toolCallId 的事件用 iteration 和 toolName 做兜底聚合", () => {
    const events: AgentStreamEvent[] = [
      {
        type: "tool_start",
        iteration: 1,
        toolName: "calculator",
        arguments: { expression: "12 * 9" }
      },
      {
        type: "tool_result",
        iteration: 1,
        toolName: "calculator",
        result: { value: 108 },
        durationMs: 7
      }
    ];

    expect(buildToolTraces(events)).toEqual([
      {
        id: "fallback:1:calculator",
        iteration: 1,
        toolName: "calculator",
        status: "success",
        arguments: { expression: "12 * 9" },
        result: { value: 108 },
        durationMs: 7
      }
    ]);
  });

  it("工具错误会保留错误详情并标记为失败", () => {
    const events: AgentStreamEvent[] = [
      {
        type: "tool_call_ready",
        iteration: 0,
        toolCallId: "call_echo",
        toolName: "echo",
        arguments: {}
      },
      {
        type: "tool_error",
        iteration: 0,
        toolCallId: "call_echo",
        toolName: "echo",
        durationMs: 3,
        error: {
          code: "TOOL_INVALID_ARGUMENTS",
          message: "工具 echo 的参数不合法",
          recoverable: true
        }
      }
    ];

    expect(buildToolTraces(events)).toEqual([
      {
        id: "call_echo",
        iteration: 0,
        toolName: "echo",
        status: "failed",
        arguments: {},
        error: {
          code: "TOOL_INVALID_ARGUMENTS",
          message: "工具 echo 的参数不合法",
          recoverable: true
        },
        durationMs: 3
      }
    ]);
  });

  it("隐藏 knowledge_search 工具轨迹", () => {
    const events: AgentStreamEvent[] = [
      {
        type: "tool_start",
        iteration: 0,
        toolCallId: "call_knowledge",
        toolName: "knowledge_search",
        arguments: { query: "请假流程" }
      },
      {
        type: "tool_result",
        iteration: 0,
        toolCallId: "call_knowledge",
        toolName: "knowledge_search",
        result: {
          query: "请假流程",
          results: [{ content: "请假需要主管审批。", source: "员工手册.txt #1" }]
        },
        durationMs: 12
      }
    ];

    expect(buildToolTraces(events)).toEqual([]);
  });

  it("批量生图进度会合成可预览的临时图片结果", () => {
    const events: AgentStreamEvent[] = [
      {
        type: "tool_start",
        iteration: 0,
        toolCallId: "call_image",
        toolName: "generate_image",
        arguments: { items: [{ prompt: "水彩小猪" }, { prompt: "像素小猪" }] }
      },
      {
        type: "tool_progress",
        iteration: 0,
        toolCallId: "call_image",
        toolName: "generate_image",
        progress: {
          kind: "image_batch_item",
          total: 2,
          item: {
            index: 1,
            status: "success",
            prompt: "像素小猪",
            imageUrls: ["https://example.com/pixel-pig.png"],
            binaryDataBase64: []
          }
        }
      }
    ];

    expect(buildToolTraces(events)).toEqual([
      {
        id: "call_image",
        iteration: 0,
        toolName: "generate_image",
        status: "running",
        arguments: { items: [{ prompt: "水彩小猪" }, { prompt: "像素小猪" }] },
        progressEvents: [
          {
            kind: "image_batch_item",
            total: 2,
            item: {
              index: 1,
              status: "success",
              prompt: "像素小猪",
              imageUrls: ["https://example.com/pixel-pig.png"],
              binaryDataBase64: []
            }
          }
        ],
        result: {
          total: 2,
          succeeded: 1,
          failed: 0,
          imageUrls: ["https://example.com/pixel-pig.png"],
          binaryDataBase64: [],
          items: [
            {
              index: 1,
              status: "success",
              prompt: "像素小猪",
              imageUrls: ["https://example.com/pixel-pig.png"],
              binaryDataBase64: []
            }
          ]
        }
      }
    ]);
  });
});
