import { calculatorTool } from "./calculator.js";
import { currentTimeTool } from "./current-time.js";
import {
  createJimengImageEditTool,
  createJimengImageTool,
  type JimengImageEditToolOptions,
  type JimengImageToolOptions
} from "./jimeng-image.js";
import { createJimengVideoTool, type JimengVideoToolOptions } from "./jimeng-video.js";
import { ToolRegistry } from "./registry.js";
import { createTavilySearchTool } from "./web-search.js";

export interface DefaultToolRegistryOptions {
  tavilyApiKey?: string;
  searchMaxResults?: number;
  jimengImage?: JimengImageToolOptions;
  jimengImageEdit?: JimengImageEditToolOptions;
  jimengVideo?: JimengVideoToolOptions;
}

export function createDefaultToolRegistry(options: DefaultToolRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(calculatorTool);
  registry.register(currentTimeTool);

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
