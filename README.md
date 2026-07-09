# facai-agent

一个基于 Node.js Fastify 和 React 的工具调用型 Agent 本地开发版。当前使用 PostgreSQL（pgvector 扩展）保存会话、消息、run、工具调用、资源索引和任务进度；Redis 负责运行时协调、事件广播、取消标记、执行锁和 BullMQ run 队列；Agent 过程事件通过 OpenTelemetry logs 进入 Loki/Grafana。消息渲染以 `message.parts` 快照为准，`agent_resources` 负责资源索引、审计和聚合查询；工具生成的图片 / 视频会转储到 S3 兼容对象存储（开发用 MinIO，生产可换 Cloudflare R2 或 AWS S3），避免长期依赖供应商临时 URL。架构边界按后续替换 MySQL / OSS / SLS 的产品化方向设计。

## 结构

- `apps/api`：Fastify Agent API
- `apps/web`：React Demo 工作台

## 环境变量

复制 `.env.example` 为 `.env`，日常只需要关注这些配置：

- `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`：聊天模型接口配置。
- `EMBEDDING_PROVIDER`：embedding 提供方，默认 `openai-compatible`；本地知识库推荐设为 `ollama`。
- `OLLAMA_BASE_URL`、`OLLAMA_EMBEDDING_MODEL`：`EMBEDDING_PROVIDER=ollama` 时使用，默认分别是 `http://localhost:11434` 和 `embeddinggemma`。
- `OPENAI_EMBEDDING_API_KEY`、`OPENAI_EMBEDDING_BASE_URL`、`OPENAI_EMBEDDING_MODEL`：`EMBEDDING_PROVIDER=openai-compatible` 时使用；未配置前两项时会复用聊天模型的 key 和 base URL。
- `REDIS_URL`：Redis 连接地址，默认 `redis://localhost:6379`。产品化运行时固定依赖 Redis，不再提供切换底层实现的开发态开关。
- `AGENT_WORKER_CONCURRENCY`：Worker 同时执行 run 的数量，默认 `2`。
- `DATABASE_URL`：PostgreSQL 连接串，默认 `postgres://postgres:postgres@localhost:5432/agent`。需要安装 pgvector 扩展。
- `AGENT_UPLOAD_DIR`：用户上传和工具资源转储目录，默认 `./data/uploads`。
- `GITHUB_OAUTH_CLIENT_ID`、`GITHUB_OAUTH_CLIENT_SECRET`、`GITHUB_OAUTH_REDIRECT_URI`：GitHub OAuth 登录配置。兼容旧的 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_REDIRECT_URI` 命名。
- `VITE_GITHUB_OAUTH_CLIENT_ID`、`VITE_GITHUB_OAUTH_REDIRECT_URI`：前端跳转 GitHub OAuth 授权页使用；client id 是公开值，client secret 只放后端环境变量。
- `JWT_ACCESS_SECRET`、`JWT_REFRESH_SECRET`：JWT 签名密钥；生产环境必须使用不同的长随机字符串。
- `AUTH_ACCESS_TOKEN_TTL_SECONDS`、`AUTH_REFRESH_TOKEN_TTL_SECONDS`：JWT 过期时间，access token 默认 15 分钟，refresh token 默认 15 天（`1296000` 秒）。
- `TAVILY_API_KEY`：配置后启用 `web_search` 工具。
- `VOLCENGINE_ACCESS_KEY_ID`、`VOLCENGINE_SECRET_ACCESS_KEY`：同时配置后启用图片 / 视频生成工具。
- `AGENT_ALLOWED_TOOLS`：允许暴露和执行的工具名，逗号分隔；留空表示允许全部已注册工具。
- `VITE_API_BASE_URL`：前端 API 地址；留空时自动按当前 Web host 推导到 `4001`。
- `OTEL_EXPORTER_OTLP_ENDPOINT`、`GRAFANA_PORT`：本地观测配置，默认分别是 `http://localhost:4318` 和 `3001`；`3001` 用于避开常见的 `3000` 端口占用。Agent 过程事件不再写本地 JSONL 文件，排查入口统一放到 Grafana/Loki。

Agent 上下文窗口、摘要触发阈值、Redis TTL、队列名和工具超时都有代码默认值；即梦供应商 endpoint / req key 这类稳定参数固定在工具默认配置里，后续确实需要切换时再单独开放配置层。

## 安装

```bash
pnpm install
```

## 开发

同时启动 API、Web 和 Worker：

```bash
pnpm run dev
```

根目录 `pnpm run dev` 会先检查本机运行时依赖：本机 Redis 未启动时会自动启动；当 `EMBEDDING_PROVIDER=ollama` 时，也会自动检查 Ollama、启动本机服务，并在缺少模型时拉取 `OLLAMA_EMBEDDING_MODEL`。

也可以按需单独启动：

```bash
pnpm run dev:api
pnpm run dev:web
pnpm run dev:worker
```

访问：

- API: `http://localhost:4001`
- Web: `http://localhost:4000`
- Grafana: `http://localhost:3001`（账号 `admin` / `admin`，可用 `GRAFANA_PORT` 覆盖）

如果用局域网 IP 访问 Web，例如 `http://10.1.65.46:4000`，前端会自动把 API 推导为 `http://10.1.65.46:4001`。`VITE_API_BASE_URL` 留空即可自动推导；后端默认允许 `localhost`、`127.0.0.1` 和局域网 IP 的 Origin，方便本地联调。只有部署到独立 API 域名时才需要显式配置 `VITE_API_BASE_URL`，同时用 `CORS_ORIGINS=https://your-web.example.com` 收紧后端 CORS 白名单。

## 本地知识库

右侧“知识库”面板支持上传 PDF、Word、Markdown 和 TXT 文档。上传后 API 会写入 `knowledge_documents`，再通过 Worker 后台解析、切块、生成 embedding 并写入 `knowledge_chunks`；状态变为 `ready` 后，Agent 才能通过 `knowledge_search` 工具检索到这些内容。聊天区隐藏知识库检索过程，最终回答应保留来源。

本地 embedding 使用 Ollama 原生 `/api/embed` 接口。日常使用根目录 `pnpm run dev` 会自动准备 Ollama 服务和模型；也可以手动提前拉取模型：

```bash
ollama pull embeddinggemma
```

可以用下面的命令检查本地 embedding 是否可用：

```bash
curl http://localhost:11434/api/embed \
  -H "Content-Type: application/json" \
  -d '{"model":"embeddinggemma","input":["请假流程是什么？"]}'
```

知识库索引依赖 Worker 消费 BullMQ 任务。日常使用根目录 `pnpm run dev` 会同时启动 API、Web 和 Worker；如果只启动 API/Web，上传的文档会停留在 `pending`，直到 Worker 启动并消费索引任务。

## 接口分页约定

普通列表接口统一返回：

```json
{
  "pageInfo": {
    "hasMore": true,
    "nextCursor": "cursor_id",
    "limit": 30
  }
}
```

- `hasMore` 是是否还能继续加载的权威字段。
- `nextCursor` 只在 `hasMore: true` 时返回，表示下一页请求要带的游标。
- 请求参数可以按读取方向命名，例如会话列表使用 `after=pageInfo.nextCursor`，历史消息向上翻页使用 `before=pageInfo.nextCursor`；但响应结构始终保持 `pageInfo.hasMore / pageInfo.nextCursor / pageInfo.limit`。
- SSE 事件流里的 `after` 是事件序号续传游标，不按列表分页协议处理。

## 开发约定

- 每次做结构性改造时，都要给核心代码补充“阅读理解型”注释。
- 注释重点解释为什么这么做、边界在哪里、不这么做会有什么问题。
- 避免写重复代码表面的注释，例如“给变量赋值”“调用函数”这类无信息量内容。
- 新增抽象时，需要在抽象入口处说明职责分工，例如目录、执行器、存储、协调器分别负责什么。
- 涉及流式、持久化、工具执行、上下文管理等容易误解的逻辑时，优先补注释，方便后续回看和继续演进。

## Redis Runtime 链路阅读

当前执行链路已经收口成 `run`，不再存在“直接启动 message 执行”的并行入口。`message` 仍然是持久化内容模型：用户输入、助手回答、系统压缩提示都会落成 message；但一次可取消、可订阅、可由 Worker 执行的任务单位是 run。

一次用户提交的主链路：

1. 前端调用 `POST /agents/runs` 或 `POST /agents/sessions/:sessionId/runs`。
2. API 在 PostgreSQL 创建 user message、assistant running message 和 run。
3. API 在 Redis 初始化 running draft，用来保存生成中的 assistant parts。
4. API 把 run job 投递到 BullMQ 队列，HTTP 请求立即返回 run 信息。
5. 前端连接 `GET /agents/runs/:runId/stream`，API 先返回当前 assistant snapshot，再订阅 Redis Pub/Sub。
6. Worker 从 BullMQ 取 job，通过 run lock 抢占执行权，避免同一个 run 被多个 Worker 同时执行。
7. Worker 调用 LLM 和工具；文本 delta 写 Redis running draft，关键事件通过 OTel logs 进入 Loki/Grafana，同时通过 Redis Pub/Sub 推给 API。
8. 用户取消时，API 写 Redis cancel key 并中断本进程内 controller；Worker 每隔一段执行点检查 cancel key。
9. Worker 得到最终答案后，把 assistant message 最终 parts 写回 PostgreSQL，删除 Redis running draft，写入 `run_completed`。
10. API SSE 收到终态事件后结束连接；刷新页面时用 Redis/PostgreSQL snapshot 恢复视图，不做历史事件全量回放。

这几个 Redis 组件分别只管短期运行态：

- `RedisRunningMessageStateStore`：保存运行中 assistant draft。原因是文本 delta 很频繁，不应该每个字都写 PostgreSQL。
- `RedisAgentEventBus`：用 run channel 做跨进程事件扇出。Worker 不直接连前端，只发布事件给 API。
- `BullMqAgentRunQueue`：把“要执行哪个 run”交给 Worker。job payload 只放 id，真实上下文仍从 PostgreSQL 读取。
- `RedisAgentCancellationStore`：保存取消标记，让 API 和 Worker 即使不在同一进程也能协作取消。
- `RedisAgentRunLock`：给 run 加执行锁，降低 BullMQ 重复投递或 Worker 重启导致的重复执行风险。

PostgreSQL 仍然是最终可信的数据源：session、message、run、tool calls、resources、process steps 都在 PostgreSQL；Agent 过程排查看 Grafana/Loki；Redis 里的内容都可以过期或丢失，最多影响运行中的实时体验，不应该成为最终审计依据。

## 演进路线 / TODO

当前项目已经具备 Agent 本地开发版的基础能力：Fastify API、React 工作台、SSE 流式事件、session/message、PostgreSQL 持久化、运行中 draft、资源索引表、工具调用表、事件压缩、断线恢复、上下文续聊、图片 / 视频生成、对象存储转储和图片引用。后续建议按产品化顺序演进，优先把 Agent Runtime、数据层和资源体系打稳。

如果当前阶段更偏“学习 Agent 怎么工作”，优先级可以和产品化路线稍微错开：先做生成模型调用链路审计、固定样例评测、上下文预算和工具结果摘要。这几项能把一次 run 为什么成功、为什么失败、上下文里带了什么、工具结果如何影响下一步暴露出来，比先做登录、对象存储、队列拆分更能帮助理解 Agent 的核心机制。多步骤任务计划也很适合学习，但最好等 trace 和评测基线先落地，否则失败时很难判断问题出在 planning、上下文、工具、资源处理还是生成模型本身。

学习优先级建议：

1. 生成模型调用链路审计与 trace：重点串起 message、run、图片/视频工具调用、供应商请求、资源落库和最终答案；LLM 调用先只记录必要状态、模型名和耗时，成本暂不作为重点。
2. 固定样例集与评测脚本：用稳定任务比较不同模型、prompt 和工具策略，避免只凭单次体验判断效果。
3. 上下文 token 预算和工具结果摘要：学习 Agent 如何选择把什么信息放进模型上下文，以及如何避免工具大结果反复污染上下文。
4. 多步骤任务计划：在可观测基础上学习 planning / acting / observing 的循环，而不是一开始就在长链路里盲调。
5. 数据库、队列、用户权限、对象存储等产品化能力：真实上线前很重要，但对理解 Agent 核心行为的直接帮助稍弱，可以稍后做。

### 1. Agent Runtime 稳定化

目标：让一次 run 的生命周期稳定可恢复，并把长时间运行的 Agent 任务从 API 进程里拆出来，支持更可靠的并发和扩容。

- [x] 支持取消生成：`POST /agents/runs/:runId/cancel`。
- [x] 后端引入 `AbortController`，让 LLM 请求和工具执行都能响应取消。
- [x] 运行中刷新页面后自动恢复订阅，并先返回 `message.snapshot`。
- [x] 抽出 `RunningMessageStateStore`，运行中 full draft 不再每个 delta 写入持久化 message。
- [x] 实现 `RedisRunningMessageStateStore`，用 Redis 保存运行中 full draft。
- [x] Redis append / setParts 使用 Lua 脚本原子更新 version、updatedAt 和 TTL。
- [x] 给 snapshot / delta 增加 version，前端可判断乱序或重复事件。
- [x] 收紧 run/message 状态机，明确 running、completed、failed、cancelled 的合法流转。
- [x] 支持重新生成当前 assistant message 的回答。
- [x] 支持删除 session。

为什么先做它：Agent 产品最核心的是“生成中不断、刷新不丢、失败可解释、用户可控制”。运行态和状态机稳定后，接工具、资源、RAG、队列都会更稳。

### 2. 工具系统升级

目标：让工具调用从 demo 能力升级成稳定、可扩展、可观测的执行平台。

- [x] 标准化 Tool 定义：名称、描述、参数 schema、返回结构。
- [x] 给 Tool 参数增加统一校验，避免非法参数进入工具内部。
- [x] 给 Tool 执行增加超时控制，防止某个工具长期挂起。
- [x] 统一 Tool 成功/失败返回格式，例如 `ok`、`data`、`error`、`durationMs`。
- [x] 记录 Tool 调用日志，方便排查 Agent 为什么这么做。
- [x] 增加 Tool 权限控制，为后续文件、网络、数据库类工具做准备。
- [x] 拆分 Tool 完整结果和 LLM 观察文本，避免大结果直接塞进模型上下文。
- [x] 前端更清晰地展示工具调用参数、结果、耗时和错误。
- [ ] 增加生成模型调用审计与成本核算，重点记录图片 / 视频生成工具和供应商调用的状态、失败类型、错误码、耗时、用量和估算费用，用于失败率对账、调用量统计和成本核算；LLM 调用成本较低且可控，先只保留必要链路信息。
- [ ] 增加工具级重试策略，只对幂等且安全的工具开放。
- [ ] 增加工具执行前确认机制，文件写入、数据库修改等高风险工具必须二次确认。

为什么做它：Agent 的核心价值不只是聊天，而是能可靠地调用工具完成任务。工具层如果不先规范，后面接文件、网页搜索、RAG、数据库查询时，`AgentService` 会越来越难维护。调用审计和成本核算主要服务排查和运营分析，不要求展示在前端聊天工具卡片里；现阶段重点放在图片 / 视频等生成模型，因为它们更容易出现供应商任务失败、轮询超时、资源转储失败和成本波动。LLM 调用仍需要串在 trace 里，但先不做精细成本核算。

### 3. 数据层产品化

目标：从本地开发存储升级为可迁移、可审计、可扩展的数据模型（已落地 PostgreSQL + pgvector）。

- [x] 用 `AgentStore` 隔离业务层和具体数据库实现。
- [x] message 使用 `parts` 保存结构化内容，支持文本、图片和后续附件。
- [x] 增加 `agent_tool_calls`，支持按工具调用做审计和聚合查询。
- [x] 增加 `agent_resources`，作为资源索引、审计和聚合表；`message.parts` 保留渲染快照，例如 `url`、`mime`、`name`、`extra.resourceId`。
- [x] 移除 event 表，Agent 过程事件不再进业务库，观测事件统一走 OTel logs/Loki。
- [x] 设计 PostgreSQL schema 初始化方案：进程启动时跑 `initializeSchema`，用 `CREATE TABLE / EXTENSION / INDEX IF NOT EXISTS` 幂等建表，并用 `migrateVectorDimension` 处理向量列维度变更。
- [x] 增加数据库连接池、事务边界和索引设计（`pg.Pool` 连接池、`BEGIN/COMMIT/ROLLBACK` 事务、`CREATE INDEX` 索引）。
- [ ] 引入版本化 migration 工具（如 `node-pg-migrate` / `drizzle-kit`），支持破坏性变更（删列 / 改类型 / 重命名）、数据回填、回滚和迁移历史审计；当前自愈式建表只能追加表和索引，无法处理破坏性变更。
- [ ] 增加用户 / 租户字段，为后续多用户隔离做准备。

为什么做它：本地开发存储适合起步，但产品化需要连接池、迁移、索引、事务和数据隔离。当前已落地 PostgreSQL + pgvector，并通过 `AgentStore` 接口保留可替换数据库实现的能力。

### 4. 上下文管理

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
- [ ] 根据当前任务检索相关资源和历史事实，而不是只按时间窗口取上下文。

为什么做它：如果同一个 session 下的历史 message 全部进入新 message 上下文，短期简单有效，长期会带来 token 成本、上下文窗口和旧信息干扰问题。

### 5. 资源和附件系统

目标：让图片、文件、链接等资源成为一等对象，而不是散落在 Markdown 或工具结果里。

- [x] 图片生成结果写入 `agent_resources`。
- [x] 视频生成结果写入 `agent_resources`。
- [x] assistant message 的 media part 保留 `url`、`mime`、`name` 等渲染快照，并通过 `extra.resourceId` 关联资源索引。
- [x] 工具生成图片 / 视频转储到 S3 兼容对象存储（`S3ToolResourceStorage`），避免长期依赖供应商临时 URL。
- [x] 前端图片预览支持下载、复制、引用、删除等资源交互。
- [x] 支持用户上传图片。
- [x] 支持前端引用图片到输入框，并按 message parts 提交。
- [x] 接入 S3 兼容对象存储 / CDN，替换本地 uploads 转储（开发用 MinIO，生产可换 Cloudflare R2 或 AWS S3）。

为什么做它：资源是 Agent 产品从聊天走向创作和工作流的关键。资源独立后，工具调用、上下文引用、审计和 UI 交互都会更清晰。

### 6. 真实业务能力

目标：在稳定 Runtime 上接入更有用的 Agent 能力。

- [x] 文件上传和文档问答（本地知识库支持上传 PDF / Word / Markdown / TXT，通过 `knowledge_search` 工具检索问答）。
- [x] 网页搜索工具。
- [x] 图片生成工具。
- [x] 视频生成工具。
- [ ] 数据库查询工具。
- [x] 本地知识库 RAG（文档解析、切块、embedding、向量检索、来源引用）。
- [ ] 多步骤任务计划。
- [ ] 多 Agent 分工。

为什么稍后做它：这些能力很诱人，但都依赖工具治理、持久化、事件追踪和上下文策略。先打地基，再扩业务能力，后面会更稳。

### 7. Worker 和队列

目标：把长时间运行的 Agent 任务从 API 进程里拆出来，支持更可靠的并发和扩容。

- [x] 引入 BullMQ run 队列。
- [x] API 只负责创建 run/message 和投递任务，不长期执行模型调用。
- [x] Worker 负责 LLM 调用、工具执行、running draft 更新和最终落库。
- [x] Worker 支持并发配置，并通过 Redis run lock 降低重复执行风险。
- [x] SSE gateway 先返回 message snapshot，再从 Redis Pub/Sub 接收实时运行事件。
- [x] 增加 BullMQ 队列深度观测指标，并接入 Grafana 大盘。
- [ ] 增加任务重试和 worker 心跳。

为什么做它：真实 Agent 任务可能很长，API 进程不适合长期承载所有执行逻辑。队列化后可以让 API 专注请求和 SSE，让 Worker 独立扩容和恢复。

### 8. 评测与观测

目标：让 Agent 行为可以排查、比较和持续优化。

- [x] 保存 message 输入、工具调用、资源、任务进度和最终答案。
- [x] Agent 过程事件通过 OTel logs 写入 Loki，可在 Grafana 查询。
- [x] 增加 Agent Runtime OTel 指标和 Grafana 大盘，覆盖 run、LLM 调用、工具调用、资源转储和队列深度。
- [x] 在 run / LLM / tool / resource 转储 span 和 OTel log 里补充 runId、messageId、toolCallId、traceContext 等关联字段，方便从大盘下钻到具体链路和 Loki 日志。
- [ ] 增加固定样例集，用来比较不同模型、prompt 和工具策略。
- [ ] 记录失败原因分类，帮助发现系统性问题。
- [ ] 增加 PostgreSQL 长期审计统计，支持按天、供应商、生成模型、工具、状态、失败类型聚合，观察日均调用量、失败率、延迟分布和估算成本；LLM 统计先保持轻量，用来辅助串联一次 run。
- [ ] 增加 requestId，并在 API 响应、事件日志和前端错误展示里统一暴露。

注意：当前产品方向不做完整 delta 回放。实时恢复依赖 `message.snapshot` + running draft；过程事件只做 live 观测和 Loki/Grafana 排查，不作为用户界面恢复源。

### 9. 用户、权限和产品 UI

目标：从单机本地工作台升级为多用户可用的产品形态。

- [ ] 登录和用户体系。
- [ ] session、message、resource 按 user / tenant 隔离。
- [ ] 工具权限按用户或团队配置。
- [ ] API rate limit 和用量额度。
- [ ] 普通用户模式隐藏 raw event，开发者模式显示事件时间线和原始事件。
- [ ] 增加设置页，管理模型、工具、密钥和资源策略。

为什么做它：本地 Demo 可以默认信任所有操作，产品化必须考虑身份、权限、限流、用量、密钥和不同用户的 UI 复杂度。

## 测试

```bash
pnpm test
pnpm run typecheck
pnpm run build
```
