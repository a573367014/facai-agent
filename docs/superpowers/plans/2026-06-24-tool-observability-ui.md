# Tool Observability UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Agent 工具事件从 raw JSON 折叠块升级为可读的工具调用卡片。

**Architecture:** 后端事件协议保持不变，Web 侧新增 `buildToolTraces(events)` 把 `tool_call_ready`、`tool_start`、`tool_result`、`tool_error` 聚合成展示模型。`AgentConversation` 只负责挂载工具面板，具体展示拆到独立组件里。

**Tech Stack:** React 18、TypeScript、Vitest、Testing Library、现有 SSE 事件类型。

---

### Task 1: Tool Trace Aggregation

**Files:**
- Create: `apps/web/src/utils/tool-traces.ts`
- Create: `apps/web/src/utils/tool-traces.test.ts`

- [ ] 写失败测试：同一个 `toolCallId` 的 ready/start/result 会聚合成一条成功 trace。
- [ ] 写失败测试：缺失 `toolCallId` 时用 fallback key 保留事件，避免 UI 丢工具结果。
- [ ] 实现 `buildToolTraces(events)`、`ToolTrace`、`ToolTraceStatus`。
- [ ] 运行 `npm run test -w @agent/web -- src/utils/tool-traces.test.ts`。

### Task 2: Tool Trace Components

**Files:**
- Create: `apps/web/src/components/ToolTraceList.tsx`
- Create: `apps/web/src/components/ToolTraceCard.tsx`
- Create: `apps/web/src/components/ToolResultPreview.tsx`
- Modify: `apps/web/src/components/AgentConversation.tsx`
- Modify: `apps/web/src/components/AgentConversation.test.tsx`

- [ ] 写组件测试：搜索工具显示 query、来源数量和链接标题。
- [ ] 写组件测试：图片工具显示图片预览和打开链接。
- [ ] 实现通用卡片状态、参数摘要、耗时展示。
- [ ] 替换 `AgentConversation` 里的 raw JSON 工具过程。
- [ ] 运行 `npm run test -w @agent/web -- src/components/AgentConversation.test.tsx`。

### Task 3: Styling and Verification

**Files:**
- Modify: `apps/web/src/styles.css`

- [ ] 补工具卡片、状态徽标、搜索结果、图片预览样式。
- [ ] 保持全屏三栏布局和“工具过程”入口文案不变。
- [ ] 运行 `npm run typecheck`、`npm run test`、`npm run build`。
