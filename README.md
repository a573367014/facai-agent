# facai-agent

一个基于 Node.js Fastify 和 React 的工具调用型 Agent Demo。

## 结构

- `apps/api`：Fastify Agent API
- `apps/web`：React Demo 工作台

## 环境变量

复制 `.env.example` 为 `.env`，并填写：

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `AGENT_TOOL_TIMEOUT_MS`：工具调用超时时间，默认 `10000`
- `AGENT_ALLOWED_TOOLS`：允许暴露和执行的工具名，逗号分隔；留空表示允许全部已注册工具
- `TAVILY_API_KEY`：Tavily Search API Key；配置后会启用 `web_search` 工具
- `SEARCH_MAX_RESULTS`：默认搜索结果数量，默认 `5`，范围 `1-10`
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

## 开发约定

- 每次做结构性改造时，都要给核心代码补充“阅读理解型”注释。
- 注释重点解释为什么这么做、边界在哪里、不这么做会有什么问题。
- 避免写重复代码表面的注释，例如“给变量赋值”“调用函数”这类无信息量内容。
- 新增抽象时，需要在抽象入口处说明职责分工，例如目录、执行器、存储、协调器分别负责什么。
- 涉及流式、持久化、工具执行、上下文管理等容易误解的逻辑时，优先补注释，方便后续回看和继续演进。

## 演进路线 / TODO

当前项目已经具备 Agent Demo 的基础能力：Fastify API、React 工作台、SSE 流式事件、session/run、SQLite 持久化、事件压缩、断线恢复和上下文续聊。后续建议按下面顺序演进，优先把 Agent Runtime 的核心能力打稳。

### 1. 工具系统升级

目标：让工具调用从 demo 能力升级成稳定、可扩展、可观测的执行平台。

- [x] 标准化 Tool 定义：名称、描述、参数 schema、返回结构。
- [x] 给 Tool 参数增加统一校验，避免非法参数进入工具内部。
- [x] 给 Tool 执行增加超时控制，防止某个工具长期挂起。
- [x] 统一 Tool 成功/失败返回格式，例如 `ok`、`data`、`error`、`durationMs`。
- [ ] 记录 Tool 调用日志，方便排查 Agent 为什么这么做。
- [x] 增加 Tool 权限控制，为后续文件、网络、数据库类工具做准备。
- [ ] 前端更清晰地展示工具调用参数、结果、耗时和错误。

为什么先做它：Agent 的核心价值不只是聊天，而是能可靠地调用工具完成任务。工具层如果不先规范，后面接文件、网页搜索、RAG、数据库查询时，`AgentService` 会越来越难维护。

当前实现背景：

- `ToolRegistry` 只做工具目录，负责注册、查找、暴露工具定义。
- `ToolExecutor` 负责运行时治理，包括参数校验、权限检查、超时控制、错误包装和耗时记录。
- `ToolAccessPolicy` 负责工具 allow-list；`AgentService` 用它过滤 LLM 可见工具，`ToolExecutor` 用它兜底阻止越权执行。
- 可恢复工具错误会走双通道：`tool_error` 事件给前端做结构化 UI，`role=tool` 错误观察结果回灌给 LLM 生成自然语言回复。
- `web_search` 使用 Tavily Search API 提供通用互联网搜索能力；没有配置 `TAVILY_API_KEY` 时不会注册该工具。
- 选择 allow-list 是为了后续接入文件、网络、数据库等高风险工具时，可以用最小权限方式逐步开放能力。

Tavily 搜索流程：

```txt
用户提出需要实时信息的问题
  -> LLM 看到 web_search 工具并决定搜索 query
  -> ToolExecutor 校验参数、套用超时、执行 Tavily 请求
  -> web_search 返回统一结构：query、answer、results、resultCount
  -> AgentService 把搜索结果作为 role=tool 写回上下文
  -> LLM 基于搜索结果生成中文回答，并尽量附来源链接
```

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
- [x] 网页搜索工具。
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
