/**
 * 工具注册入口 / 默认工具集工厂
 *
 * 把各具体工具按"条件注册"的方式组装成一个 ToolRegistry：
 * 无外部依赖的工具（calculator / current_time / generate_document）始终注册；
 * 依赖外部密钥或检索器的工具（Tavily / 知识库 / 即梦图片 / 即梦视频）只在对应配置存在时才注册——
 * 这样 LLM 看到的 tools 列表里不会出现"注册了但跑不通"的工具，减少模型误调用后的失败噪音。
 *
 * 边界：本文件只做"装配"，不做执行；执行统一走 ToolExecutor。
 */
import { calculatorTool } from "./calculator.js";
import { currentTimeTool } from "./current-time.js";
import { createDocumentFileTool } from "./document-file.js";
import {
  createJimengImageEditTool,
  createJimengImageTool,
  type JimengImageEditToolOptions,
  type JimengImageToolOptions
} from "./jimeng-image.js";
import { createJimengVideoTool, type JimengVideoToolOptions } from "./jimeng-video.js";
import type { KnowledgeRetriever } from "../knowledge/retriever.js";
import { createKnowledgeSearchTool } from "./knowledge-search.js";
import { ToolRegistry } from "./registry.js";
import { createTavilySearchTool } from "./web-search.js";

export interface DefaultToolRegistryOptions {
  tavilyApiKey?: string;
  searchMaxResults?: number;
  jimengImage?: JimengImageToolOptions;
  jimengImageEdit?: JimengImageEditToolOptions;
  jimengVideo?: JimengVideoToolOptions;
  knowledgeRetriever?: Pick<KnowledgeRetriever, "search">;
}

export function createDefaultToolRegistry(options: DefaultToolRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(calculatorTool);
  registry.register(currentTimeTool);
  registry.register(createDocumentFileTool());

  // 搜索工具依赖外部 Tavily Key。没配 key 时不注册，让 LLM 看不到不可用工具；
  // 配好 key 后，web_search 会和其他工具一样走 ToolExecutor 的校验、超时和事件流。
  if (options.tavilyApiKey?.trim()) {
    registry.register(
      createTavilySearchTool({
        apiKey: options.tavilyApiKey,
        maxResults: options.searchMaxResults ?? 5
      })
    );
  }

  if (options.knowledgeRetriever) {
    registry.register(createKnowledgeSearchTool({ retriever: options.knowledgeRetriever }));
  }

  if (options.jimengImage?.accessKeyId?.trim() && options.jimengImage.secretAccessKey?.trim()) {
    registry.register(createJimengImageTool(options.jimengImage));
  }

  if (options.jimengImageEdit?.accessKeyId?.trim() && options.jimengImageEdit.secretAccessKey?.trim()) {
    registry.register(createJimengImageEditTool(options.jimengImageEdit));
  }

  if (options.jimengVideo?.accessKeyId?.trim() && options.jimengVideo.secretAccessKey?.trim()) {
    registry.register(createJimengVideoTool(options.jimengVideo));
  }

  return registry;
}
