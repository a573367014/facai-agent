# facai-agent

一个基于 Node.js Fastify 和 React 的工具调用型 Agent Demo。

## 结构

- `apps/api`：Fastify Agent API
- `apps/web`：React Demo 工作台

## 环境变量

复制 `.env.example` 为 `.env`，并填写：

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `AGENT_STORE`：`memory` 或 `sqlite`
- `AGENT_SQLITE_PATH`：SQLite 文件路径，默认 `./data/agent.sqlite`

## 安装

```bash
npm install
```

## 开发

同时启动 API 和 Web：

```bash
npm run dev
```

也可以单独启动 API：

```bash
npm run dev:api
```

单独启动 Web：

```bash
npm run dev:web
```

访问：

- API: `http://localhost:4001`
- Web: `http://localhost:4000`

## 演进路线 / TODO

当前项目已经具备 Agent Demo 的基础能力：Fastify API、React 工作台、SSE 流式事件、session/run、SQLite 持久化、事件压缩、断线恢复和上下文续聊。后续建议按下面顺序演进，优先把 Agent Runtime 的核心能力打稳。

### 1. 工具系统升级

目标：让工具调用从 demo 能力升级成稳定、可扩展、可观测的执行平台。

- [ ] 标准化 Tool 定义：名称、描述、参数 schema、返回结构。
- [ ] 给 Tool 参数增加统一校验，避免非法参数进入工具内部。
- [ ] 给 Tool 执行增加超时控制，防止某个工具长期挂起。
- [ ] 统一 Tool 成功/失败返回格式，例如 `ok`、`data`、`error`、`durationMs`。
- [ ] 记录 Tool 调用日志，方便排查 Agent 为什么这么做。
- [ ] 增加 Tool 权限控制，为后续文件、网络、数据库类工具做准备。
- [ ] 前端更清晰地展示工具调用参数、结果、耗时和错误。

为什么先做它：Agent 的核心价值不只是聊天，而是能可靠地调用工具完成任务。工具层如果不先规范，后面接文件、网页搜索、RAG、数据库查询时，`AgentService` 会越来越难维护。

### 2. Run 生命周期补完整

目标：让用户能控制一次运行，而不是只能等待它自然结束。

- [ ] 支持取消运行：`POST /agents/runs/:runId/cancel`。
- [ ] 支持重试运行：`POST /agents/runs/:runId/retry`。
- [ ] 支持重新生成当前 run 的回答。
- [ ] 支持运行中刷新页面后自动恢复订阅。
- [ ] 支持查看、删除 session 和 run。
- [ ] 后端引入 `AbortController`，让 LLM 请求和工具执行都能响应取消。

为什么做它：真实 LLM 请求和工具调用都可能耗时较久，用户需要停止、重试、恢复这些基本控制能力。

### 3. 上下文管理

目标：从“把所有历史都喂给模型”升级为可控的上下文构建策略。

- [ ] 抽出 `ContextBuilder`，集中负责构造传给 LLM 的 messages。
- [ ] 最近 N 轮保留原文，更早内容改成摘要。
- [ ] 增加 token 预算，避免上下文无限增长。
- [ ] 支持重要事实记忆，保存用户偏好、项目背景等长期信息。
- [ ] 对工具结果做摘要，避免大结果反复进入上下文。

为什么做它：现在同一个 session 下的 completed run 会全部进入新 run 的上下文。短期简单有效，长期会带来 token 成本、上下文窗口和旧信息干扰问题。

### 4. 真实业务能力

目标：在稳定 Runtime 上接入更有用的 Agent 能力。

- [ ] 文件上传和文档问答。
- [ ] 网页搜索工具。
- [ ] 数据库查询工具。
- [ ] 本地知识库 RAG。
- [ ] 多步骤任务计划。
- [ ] 多 Agent 分工。

为什么稍后做它：这些能力很诱人，但都依赖工具治理、持久化、事件追踪和上下文策略。先打地基，再扩业务能力，后面会更稳。

### 5. 评测与回放

目标：让 Agent 行为可以复盘、比较和持续优化。

- [ ] 保存完整 run 输入、事件、工具调用和最终答案。
- [ ] 支持按 run 回放事件流。
- [ ] 增加固定样例集，用来比较不同模型、prompt 和工具策略。
- [ ] 记录失败原因分类，帮助发现系统性问题。

为什么做它：Agent 系统很容易“看起来能跑，但不知道为什么好或坏”。评测和回放能让优化变得可验证。

## 测试

```bash
npm run test
npm run typecheck
npm run build
```
