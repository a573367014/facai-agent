# 工具可观测性界面实施计划

> **面向智能体执行者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐项实施本计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 把 Agent 工具事件从原始 JSON 折叠块升级为可读的工具调用卡片。

**架构：** 后端事件协议保持不变，Web 侧新增 `buildToolTraces(events)` 把 `tool_call_ready`、`tool_start`、`tool_result`、`tool_error` 聚合成展示模型。`AgentConversation` 只负责挂载工具面板，具体展示拆到独立组件里。

**技术栈：** React 18、TypeScript、Vitest、Testing Library、现有 SSE 事件类型。

---

### 任务 1：工具轨迹聚合

**文件：**
- 创建：`apps/web/src/utils/tool-traces.ts`
- 创建：`apps/web/src/utils/tool-traces.test.ts`

- [ ] 写失败测试：同一个 `toolCallId` 的就绪、开始和结果事件会聚合成一条成功轨迹。
- [ ] 写失败测试：缺失 `toolCallId` 时用备用键保留事件，避免界面丢失工具结果。
- [ ] 实现 `buildToolTraces(events)`、`ToolTrace`、`ToolTraceStatus`。
- [ ] 运行 `npm run test -w @agent/web -- src/utils/tool-traces.test.ts`。

### 任务 2：工具轨迹组件

**文件：**
- 创建：`apps/web/src/components/ToolTraceList.tsx`
- 创建：`apps/web/src/components/ToolTraceCard.tsx`
- 创建：`apps/web/src/components/ToolResultPreview.tsx`
- 修改：`apps/web/src/components/AgentConversation.tsx`
- 修改：`apps/web/src/components/AgentConversation.test.tsx`

- [ ] 写组件测试：搜索工具显示查询内容、来源数量和链接标题。
- [ ] 写组件测试：图片工具显示图片预览和打开链接。
- [ ] 实现通用卡片状态、参数摘要、耗时展示。
- [ ] 替换 `AgentConversation` 里的原始 JSON 工具过程。
- [ ] 运行 `npm run test -w @agent/web -- src/components/AgentConversation.test.tsx`。

### 任务 3：样式与验证

**文件：**
- 修改：`apps/web/src/styles.css`

- [ ] 补工具卡片、状态徽标、搜索结果、图片预览样式。
- [ ] 保持全屏三栏布局和“工具过程”入口文案不变。
- [ ] 运行 `npm run typecheck`、`npm run test`、`npm run build`。
