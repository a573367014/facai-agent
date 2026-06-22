# Streaming Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 Agent Streaming Trace，让前端能实时看到 LLM 请求、工具调用、工具结果和最终答案。

**Architecture:** 保留现有 `/agents/run` 同步接口。给 `AgentService.run()` 增加可选 `onEvent` 回调，避免复制 agent loop。新增 `/agents/stream` SSE 路由，把事件以 `data: <json>\n\n` 推给前端。React Demo 增加“流式运行”按钮和 timeline 面板。

**Tech Stack:** Fastify, TypeScript, Server-Sent Events, React, Vitest, Testing Library.

---

## Task 1: AgentService 事件回调

- [ ] 写测试：执行工具调用时按顺序发出 `llm_start`、`llm_response`、`tool_start`、`tool_result`、`final_answer`。
- [ ] 修改 `AgentRunInput`，增加 `onEvent?: (event) => void | Promise<void>`。
- [ ] 在 `AgentService.run()` 对关键节点 emit 事件。

## Task 2: SSE 路由

- [ ] 写路由测试：`POST /agents/stream` 返回 `text/event-stream`，包含 `final_answer` 事件。
- [ ] 抽出请求校验函数，复用 `/agents/run` 和 `/agents/stream`。
- [ ] 实现 SSE 写入函数，并在错误时推送 `error` 事件。

## Task 3: React Timeline

- [ ] 写前端测试：点击“流式运行”后展示事件 timeline 和最终答案。
- [ ] 给 `agent-client.ts` 增加 `streamAgent()`，用 `fetch` 读取 SSE response body。
- [ ] 新增 `AgentTimeline` 组件。
- [ ] `App.tsx` 增加 streaming 状态、事件列表和按钮回调。

## Task 4: Verification

- [ ] 跑 `npm run test`。
- [ ] 跑 `npm run typecheck`。
- [ ] 跑 `npm run build`。
- [ ] 确认 API `/health` 和 Web 首页可访问。
