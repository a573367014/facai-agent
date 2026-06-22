import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider } from "../../src/providers/openai-compatible-provider.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function createProvider() {
  return new OpenAiCompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://example.com",
    model: "test-model"
  });
}

function createStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }
    })
  } as Response;
}

describe("OpenAiCompatibleProvider", () => {
  it("拒绝非法 JSON 工具参数", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call_1",
                  function: {
                    name: "calculator",
                    arguments: "{not-json"
                  }
                }
              ]
            }
          }
        ]
      })
    } as Response);

    await expect(createProvider().complete({ messages: [], tools: [] })).rejects.toMatchObject({
      code: "PROVIDER_BAD_RESPONSE",
      message: expect.stringContaining("工具 calculator 的参数不是合法 JSON")
    });
  });

  it("拒绝既没有文本也没有工具调用的响应", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: {} }]
      })
    } as Response);

    await expect(createProvider().complete({ messages: [], tools: [] })).rejects.toMatchObject({
      code: "PROVIDER_BAD_RESPONSE",
      message: "模型响应缺少最终回答或工具调用"
    });
  });

  it("拒绝缺少工具名的工具调用", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call_1",
                  function: {
                    arguments: "{}"
                  }
                }
              ]
            }
          }
        ]
      })
    } as Response);

    await expect(createProvider().complete({ messages: [], tools: [] })).rejects.toMatchObject({
      code: "PROVIDER_BAD_RESPONSE",
      message: "模型返回了无效的工具调用"
    });
  });

  it("流式响应时逐段回调文本并返回完整内容", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createStreamResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        "data: [DONE]\n\n"
      ])
    );
    globalThis.fetch = fetchMock;
    const deltas: string[] = [];

    const result = await createProvider().completeStream({ messages: [], tools: [] }, (delta) => {
      deltas.push(delta);
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { stream?: boolean };
    expect(requestBody.stream).toBe(true);
    expect(deltas).toEqual(["你", "好"]);
    expect(result).toEqual({ content: "你好", toolCalls: undefined });
  });

  it("流式响应时能组装工具调用参数", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createStreamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"calculator","arguments":"{\\"expression\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"12 * 9\\"}"}}]}}]}\n\n',
        "data: [DONE]\n\n"
      ])
    );
    const deltas: string[] = [];

    const result = await createProvider().completeStream({ messages: [], tools: [] }, (delta) => {
      deltas.push(delta);
    });

    expect(deltas).toEqual([]);
    expect(result).toEqual({
      content: undefined,
      toolCalls: [
        {
          id: "call_1",
          name: "calculator",
          arguments: { expression: "12 * 9" }
        }
      ]
    });
  });
});
