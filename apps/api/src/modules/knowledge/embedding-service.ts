/**
 * Embedding 生成服务。
 *
 * 职责：把文本转换成稠密向量（embedding），供向量检索使用。
 *
 * 为什么这是个抽象（接口 + 多实现）而不是单一函数：
 * - 向量化可以走两种后端：① 远程 OpenAI 兼容 API（云端，要 API Key）；
 *   ② 本地 Ollama（自托管，无需密钥，但需要本机跑服务）。
 * - 两种后端的请求/响应结构不同，但对上游（indexing-service / retriever）而言，
 *   它们只关心"输入文本数组 → 输出向量数组"这一统一契约，所以抽出 EmbeddingService 接口屏蔽差异。
 *
 * 为什么 embedTexts 是批量接口（接收数组而非单条）：
 * - 向量化通常较慢，批量请求能复用一次网络往返，大幅减少索引长文档时的耗时。
 */
export interface EmbedTextsOptions {
  signal?: AbortSignal;
}

/**
 * 向量服务的统一抽象。上游只依赖这个接口，不关心底层是 Ollama 还是 OpenAI。
 * model 字段必须暴露，因为落库时要记录"这个向量是用哪个模型生成的"，模型升级后便于区分。
 */
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

/** 创建向量服务时的配置，两个 provider 的配置都要提供，由 provider 字段决定实际启用哪个。 */
export interface CreateEmbeddingServiceOptions {
  provider: EmbeddingProvider;
  openAiCompatible: OpenAiCompatibleEmbeddingServiceOptions;
  ollama: OllamaEmbeddingServiceOptions;
}

/** OpenAI 兼容接口的响应结构（只声明用到的字段，data 数组里每项带 index 用于还原顺序）。 */
interface EmbeddingApiResponse {
  data?: Array<{
    index?: number;
    embedding?: unknown;
  }>;
}

/** Ollama 接口的响应结构，embeddings 直接是二维数组。 */
interface OllamaEmbeddingApiResponse {
  embeddings?: unknown;
}

/**
 * OpenAI 兼容向量服务实现。
 * 适用于 OpenAI 官方、Azure OpenAI、以及一切遵循 OpenAI /embeddings 协议的第三方服务。
 */
export class OpenAiCompatibleEmbeddingService implements EmbeddingService {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: OpenAiCompatibleEmbeddingServiceOptions) {
    this.apiKey = options.apiKey;
    // 去掉末尾斜杠，防止拼接出 baseUrl//embeddings 这样的双斜杠 URL
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
    // 远程 API 不保证按输入顺序返回，按 index 排序还原与输入文本的一一对应关系
    const rows = [...(payload.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    const embeddings = rows.map((row) => normalizeEmbedding(row.embedding));

    if (embeddings.length !== texts.length) {
      throw new Error("embedding 返回数量和输入文本数量不一致");
    }

    return embeddings;
  }
}

/**
 * Ollama 本地向量服务实现。
 * Ollama 跑在本机，无需 API Key，但要求用户已启动 Ollama 并拉取了指定模型。
 */
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
      // 本地服务连不上是最常见的用户问题（忘启动 Ollama / 没拉模型），
      // 这里把网络错误转成有明确操作指引的错误信息，降低排查成本
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

/**
 * 工厂方法：根据 provider 配置实例化对应的向量服务。
 * 把"选哪个实现"集中在一处，上游只需传配置，符合依赖倒置原则。
 */
export function createEmbeddingService(options: CreateEmbeddingServiceOptions): EmbeddingService {
  if (options.provider === "ollama") {
    return new OllamaEmbeddingService(options.ollama);
  }

  return new OpenAiCompatibleEmbeddingService(options.openAiCompatible);
}

/**
 * 校验并归一化 Ollama 返回的二维向量结构。
 * 因为 JSON 反序列化后类型是 unknown，必须做形状校验，防止脏数据混入向量库。
 */
function normalizeEmbeddings(value: unknown): number[][] {
  if (!Array.isArray(value)) {
    throw new Error("embedding 返回格式无效");
  }

  return value.map((item) => normalizeEmbedding(item));
}

/**
 * 校验单个向量：必须是纯数字数组。
 * 向量库里若混入非数字（如 null / 字符串），会破坏后续的相似度计算，所以这里要严格把关。
 */
function normalizeEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) {
    throw new Error("embedding 返回格式无效");
  }

  return value;
}
