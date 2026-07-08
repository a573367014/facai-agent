/**
 * Mock LLM Server — 模拟 OpenAI 兼容的 /v1/chat/completions 接口
 *
 * 用于压测：把 OPENAI_BASE_URL 指向此服务，即可隔离 DeepSeek，
 * 零成本压测 agent-api → Redis → worker → DB 全链路。
 *
 * 环境变量：
 *   MOCK_LLM_PORT      监听端口（默认 8088）
 *   MOCK_LLM_DELAY_MS  模拟 LLM 响应延迟（默认 100ms）
 *   MOCK_LLM_REPLY     模拟回复内容（默认固定文本）
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_LLM_PORT || 8088);
const DELAY_MS = Number(process.env.MOCK_LLM_DELAY_MS || 100);
const REPLY_TEXT = process.env.MOCK_LLM_REPLY || "这是压测模拟回复，系统正常运行中。";

let requestCount = 0;

const server = http.createServer(async (req, res) => {
  // 只处理 chat/completions，兼容 /v1/chat/completions 和 /chat/completions
  if (req.method !== "POST" || !req.url?.includes("chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request" } }));
    return;
  }

  // 读取请求体
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON", type: "invalid_request" } }));
    return;
  }

  requestCount++;
  const isStream = parsed.stream === true;
  const id = `chatcmpl-mock-${requestCount}`;
  const created = Math.floor(Date.now() / 1000);
  const model = parsed.model || "mock-model";

  // 模拟 LLM 思考延迟
  await new Promise((r) => setTimeout(r, DELAY_MS));

  if (isStream) {
    // Streaming 模式（SSE）— LangChain ChatOpenAI 默认用 streaming
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // 首个 chunk：role
    res.write(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    })}\n\n`);

    // 逐字发送内容（模拟流式输出）
    for (const char of REPLY_TEXT) {
      res.write(`data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: char }, finish_reason: null }],
      })}\n\n`);
    }

    // 结束 chunk
    res.write(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`);

    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    // 非 streaming 模式
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: REPLY_TEXT },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 50,
        completion_tokens: REPLY_TEXT.length,
        total_tokens: 50 + REPLY_TEXT.length,
      },
    }));
  }
});

server.listen(PORT, () => {
  console.log(`[mock-llm] 监听 http://localhost:${PORT}`);
  console.log(`[mock-llm] 延迟: ${DELAY_MS}ms | 回复: "${REPLY_TEXT}"`);
  console.log(`[mock-llm] 使用方法: OPENAI_BASE_URL=http://localhost:${PORT} pnpm dev`);
});
