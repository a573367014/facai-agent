# facai-agent

一个基于 Node.js Fastify 和 React 的工具调用型 Agent Demo。

## 结构

- `apps/api`：Fastify Agent API
- `apps/web`：React Demo 工作台

## 环境变量

复制 `.env.example` 为 `.env`，并填写：

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `AGENT_CONTEXT_MAX_MESSAGES`：新消息最多携带多少条历史上下文，默认 `12`
- `AGENT_CONTEXT_MAX_HISTORY_CHARS`：历史上下文的近似字符预算，默认 `12000`
- `AGENT_SUMMARY_TRIGGER_MESSAGES`：会话可投影消息超过该数量后触发结构化摘要，默认 `16`；设为 `0` 可关闭摘要更新
- `AGENT_SUMMARY_KEEP_RECENT_MESSAGES`：生成摘要后仍保留的最近原文消息数，默认 `8`
- `AGENT_SUMMARY_TRIGGER_CHARS`：待压缩旧消息的有效文本量达到该字符数才真正压缩，默认 `2000`；设为 `0` 表示只按消息条数判断
- `AGENT_TOOL_TIMEOUT_MS`：工具调用超时时间，默认 `10000`
- `AGENT_ALLOWED_TOOLS`：允许暴露和执行的工具名，逗号分隔；留空表示允许全部已注册工具
- `TAVILY_API_KEY`：Tavily Search API Key；配置后会启用 `web_search` 工具
- `SEARCH_MAX_RESULTS`：默认搜索结果数量，默认 `5`，范围 `1-10`
- `VOLCENGINE_ACCESS_KEY_ID`：火山引擎 Access Key ID；和 SK 同时配置后会启用 `generate_image`
- `VOLCENGINE_SECRET_ACCESS_KEY`：火山引擎 Secret Access Key；只放在本地 `.env`，不要提交
- `VOLCENGINE_IMAGE_ENDPOINT`：火山视觉 OpenAPI 地址，默认 `https://visual.volcengineapi.com`
- `VOLCENGINE_IMAGE_REGION`：签名 Region，默认 `cn-north-1`
- `VOLCENGINE_IMAGE_SERVICE`：签名 Service，默认 `cv`
- `VOLCENGINE_IMAGE_REQ_KEY`：Seedream 通用3.0 文生图服务标识，默认 `high_aes_general_v30l_zt2i`
- `VOLCENGINE_IMAGE_POLL_INTERVAL_MS`：轮询间隔，默认 `1500`
- `VOLCENGINE_IMAGE_MAX_POLL_ATTEMPTS`：最大轮询次数，默认 `40`
- `VOLCENGINE_IMAGE_TOOL_TIMEOUT_MS`：生图工具独立超时时间，默认 `90000`
- `VOLCENGINE_IMAGE_BATCH_CONCURRENCY`：批量生图内部并发数，默认 `2`，范围 `1-5`
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

当前项目已经具备 Agent Demo 的基础能力：Fastify API、React 工作台、SSE 流式事件、session/message、SQLite 持久化、事件压缩、断线恢复和上下文续聊。后续建议按下面顺序演进，优先把 Agent Runtime 的核心能力打稳。

### 1. 工具系统升级

目标：让工具调用从 demo 能力升级成稳定、可扩展、可观测的执行平台。

- [x] 标准化 Tool 定义：名称、描述、参数 schema、返回结构。
- [x] 给 Tool 参数增加统一校验，避免非法参数进入工具内部。
- [x] 给 Tool 执行增加超时控制，防止某个工具长期挂起。
- [x] 统一 Tool 成功/失败返回格式，例如 `ok`、`data`、`error`、`durationMs`。
- [ ] 记录 Tool 调用日志，方便排查 Agent 为什么这么做。
- [x] 增加 Tool 权限控制，为后续文件、网络、数据库类工具做准备。
- [x] 拆分 Tool 完整结果和 LLM 观察文本，避免大结果直接塞进模型上下文。
- [x] 前端更清晰地展示工具调用参数、结果、耗时和错误。

为什么先做它：Agent 的核心价值不只是聊天，而是能可靠地调用工具完成任务。工具层如果不先规范，后面接文件、网页搜索、RAG、数据库查询时，`AgentService` 会越来越难维护。

当前实现背景：

- `ToolRegistry` 只做工具目录，负责注册、查找、暴露工具定义。
- `ToolExecutor` 负责运行时治理，包括参数校验、权限检查、超时控制、错误包装和耗时记录。
- `ToolAccessPolicy` 负责工具 allow-list；`AgentService` 用它过滤 LLM 可见工具，`ToolExecutor` 用它兜底阻止越权执行。
- `ToolOutput.data` 保存完整结构化结果，给前端展示、事件持久化和后续审计使用；`ToolOutput.llmContent` 是工具主动整理出的精简文本，专门作为 `role=tool` 消息回灌给 LLM。
- Web 侧用 `buildToolTraces` 把工具事件聚合成调用轨迹，再按工具类型展示搜索来源、图片预览或通用 JSON，避免用户只能看 raw event。
- 可恢复工具错误会走双通道：`tool_error` 事件给前端做结构化 UI，`role=tool` 错误观察结果回灌给 LLM 生成自然语言回复。
- `web_search` 使用 Tavily Search API 提供通用互联网搜索能力；没有配置 `TAVILY_API_KEY` 时不会注册该工具。
- `generate_image` 使用火山视觉 OpenAPI 的 Seedream 通用3.0 文生图接口；没有同时配置 `VOLCENGINE_ACCESS_KEY_ID` 和 `VOLCENGINE_SECRET_ACCESS_KEY` 时不会注册该工具。
- 选择 allow-list 是为了后续接入文件、网络、数据库等高风险工具时，可以用最小权限方式逐步开放能力。

Tavily 搜索流程：

```txt
用户提出需要实时信息的问题
  -> LLM 看到 web_search 工具并决定搜索 query
  -> ToolExecutor 校验参数、套用超时、执行 Tavily 请求
  -> web_search 返回 ToolOutput：data 是完整搜索结构，llmContent 是精简搜索摘要
  -> AgentService 把 data 发成 tool_result 事件，把 llmContent 作为 role=tool 写回上下文
  -> LLM 基于搜索结果生成中文回答，并尽量附来源链接
```

Seedream 通用3.0 生图流程：

```txt
用户提出画图或生成图片需求
  -> LLM 看到 generate_image 工具并整理 prompt、尺寸等参数
  -> ToolExecutor 校验参数、套用生图工具独立超时
  -> generate_image 使用 AK/SK 生成 HMAC-SHA256 签名并提交 CVSync2AsyncSubmitTask
  -> 拿到 task_id 后轮询 CVSync2AsyncGetResult
  -> 工具返回图片 URL、taskId 和精简 llmContent
  -> AgentService 发出 tool_result，并让 LLM 把图片链接整理成最终中文回复
```

### 2. Message 生命周期补完整

目标：让用户能控制一次 assistant message 的生成，而不是只能等待它自然结束。

- [x] 支持取消生成：`POST /agents/messages/:messageId/cancel`。
- [ ] 支持重试生成：`POST /agents/messages/:messageId/retry`。
- [ ] 支持重新生成当前 assistant message 的回答。
- [ ] 支持运行中刷新页面后自动恢复订阅。
- [ ] 支持查看、删除 session 和 message。
- [ ] 后端引入 `AbortController`，让 LLM 请求和工具执行都能响应取消。

为什么做它：真实 LLM 请求和工具调用都可能耗时较久，用户需要停止、重试、恢复这些基本控制能力。

### 3. 上下文管理

目标：从“把所有历史都喂给模型”升级为可控的上下文构建策略。

- [x] 抽出 `ContextBuilder`，集中负责构造传给 LLM 的 messages。
- [x] 限制最近历史 message 数量，避免同一 session 越聊越长。
- [x] 增加近似字符预算，先用轻量方式控制上下文膨胀。
- [x] 失败 message 保留用户输入和简短失败摘要，避免“再试一次”这类补充指令丢失上下文。
- [x] 中断 message 保留用户输入和“被用户中断”摘要，方便后续继续或改写。
- [x] 最近 N 轮保留原文，更早内容改成结构化摘要。
- [x] 前端 session 消息分页加载，避免长会话一次性返回全量 messages。
- [ ] 增加 token 预算，避免上下文无限增长。
- [ ] 支持重要事实记忆，保存用户偏好、项目背景等长期信息。
- [ ] 对工具结果做摘要，避免大结果反复进入上下文。

为什么做它：如果同一个 session 下的历史 message 全部进入新 message 上下文，短期简单有效，长期会带来 token 成本、上下文窗口和旧信息干扰问题。

当前实现背景：

- `AgentMessageCoordinator` 只决定“新 message 需要同 session 历史”，并按摘要 cursor 只读取需要进入上下文的最近消息。
- `AgentContextBuilder` 负责筛选可进入上下文的 message、按时间排序、按最近条数和字符预算裁剪，并把结构化摘要渲染成 system message。
- `AgentSummaryService` 在 assistant message 完成后按阈值刷新结构化摘要；未超过阈值时只做 count，不读取全量 messages。
- `GET /agents/sessions/:sessionId` 默认只返回最近一页消息和 `pageInfo`；`GET /agents/sessions/:sessionId/messages?before=...&limit=...` 用于向前分页加载历史消息。
- completed message 会进入上下文为原始消息内容；failed message 会进入上下文为简短失败摘要；cancelled message 会进入上下文为被用户中断摘要。
- running message 不进入上下文，避免把尚未完成的并发状态喂给新 message。
- 最近一轮历史即使超过字符预算也会保留，避免用户刚问过的关键上下文突然消失。
- 目前字符预算是轻量 guardrail，不是严格 tokenizer；后续可以在这个抽象内升级为真实 token 预算或摘要策略。

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

- [ ] 保存完整 message 输入、事件、工具调用和最终答案。
- [ ] 支持按 message 回放事件流。
- [ ] 增加固定样例集，用来比较不同模型、prompt 和工具策略。
- [ ] 记录失败原因分类，帮助发现系统性问题。

为什么做它：Agent 系统很容易“看起来能跑，但不知道为什么好或坏”。评测和回放能让优化变得可验证。

## 测试

```bash
npm run test
npm run typecheck
npm run build
```
