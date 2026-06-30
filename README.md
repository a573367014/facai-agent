# facai-agent

一个基于 Node.js Fastify 和 React 的工具调用型 Agent 本地开发版。当前默认使用 SQLite 保存会话、消息、工具调用、资源索引和短期事件日志；运行中 assistant draft 默认走内存，也可以通过配置切到 Redis。消息渲染以 `message.parts` 快照为准，`agent_resources` 负责资源索引、审计和聚合查询；工具生成的图片 / 视频会先转储到本地 uploads，避免供应商临时 URL 短时间失效。架构边界按后续替换 MySQL / Redis / OSS 的产品化方向设计。

## 结构

- `apps/api`：Fastify Agent API
- `apps/web`：React Demo 工作台

## 环境变量

复制 `.env.example` 为 `.env`，并填写：

- `PORT`：API 服务端口，默认 `4001`
- `HOST`：API 监听地址，默认 `0.0.0.0`
- `CORS_ORIGINS`：允许跨域访问的 Origin，逗号分隔；留空时允许本地和局域网开发地址
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`：OpenAI 兼容接口地址，默认 `https://api.openai.com/v1`
- `OPENAI_MODEL`
- `AGENT_MAX_ITERATIONS`：单次 Agent 最多循环调用 LLM / 工具的轮数，默认 `4`
- `AGENT_CONTEXT_MAX_MESSAGES`：新消息最多携带多少条历史上下文，默认 `12`
- `AGENT_CONTEXT_MAX_HISTORY_CHARS`：历史上下文的近似字符预算，默认 `12000`
- `AGENT_SUMMARY_TRIGGER_MESSAGES`：会话可投影消息超过该数量后触发结构化摘要，默认 `16`；设为 `0` 可关闭摘要更新
- `AGENT_SUMMARY_KEEP_RECENT_MESSAGES`：生成摘要后仍保留的最近原文消息数，默认 `8`
- `AGENT_SUMMARY_TRIGGER_CHARS`：待压缩旧消息的有效文本量达到该字符数才真正压缩，默认 `2000`；设为 `0` 表示只按消息条数判断
- `AGENT_TOOL_TIMEOUT_MS`：工具调用超时时间，默认 `10000`
- `AGENT_EVENT_RETENTION_DAYS`：事件时间线保留天数，默认 `3`
- `AGENT_EVENT_CLEANUP_HOUR`：每天几点清理过期事件，使用服务本地时区，默认 `3`
- `AGENT_EVENT_CLEANUP_BATCH_SIZE`：每轮在统一事件表中分别最多删除多少条 message 事件和 run 事件，默认 `2000`
- `AGENT_EVENT_CLEANUP_MAX_BATCHES`：每次清理最多执行多少轮，默认 `20`
- `AGENT_PUBLIC_BASE_URL`：后端生成资源 URL 时使用的公开 API 地址，默认按当前 API 地址推导
- `AGENT_UPLOAD_DIR`：用户上传和工具资源转储目录，默认 `./data/uploads`
- `AGENT_TOOL_RESOURCE_MAX_BYTES`：工具生成资源转储的最大文件大小，默认 `209715200`
- `AGENT_TOOL_RESOURCE_DOWNLOAD_TIMEOUT_MS`：工具生成资源下载超时时间，默认 `60000`
- `AGENT_RUNNING_STATE_STORE`：运行中消息 draft 存储，`memory` 或 `redis`，默认 `memory`
- `REDIS_URL`：Redis 连接地址，仅 `AGENT_RUNNING_STATE_STORE=redis` 时使用，默认 `redis://localhost:6379`
- `AGENT_RUNNING_STATE_TTL_SECONDS`：运行中 draft 的 Redis TTL，默认 `7200`
- `AGENT_RUNNING_STATE_REDIS_KEY_PREFIX`：运行中 draft 的 Redis key 前缀，默认 `agent`
- `AGENT_ALLOWED_TOOLS`：允许暴露和执行的工具名，逗号分隔；留空表示允许全部已注册工具
- `TAVILY_API_KEY`：Tavily Search API Key；配置后会启用 `web_search` 工具
- `SEARCH_MAX_RESULTS`：默认搜索结果数量，默认 `5`，范围 `1-10`
- `VOLCENGINE_ACCESS_KEY_ID`：火山引擎 Access Key ID；和 SK 同时配置后会启用 `generate_image` 和 `edit_image`
- `VOLCENGINE_SECRET_ACCESS_KEY`：火山引擎 Secret Access Key；只放在本地 `.env`，不要提交
- `VOLCENGINE_IMAGE_ENDPOINT`：火山视觉 OpenAPI 地址，默认 `https://visual.volcengineapi.com`
- `VOLCENGINE_IMAGE_REGION`：签名 Region，默认 `cn-north-1`
- `VOLCENGINE_IMAGE_SERVICE`：签名 Service，默认 `cv`
- `VOLCENGINE_IMAGE_REQ_KEY`：Seedream 通用3.0 文生图服务标识，默认 `high_aes_general_v30l_zt2i`
- `VOLCENGINE_IMAGE_EDIT_VERSION`：SeedEdit3.0 OpenAPI 版本，默认 `2022-08-31`
- `VOLCENGINE_IMAGE_EDIT_REQ_KEY`：SeedEdit3.0 图像编辑服务标识，默认 `seededit_v3.0`
- `VOLCENGINE_IMAGE_POLL_INTERVAL_MS`：轮询间隔，默认 `1500`
- `VOLCENGINE_IMAGE_MAX_POLL_ATTEMPTS`：最大轮询次数，默认 `40`
- `VOLCENGINE_IMAGE_TOOL_TIMEOUT_MS`：生图工具独立超时时间，默认 `90000`
- `VOLCENGINE_IMAGE_BATCH_CONCURRENCY`：批量生图内部并发数，默认 `2`，范围 `1-5`
- `VOLCENGINE_VIDEO_ENDPOINT`：火山视觉视频 OpenAPI 地址，默认 `https://visual.volcengineapi.com`
- `VOLCENGINE_VIDEO_REGION`：视频工具签名 Region，默认 `cn-north-1`
- `VOLCENGINE_VIDEO_SERVICE`：视频工具签名 Service，默认 `cv`
- `VOLCENGINE_VIDEO_VERSION`：视频工具 OpenAPI 版本，默认 `2022-08-31`
- `VOLCENGINE_VIDEO_REQ_KEY`：即梦文生视频服务标识，默认 `jimeng_t2v_v30`
- `VOLCENGINE_VIDEO_FIRST_FRAME_REQ_KEY`：即梦首帧图生视频服务标识，默认 `jimeng_i2v_first_v30`
- `VOLCENGINE_VIDEO_FIRST_LAST_FRAME_REQ_KEY`：即梦首尾帧图生视频服务标识，默认 `jimeng_i2v_first_tail_v30`
- `VOLCENGINE_VIDEO_POLL_INTERVAL_MS`：视频任务轮询间隔，默认 `1500`
- `VOLCENGINE_VIDEO_MAX_POLL_ATTEMPTS`：视频任务最大轮询次数，默认 `80`
- `VOLCENGINE_VIDEO_TOOL_TIMEOUT_MS`：视频工具独立超时时间，默认 `600000`
- `AGENT_SQLITE_PATH`：SQLite 文件路径，默认 `./data/agent.sqlite`
- `VITE_API_BASE_URL`：前端 API 地址；留空时自动按当前 Web host 推导到 `4001`

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

如果用局域网 IP 访问 Web，例如 `http://10.1.65.46:4000`，前端会自动把 API 推导为 `http://10.1.65.46:4001`。`VITE_API_BASE_URL` 留空即可自动推导；后端默认允许 `localhost`、`127.0.0.1` 和局域网 IP 的 Origin，方便本地联调。只有部署到独立 API 域名时才需要显式配置 `VITE_API_BASE_URL`，同时用 `CORS_ORIGINS=https://your-web.example.com` 收紧后端 CORS 白名单。

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

## 演进路线 / TODO

当前项目已经具备 Agent 本地开发版的基础能力：Fastify API、React 工作台、SSE 流式事件、session/message、SQLite 持久化、运行中 draft、资源索引表、工具调用表、事件压缩、断线恢复、上下文续聊、图片 / 视频生成、资源转储和图片引用。后续建议按产品化顺序演进，优先把 Agent Runtime、数据层和资源体系打稳。

如果当前阶段更偏“学习 Agent 怎么工作”，优先级可以和产品化路线稍微错开：先做生成模型调用链路审计、固定样例评测、上下文预算和工具结果摘要。这几项能把一次 run 为什么成功、为什么失败、上下文里带了什么、工具结果如何影响下一步暴露出来，比先做登录、对象存储、队列拆分更能帮助理解 Agent 的核心机制。多步骤任务计划也很适合学习，但最好等 trace 和评测基线先落地，否则失败时很难判断问题出在 planning、上下文、工具、资源处理还是生成模型本身。

学习优先级建议：

1. 生成模型调用链路审计与 trace：重点串起 message、run、图片/视频工具调用、供应商请求、资源落库和最终答案；LLM 调用先只记录必要状态、模型名和耗时，成本暂不作为重点。
2. 固定样例集与评测脚本：用稳定任务比较不同模型、prompt 和工具策略，避免只凭单次体验判断效果。
3. 上下文 token 预算和工具结果摘要：学习 Agent 如何选择把什么信息放进模型上下文，以及如何避免工具大结果反复污染上下文。
4. 多步骤任务计划：在可观测基础上学习 planning / acting / observing 的循环，而不是一开始就在长链路里盲调。
5. 数据库、队列、用户权限、对象存储等产品化能力：真实上线前很重要，但对理解 Agent 核心行为的直接帮助稍弱，可以稍后做。

### 1. Agent Runtime 稳定化

目标：让一次 assistant message / run 的生命周期稳定可恢复，适合后续多实例部署。

- [x] 支持取消生成：`POST /agents/messages/:messageId/cancel`。
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

目标：从本地 SQLite 开发存储升级为可迁移、可审计、可扩展的数据模型。

- [x] 用 `AgentStore` 隔离业务层和具体数据库实现。
- [x] message 使用 `parts` 保存结构化内容，支持文本、图片和后续附件。
- [x] 增加 `agent_tool_calls`，支持按工具调用做审计和聚合查询。
- [x] 增加 `agent_resources`，作为资源索引、审计和聚合表；`message.parts` 保留渲染快照，例如 `url`、`mime`、`name`、`extra.resourceId`。
- [x] event 表增加 `expires_at`，默认保留 3 天，并按批清理。
- [ ] 设计 MySQL / PostgreSQL schema 和 migration 方案。
- [ ] 增加数据库连接池、事务边界和索引设计。
- [ ] 将 event 清理迁移为产品级后台 job，避免和 API 请求争抢资源。
- [ ] 增加用户 / 租户字段，为后续多用户隔离做准备。

为什么做它：SQLite 适合本地开发，但产品化需要连接池、迁移、索引、事务和数据隔离。当前接口已经在往可替换数据库实现的方向靠。

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
- [x] 工具生成图片 / 视频转储到本地 uploads/resources，避免长期依赖供应商临时 URL。
- [x] 前端图片预览支持下载、复制、引用、删除等资源交互。
- [x] 支持用户上传图片。
- [x] 支持前端引用图片到输入框，并按 message parts 提交。
- [ ] 支持用户上传通用文件。
- [ ] 接入对象存储 / CDN，替换本地 uploads 转储。
- [ ] 增加资源库视图，按 session、类型、工具、时间筛选资源。

为什么做它：资源是 Agent 产品从聊天走向创作和工作流的关键。资源独立后，工具调用、上下文引用、审计和 UI 交互都会更清晰。

### 6. 真实业务能力

目标：在稳定 Runtime 上接入更有用的 Agent 能力。

- [ ] 文件上传和文档问答。
- [x] 网页搜索工具。
- [x] 图片生成工具。
- [x] 视频生成工具。
- [ ] 数据库查询工具。
- [ ] 本地知识库 RAG。
- [ ] 多步骤任务计划。
- [ ] 多 Agent 分工。

为什么稍后做它：这些能力很诱人，但都依赖工具治理、持久化、事件追踪和上下文策略。先打地基，再扩业务能力，后面会更稳。

### 7. Worker 和队列

目标：把长时间运行的 Agent 任务从 API 进程里拆出来，支持更可靠的并发和扩容。

- [ ] 引入 job 队列，例如 BullMQ。
- [ ] API 只负责创建 run/message 和投递任务。
- [ ] Worker 负责 LLM 调用、工具执行、running draft 更新和最终落库。
- [ ] 增加任务重试、超时、并发限制和 worker 心跳。
- [ ] SSE gateway 从 running state / pubsub 获取运行状态。

为什么做它：真实 Agent 任务可能很长，API 进程不适合长期承载所有执行逻辑。队列化后才能更稳地扩容和恢复。

### 8. 评测与观测

目标：让 Agent 行为可以排查、比较和持续优化。

- [x] 保存 message 输入、关键事件、工具调用、资源和最终答案。
- [x] 事件时间线作为短期排查日志，默认保留 3 天。
- [ ] 增加固定样例集，用来比较不同模型、prompt 和工具策略。
- [ ] 记录失败原因分类，帮助发现系统性问题。
- [ ] 增加生成模型和工具调用的审计统计，支持按天、供应商、生成模型、工具、状态、失败类型聚合，观察日均调用量、失败率、延迟分布和估算成本；LLM 统计先保持轻量，用来辅助串联一次 run。
- [ ] 增加 traceId / requestId，让一次 run 可以串起 API、LLM、工具和存储日志。

注意：当前产品方向不做完整 delta 回放。实时恢复依赖 `message.snapshot` + running draft；event 表只做短期观测和排查，不作为用户界面恢复源。

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
npm run test
npm run typecheck
npm run build
```
