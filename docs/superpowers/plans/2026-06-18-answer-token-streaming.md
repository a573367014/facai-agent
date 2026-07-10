# 回答令牌流式传输实施计划

> **面向智能体执行者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐项实施本计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 发送回答令牌增量，而不只是展示追踪事件，让流式运行呈现真正的打字机效果。

**架构：** 保留现有追踪 SSE 路由，并新增 `answer_delta` 事件。最终回答轮次通过可选的 `completeStream()` 增加提供方流式输出，工具调用轮次继续使用现有的非流式补全路径。React 将 `answer_delta.delta` 追加到实时回答预览中，并继续在其下方渲染追踪事件。

**技术栈：** Fastify、TypeScript、OpenAI 兼容的聊天补全流、服务器发送事件、React、Vitest、Testing Library。

---

## 任务 1：提供方流式传输契约

- [ ] 将 `answer_delta` 添加到 `AgentStreamEvent`。
- [ ] 将 `completeStream(request, onDelta)` 作为可选方法添加到提供方接口。
- [ ] 使用包含 `choices[0].delta.content` 的 SSE 数据块测试 OpenAI 兼容的流式解析器。
- [ ] 在 `OpenAiCompatibleProvider.completeStream()` 中实现 `stream: true` 请求。

## 任务 2：AgentService 增量事件

- [ ] 测试当提供方支持流式输出时，最终回答轮次会在 `final_answer` 之前发送 `answer_delta` 事件。
- [ ] 让工具调用轮次继续使用现有 `complete()` 路径，以保持工具执行稳定。
- [ ] 当提供方未实现 `completeStream()` 时，回退到现有 `complete()` 路径。

## 任务 3：React 打字机交互体验

- [ ] 测试点击“流式运行”会把 `answer_delta` 文本追加到回答面板。
- [ ] 将 `answer_delta` 添加到前端事件类型。
- [ ] 更新 `handleStreamRun()`，以增量方式构建回答。
- [ ] 保持追踪信息可见，但聚焦于事件标题和载荷。

## 任务 4：验证

- [ ] 运行 `npm run test`。
- [ ] 运行 `npm run typecheck`。
- [ ] 运行 `npm run build`。
- [ ] 验证 `/agents/stream` 返回带有 CORS 响应头的 `answer_delta` 数据块。
