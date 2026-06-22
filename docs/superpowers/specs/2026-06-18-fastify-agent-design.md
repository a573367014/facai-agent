# Fastify Agent 架构设计

## 目标

基于 Node.js Fastify 实现一个轻量的 LLM 工具调用型 Agent 服务，并提供一个 React Demo 界面用于本地调试和演示。第一版要做到结构清晰、容易测试、容易扩展，后续可以继续增加更多工具、模型供应商、记忆、异步任务或多 Agent 协作。

## 范围

第一版实现同步的请求-响应式 Agent：

- 通过 `POST /agents/run` 接收用户任务。
- 请求 LLM Provider，让模型返回最终答案或工具调用。
- 通过 Tool Registry 执行本地工具。
- 将工具结果追加回对话，再交给模型生成最终答案。
- 返回最终答案和执行步骤。
- 提供一个 React Demo 页面，能输入任务、设置最大迭代次数、提交到后端，并展示最终答案、工具调用步骤和错误信息。

第一版不实现持久化记忆、异步队列、可恢复会话、用户系统、流式响应、多 Agent 协作，也不做登录态或复杂前端路由。架构上保留这些扩展点，但不提前复杂化。

## 架构边界

服务拆成五个边界：

1. Fastify HTTP 层
   - 负责请求校验、响应格式和路由注册。
   - 不关心具体模型供应商的 API 细节。

2. Agent Core
   - 负责 agent loop。
   - 组装 messages，暴露 tools schema，执行 tool calls，记录执行步骤。
   - 根据配置限制最大迭代次数。

3. LLM Provider Adapter
   - 负责和 OpenAI-compatible Chat Completions API 通信。
   - 将内部 message 和 tool 定义转换成 provider 请求。
   - 将 provider 响应转换成内部统一格式。

4. Tool Registry
   - 负责注册、查找和执行工具。
   - 校验工具名和参数。
   - 返回可序列化的工具执行结果。

5. React Demo UI
   - 负责提供本地可视化调试界面。
   - 通过 HTTP 调用 Fastify API。
   - 不内置 agent 业务逻辑，也不直接调用模型。

目录结构参考 Eve 的“agent 是目录”的思路，但不直接依赖 Eve：

```text
apps/
  api/
    src/
      app.ts
      server.ts
      config/
        env.ts
      agent/
        agent-service.ts
        instructions.ts
        types.ts
      providers/
        openai-compatible-provider.ts
        types.ts
      tools/
        index.ts
        registry.ts
        calculator.ts
        current-time.ts
      routes/
        health-routes.ts
        agent-routes.ts
    test/
      agent/
      routes/
      tools/
  web/
    src/
      api/
        agent-client.ts
      components/
        AgentRunForm.tsx
        AgentResultPanel.tsx
        AgentSteps.tsx
      App.tsx
      main.tsx
      styles.css
```

根目录使用 npm workspaces 管理 `apps/api` 和 `apps/web`。第一版不抽 `packages/shared`，避免为了少量类型提前引入额外复杂度；前后端各自维护必要的请求和响应类型。

## HTTP API

### `GET /health`

返回服务健康状态：

```json
{
  "status": "ok"
}
```

### `POST /agents/run`

请求：

```json
{
  "input": "计算 12 * 9，然后告诉我现在几点",
  "maxIterations": 4
}
```

响应：

```json
{
  "answer": "12 * 9 等于 108。当前时间是 ...",
  "steps": [
    {
      "type": "tool_call",
      "toolName": "calculator",
      "arguments": {
        "expression": "12 * 9"
      },
      "result": {
        "value": 108
      }
    }
  ]
}
```

校验规则：

- `input` 必填，必须是非空字符串。
- `maxIterations` 可选，默认值为 `4`。
- `maxIterations` 必须在 `1` 到 `8` 之间。

## Agent Loop

AgentService 接收 `input` 和可选的 `maxIterations`。

初始上下文包含：

- 来自 `apps/api/src/agent/instructions.ts` 的 system instruction。
- 用户输入对应的 user message。
- Tool Registry 提供的 tools schema。

每轮循环：

1. 调用 LLM Provider。
2. 如果模型返回最终文本，停止并返回结果。
3. 如果模型返回 tool calls，从 Tool Registry 查找工具。
4. 执行工具并拿到结果。
5. 将工具结果追加到 messages。
6. 继续下一轮，直到得到最终文本或达到最大迭代次数。

如果达到 `maxIterations` 仍没有最终答案，返回受控错误，错误码为 `AGENT_MAX_ITERATIONS`。

## React Demo UI

Demo 使用 Vite + React + TypeScript 实现，作为本地调试界面。

首屏就是可用的 Agent 调试台，不做 landing page：

- 顶部显示服务名和后端健康状态。
- 左侧是任务输入区：
  - 多行输入框填写 `input`。
  - 数字输入或 stepper 设置 `maxIterations`。
  - 提交按钮在请求中禁用，并显示 loading 状态。
- 右侧是结果区：
  - 展示最终 `answer`。
  - 展示 `steps` 时间线，每个 tool call 显示工具名、参数和结果。
  - 展示错误码和错误信息。
- 底部或侧栏提供几个示例 prompt，方便快速试用计算器和当前时间工具。

前端通过 `VITE_API_BASE_URL` 配置 API 地址，开发环境默认请求 `http://localhost:3000`。Vite dev server 使用 `5173` 端口。

后端启用 Fastify CORS，开发环境允许 `http://localhost:5173` 调用 API。生产环境如果需要同源部署，可以让 Fastify 挂载 `apps/web/dist` 静态文件；第一版开发态先保持 API 和 Web 两个 dev server 分开运行。

Demo UI 需要体现这是一个工作台，而不是营销页：布局紧凑、信息清楚、状态明确，避免大面积装饰和无意义介绍文案。

## 内置工具

第一版内置两个简单工具。

### `calculator`

输入：

```json
{
  "expression": "12 * 9"
}
```

输出：

```json
{
  "value": 108
}
```

计算器只支持安全的算术表达式：数字、空白、括号、`+`、`-`、`*`、`/`、`%`。其他字符全部拒绝。

### `current_time`

输入：

```json
{
  "timezone": "Asia/Shanghai"
}
```

输出：

```json
{
  "iso": "2026-06-18T..."
}
```

`timezone` 可选，默认值为 `UTC`。

## 配置

环境变量：

- `PORT`：HTTP 端口，默认 `3000`。
- `HOST`：HTTP host，默认 `0.0.0.0`。
- `OPENAI_API_KEY`：真实调用模型时必填。
- `OPENAI_BASE_URL`：默认 `https://api.openai.com/v1`。
- `OPENAI_MODEL`：真实调用模型时必填。
- `AGENT_MAX_ITERATIONS`：默认 `4`。
- `VITE_API_BASE_URL`：React Demo 调用后端的地址，默认 `http://localhost:3000`。

Provider 必须支持依赖注入，这样测试可以使用 mock provider，不需要访问网络。

## 错误处理

错误统一返回 JSON：

```json
{
  "error": {
    "code": "TOOL_NOT_FOUND",
    "message": "Tool not found: unknown_tool"
  }
}
```

第一版错误码：

- `VALIDATION_ERROR`
- `PROVIDER_ERROR`
- `TOOL_NOT_FOUND`
- `TOOL_EXECUTION_ERROR`
- `AGENT_MAX_ITERATIONS`

## 测试策略

使用 Vitest 做单元测试和路由测试。测试覆盖：

- Tool Registry 的注册和查找。
- Calculator 接受安全算术表达式，并拒绝不安全表达式。
- AgentService 能执行 provider 请求的工具调用，并返回最终答案。
- AgentService 达到最大迭代次数时返回 `AGENT_MAX_ITERATIONS`。
- Fastify route 能校验错误请求，并能通过 mock provider 返回成功响应。
- React Demo 能提交输入、展示成功结果、展示 tool steps、展示错误状态。

Provider 测试使用 mock，不依赖真实网络。

## 后续扩展

架构需要方便后续添加：

- `POST /agents/run` 的流式输出。
- 持久化会话记忆。
- 基于队列的异步任务和状态查询 API。
- 敏感工具执行前的人类确认。
- Planner / Executor / Reviewer 等多 Agent 角色。
- 共享类型包 `packages/shared`，在 API 和 Web 之间复用 DTO。
- 如果后续 durable execution 成为核心需求，可以增加 Eve adapter 或迁移到 Eve。
