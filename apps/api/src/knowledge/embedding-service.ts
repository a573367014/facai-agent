export interface EmbedTextsOptions {
  signal?: AbortSignal;
}

export interface EmbeddingService {
  readonly model: string;
  embedTexts(texts: string[], options?: EmbedTextsOptions): Promise<number[][]>;
}

export interface OpenAiCompatibleEmbeddingServiceOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

export interface OllamaEmbeddingServiceOptions {
  baseUrl: string;
  model: string;
}

export type EmbeddingProvider = "openai-compatible" | "ollama";

export interface CreateEmbeddingServiceOptions {
  provider: EmbeddingProvider;
  openAiCompatible: OpenAiCompatibleEmbeddingServiceOptions;
  ollama: OllamaEmbeddingServiceOptions;
}

interface EmbeddingApiResponse {
  data?: Array<{
    index?: number;
    embedding?: unknown;
  }>;
}

interface OllamaEmbeddingApiResponse {
  embeddings?: unknown;
}

export class OpenAiCompatibleEmbeddingService implements EmbeddingService {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: OpenAiCompatibleEmbeddingServiceOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.model = options.model;
  }

  async embedTexts(texts: string[], options: EmbedTextsOptions = {}): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    if (!this.apiKey?.trim()) {
      throw new Error("未配置 embedding API Key");
    }

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      signal: options.signal,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        input: texts
      })
    });

    if (!response.ok) {
      throw new Error(`embedding 请求失败：${response.status}`);
    }

    const payload = (await response.json()) as EmbeddingApiResponse;
    const rows = [...(payload.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    const embeddings = rows.map((row) => normalizeEmbedding(row.embedding));

    if (embeddings.length !== texts.length) {
      throw new Error("embedding 返回数量和输入文本数量不一致");
    }

    return embeddings;
  }
}

export class OllamaEmbeddingService implements EmbeddingService {
  readonly model: string;
  private readonly baseUrl: string;

  constructor(options: OllamaEmbeddingServiceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.model = options.model;
  }

  async embedTexts(texts: string[], options: EmbedTextsOptions = {}): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        signal: options.signal,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          input: texts
        })
      });
    } catch (error) {
      throw new Error(`本地 Ollama embedding 服务不可用，请确认 Ollama 已启动并已拉取 ${this.model}`, {
        cause: error
      });
    }

    if (!response.ok) {
      throw new Error(`本地 embedding 请求失败：${response.status}`);
    }

    const payload = (await response.json()) as OllamaEmbeddingApiResponse;
    const embeddings = normalizeEmbeddings(payload.embeddings);

    if (embeddings.length !== texts.length) {
      throw new Error("本地 embedding 返回数量和输入文本数量不一致");
    }

    return embeddings;
  }
}

export function createEmbeddingService(options: CreateEmbeddingServiceOptions): EmbeddingService {
  if (options.provider === "ollama") {
    return new OllamaEmbeddingService(options.ollama);
  }

  return new OpenAiCompatibleEmbeddingService(options.openAiCompatible);
}

function normalizeEmbeddings(value: unknown): number[][] {
  if (!Array.isArray(value)) {
    throw new Error("embedding 返回格式无效");
  }

  return value.map((item) => normalizeEmbedding(item));
}

function normalizeEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) {
    throw new Error("embedding 返回格式无效");
  }

  return value;
}
