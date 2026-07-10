# 工具系统升级实施计划

> **面向智能体执行者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐项实施本计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 将工具执行从简单的注册表调用升级为小型运行时层，提供校验、超时、结构化错误、耗时跟踪和更清晰的事件。

**架构：** 保留 `ToolRegistry` 作为工具目录，并新增 `ToolExecutor` 作为运行时执行边界。`AgentService` 将调用执行器，而不再直接调用注册表执行；现有 React 时间线则读取增强后的事件。

**技术栈：** TypeScript、Fastify、Vitest、zod、React。

---

### 任务 1：ToolExecutor 行为

**文件：**
- 创建：`apps/api/src/tools/types.ts`
- 创建：`apps/api/src/tools/executor.ts`
- 创建：`apps/api/test/tools/executor.test.ts`
- 修改：`apps/api/src/tools/registry.ts`

- [x] 为执行成功、参数无效、工具缺失、抛出错误和超时编写失败测试。
- [x] 运行 `npm run test -w @agent/api -- test/tools/executor.test.ts`，验证新测试因 `ToolExecutor` 不存在而失败。
- [x] 实现最小化的工具类型和执行器。
- [x] 运行执行器测试并验证通过。

### 任务 2：现有工具迁移

**文件：**
- 修改：`apps/api/src/tools/calculator.ts`
- 修改：`apps/api/src/tools/current-time.ts`
- 修改：`apps/api/src/tools/index.ts`
- 修改：`apps/api/test/tools/calculator.test.ts`
- 修改：`apps/api/test/tools/registry.test.ts`

- [x] 更新现有工具，使其导出新的 `ToolDefinition` 结构。
- [x] 保持它们的公开行为不变。
- [x] 运行 `npm run test -w @agent/api -- test/tools`。

### 任务 3：AgentService 集成

**文件：**
- 修改：`apps/api/src/agent/agent-service.ts`
- 修改：`apps/api/src/agent/types.ts`
- 修改：`apps/api/src/app.ts`
- 修改：`apps/api/src/config/env.ts`
- 修改：`.env.example`
- 修改：`apps/api/test/agent/agent-service.test.ts`
- 修改：`apps/api/test/routes/agent-routes.test.ts`

- [x] 用 `toolExecutor.execute` 替换对 `toolRegistry.execute` 的直接调用。
- [x] 在工具事件中包含 `toolCallId`、`durationMs` 和结构化错误详情。
- [x] 添加 `AGENT_TOOL_TIMEOUT_MS`，默认值为 10000。
- [x] 运行 API 测试并修复集成失败。

### 任务 4：前端时间线

**文件：**
- 修改：`apps/web/src/components/AgentTimeline.tsx`
- 修改：`apps/web/src/api/agent-client.ts`
- 修改：`apps/web/src/App.test.tsx`

- [x] 扩展客户端类型，使其支持增强后的工具事件。
- [x] 在存在时显示工具耗时、结构化错误码和可恢复状态。
- [x] 运行 Web 测试。

### 任务 5：最终验证

**文件：**
- 仅当实现与设计不同时修改文档。

- [x] 运行 `npm run test`。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run build`。
- [x] 检查 `git diff`，确认没有意外泄露密钥或引入无关改动。
