import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingService, OllamaEmbeddingService } from "../../src/knowledge/embedding-service.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("OllamaEmbeddingService", () => {
  it("provider 为 ollama 时创建本地 embedding 服务", async () => {
    const service = createEmbeddingService({
      provider: "ollama",
      openAiCompatible: {
        apiKey: "deepseek-key",
        baseUrl: "https://api.deepseek.com",
        model: "text-embedding-3-small"
      },
      ollama: {
        baseUrl: "http://localhost:11434",
        model: "embeddinggemma"
      }
    });

    expect(service.constructor.name).toBe("OllamaEmbeddingService");
    expect(service.model).toBe("embeddinggemma");
  });

  it("通过 Ollama 原生 /api/embed 生成本地 embedding", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4]
        ]
      })
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const service = new OllamaEmbeddingService({
      baseUrl: "http://localhost:11434",
      model: "embeddinggemma"
    });

    await expect(service.embedTexts(["请假流程", "报销流程"])).resolves.toEqual([
      [0.1, 0.2],
      [0.3, 0.4]
    ]);

    expect(service.model).toBe("embeddinggemma");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/embed",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "embeddinggemma",
          input: ["请假流程", "报销流程"]
        })
      })
    );
  });

  it("空文本列表直接返回空结果", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const service = new OllamaEmbeddingService({
      baseUrl: "http://localhost:11434/",
      model: "embeddinggemma"
    });

    await expect(service.embedTexts([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("本地 Ollama 服务不可用时返回可读错误", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed")) as typeof fetch;
    const service = new OllamaEmbeddingService({
      baseUrl: "http://localhost:11434",
      model: "embeddinggemma"
    });

    await expect(service.embedTexts(["请假流程"])).rejects.toThrow(
      "本地 Ollama embedding 服务不可用，请确认 Ollama 已启动并已拉取 embeddinggemma"
    );
  });
});
