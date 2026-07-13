import { authenticatedFetch } from "@/features/auth/api/authenticated-fetch";

function parseSseBlock<T>(block: string): T | null {
  // 后端 SSE 每个事件块形如：
  // data: {"id":"event_live_...","event":...}
  // 这里先只解析 data 行，event/id/retry 这些字段当前业务不依赖。
  const dataLine = block
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:"));

  if (!dataLine) {
    return null;
  }

  return JSON.parse(dataLine.slice("data:".length).trim()) as T;
}

export async function streamSse<T>(
  input: RequestInfo | URL,
  onEvent: (event: T) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await authenticatedFetch(input, {
    signal,
    headers: {
      accept: "text/event-stream"
    }
  });

  if (!response.ok || !response.body) {
    throw new Error("流式请求失败");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // fetch reader 每次给的是网络 chunk，不一定刚好等于一个 SSE 事件。
  // 用 buffer 累积文本，只有遇到空行分隔符 \n\n 才把完整事件交给 parseSseBlock。
  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const event = parseSseBlock<T>(block);
      if (event) {
        onEvent(event);
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    // 流结束时如果还有最后一个未用 \n\n 结尾的 block，也要补处理一次。
    const event = parseSseBlock<T>(buffer);
    if (event) {
      onEvent(event);
    }
  }
}
