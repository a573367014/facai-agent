# 流式追踪实施计划

> **面向智能体执行者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐项实施本计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 新增 Agent 流式追踪，让前端能实时看到 LLM 请求、工具调用、工具结果和最终答案。

**架构：** 保留现有 `/agents/run` 同步接口。给 `AgentService.run()` 增加可选 `onEvent` 回调，避免复制 Agent 循环。新增 `/agents/stream` SSE 路由，把事件以 `data: <json>\n\n` 推给前端。React 演示界面增加“流式运行”按钮和时间线面板。

**技术栈：** Fastify、TypeScript、服务器发送事件、React、Vitest、Testing Library。

---

## 任务 1：AgentService 事件回调

- [ ] 写测试：执行工具调用时按顺序发出 `llm_start`、`llm_response`、`tool_start`、`tool_result`、`final_answer`。
- [ ] 修改 `AgentRunInput`，增加 `onEvent?: (event) => void | Promise<void>`。
- [ ] 在 `AgentService.run()` 的关键节点发送事件。

## 任务 2：SSE 路由

- [ ] 写路由测试：`POST /agents/stream` 返回 `text/event-stream`，包含 `final_answer` 事件。
- [ ] 抽出请求校验函数，复用 `/agents/run` 和 `/agents/stream`。
- [ ] 实现 SSE 写入函数，并在错误时推送 `error` 事件。

## 任务 3：React 时间线

- [ ] 写前端测试：点击“流式运行”后展示事件时间线和最终答案。
- [ ] 给 `agent-client.ts` 增加 `streamAgent()`，用 `fetch` 读取 SSE 响应体。
- [ ] 新增 `AgentTimeline` 组件。
- [ ] `App.tsx` 增加流式状态、事件列表和按钮回调。

## 任务 4：验证

- [ ] 跑 `npm run test`。
- [ ] 跑 `npm run typecheck`。
- [ ] 跑 `npm run build`。
- [ ] 确认 API `/health` 和 Web 首页可访问。
