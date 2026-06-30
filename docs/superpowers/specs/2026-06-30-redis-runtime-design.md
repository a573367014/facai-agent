# Redis Agent Runtime 设计

## 背景

当前项目已经从最初的同步 Agent demo 演进到本地 Agent 工作台：

- Fastify API 负责 session、message、run、SSE 路由。
- SQLite 保存最终消息、run、工具调用、资源索引和短期事件。
- `AgentService` 在 API 进程内执行 LLM 调用和工具调用。
- `RunningMessageStateStore` 把运行中 assistant draft 从持久化 message 中拆出来。
- `RedisRunningMessageStateStore` 已经实现，但默认仍使用 memory。

这套结构适合单进程本地开发。问题出现在 Agent 任务变长之后：图片和视频生成要轮询，工具执行可能很慢，SSE 连接可能断开，API 进程可能重启，未来也可能出现多个 API / Worker 实例。仅靠 Node 内存保存运行态，就像前端只用组件内 `useState` 管理全局异步任务：刷新、切实例或重启时会丢状态。

Redis Runtime 的目标不是替代 SQLite，而是补齐后端运行态这一层：短期、高频、跨进程共享、可过期、适合协作的状态放 Redis；长期、可审计、最终可信的数据仍放 SQLite。

## 目标

本阶段把 Redis 接成完整 Agent 运行时基础设施，而不是只切一个配置开关。

目标：

- 本地开发可以一键启动 Redis。
- 运行中 assistant draft 使用 Redis 保存。
- Agent run 支持队列化执行，API 不再长期承载模型和工具执行。
- Worker 可以消费 run job，执行现有 Agent 流程。
- Worker 产生的事件可以跨进程实时推给 API SSE 连接。
- 取消信号可以跨进程传递，不能只依赖当前 Node 进程里的 `AbortController`。
- 对 run 执行加幂等保护，避免同一个任务被重复执行。
- 保持 SQLite 作为最终事实源，不把长期业务数据搬到 Redis。

非目标：

- 不把 session、message、resource、event 全量迁移到 Redis。
- 不做多租户隔离和登录权限体系。
- 不做复杂成本审计。
- 不做完整 Redis Stream 事件回放；事件回放仍依赖 SQLite event 表。
- 不把前端改成直接连接 Redis；前端仍只通过 HTTP/SSE 访问 API。

## 核心分工

可以把它类比成前端状态分层：

- Node 内存类似组件内 `useState`：最快，但只属于当前进程，重启就没。
- Redis 类似后端共享运行态 store：多个 API/Worker 都能读写，适合短期状态和实时协作。
- SQLite 类似最终数据源：负责可恢复、可审计、长期保存。
- SSE 类似前端实时订阅：把运行态变化推回浏览器。

最终分工：

```text
React 前端
  -> Fastify API / SSE Gateway
      -> SQLite: 最终事实数据
      -> Redis: running draft / queue / pubsub / cancel / lock
  -> Agent Worker
      -> Redis: 消费任务、更新运行态、发布事件
      -> SQLite: 落最终消息、工具调用、资源和事件
      -> LLM / 图片 / 视频供应商
```

SQLite 保存：

- session
- user / assistant message
- run 状态
- tool call 审计记录
- resource 索引
- event 短期回放
- summary

Redis 保存：

- running assistant draft
- BullMQ run job
- Pub/Sub live event
- cancel key
- run lock

## 推荐架构

### 1. Redis Client Factory

新增统一 Redis client 创建模块，例如 `agent-redis-runtime.ts` 或 `redis-client.ts`。

原因：现在 `app.ts` 里只为 running draft 创建 Redis client。接队列、Pub/Sub、cancel、lock 后，如果每个模块自己 new Redis，连接生命周期会分散，测试也困难。统一工厂可以集中处理：

- `REDIS_URL`
- lazy connect / retry 策略
- error log
- app close 时断开连接
- 测试时注入 fake client

### 2. Running Draft

继续使用现有 `RedisRunningMessageStateStore`。

它解决的问题：

- 流式 delta 很高频，不适合每个 token 都写 SQLite。
- 刷新页面时，API 可以从 Redis 读当前 draft，先发 `message.snapshot`。
- Worker 和 API 分进程后，API 进程不能再读 Worker 内存里的 draft。
- draft 完成后写回 SQLite，并删除 Redis key。

Redis key 示例：

```text
agent:running-message:{messageId}:state
```

TTL 继续使用 `AGENT_RUNNING_STATE_TTL_SECONDS`。TTL 的意义是兜底清理异常中断的运行态，不是业务完成判断；业务完成仍以 SQLite run/message 状态为准。

### 3. BullMQ Run Queue

新增 `AgentRunQueue` 封装 BullMQ。

API 的职责变为：

1. 创建 session。
2. 创建 user message。
3. 创建 run。
4. 创建 assistant running message。
5. 初始化 Redis running draft。
6. 投递 run job。
7. 返回 run/message 信息。

Worker 的职责变为：

1. 消费 run job。
2. 从 SQLite 读取 run 和 message。
3. 检查 run 是否仍是 `running`。
4. 构造上下文。
5. 调用 `AgentService`。
6. 执行工具和资源存储。
7. 写 Redis draft、SQLite event、SQLite final message。

为什么要队列：图片/视频生成和工具轮询是长任务。API 进程如果直接执行长任务，会把“接请求”和“跑任务”绑在一起，未来扩容、重启、限流和重试都很难做。队列把请求接入和任务执行拆开，是后端长任务系统的基础。

Job payload 只放引用 ID，不放大对象：

```ts
interface AgentRunJobPayload {
  runId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
}
```

原因：队列消息应该小而稳定。真正的上下文、parts、summary 从 SQLite 读取，避免 job payload 和数据库状态不一致。

### 4. Redis Event Bus

新增 `AgentEventBus` 封装 Redis Pub/Sub。

Worker 执行时发布事件：

```text
agent:events:message:{messageId}
agent:events:run:{runId}
```

API SSE 连接订阅对应 channel，把事件推给浏览器。

为什么不用前端直连 Worker：前端只应该认识 API。Worker 是后端内部执行器，数量、部署位置、重启策略都不应该影响前端连接方式。

为什么先用 Pub/Sub，不用 Redis Stream：现有 SQLite event 表已经负责短期回放，SSE 建连时也会先返回 snapshot 和历史事件。Pub/Sub 只负责 live 推送，简单够用。以后如果要跨进程事件回放或可靠投递，再考虑 Stream。

### 5. Cancel Store

新增 `AgentCancellationStore`。

API 收到取消请求后：

1. SQLite run/message 标记取消。
2. 写 Redis cancel key。
3. 发布 cancel 事件。

Worker 在这些位置检查 cancel key：

- 开始执行 job 前。
- 每轮 LLM 调用前后。
- 每个工具调用前后。
- 图片/视频轮询循环里。
- 最终落库前。

Redis key 示例：

```text
agent:run:{runId}:cancelled
agent:message:{messageId}:cancelled
```

为什么不能只用 `AbortController`：`AbortController` 是当前 Node 进程里的对象。API 和 Worker 分进程后，API 里 abort 一个 controller，不会自动中断 Worker 里的网络请求。Redis cancel key 是跨进程可见的取消信号。

### 6. Run Lock

新增 `AgentRunLock`。

Worker 消费 job 时尝试获取锁：

```text
agent:run:{runId}:lock
```

获取方式应使用 `SET key value NX EX ttl`。

为什么需要锁：队列系统里要假设 job 可能重复投递、Worker 可能崩溃、任务可能被重新消费。锁可以降低重复执行概率。SQLite 状态机仍是最终防线：只有 `running` 状态的 run 才能继续执行，`completed/failed/cancelled` 必须直接跳过。

## 执行流程

一次用户消息的完整流程：

```text
1. 前端 POST /agents/runs。
2. API 创建 user message、assistant running message、run。
3. API 初始化 Redis running draft。
4. API 投递 BullMQ job。
5. 前端连接 /agents/runs/:runId/events 或 /agents/messages/:messageId/events。
6. API 从 SQLite 返回已有事件，并从 Redis draft 返回 snapshot。
7. Worker 消费 job，获取 run lock。
8. Worker 检查 SQLite run 状态和 Redis cancel key。
9. Worker 调用 AgentService。
10. LLM delta 写 Redis running draft。
11. 工具进度、结果和错误写 SQLite event，并通过 Redis Pub/Sub 发布。
12. API SSE 收到 Pub/Sub 事件，推给前端。
13. Worker 生成最终答案后，把 assistant message 写入 SQLite。
14. Worker 删除 Redis running draft，释放锁。
15. 前端刷新后从 SQLite 读取最终结果。
```

## 配置设计

新增或调整环境变量：

```env
REDIS_URL=redis://localhost:6379
AGENT_RUNNING_STATE_STORE=redis
AGENT_RUNNING_STATE_TTL_SECONDS=7200
AGENT_RUNNING_STATE_REDIS_KEY_PREFIX=agent

AGENT_RUN_EXECUTION_MODE=queue
AGENT_QUEUE_NAME=agent-runs
AGENT_WORKER_CONCURRENCY=2
AGENT_RUN_LOCK_TTL_SECONDS=1800
AGENT_CANCEL_TTL_SECONDS=7200
AGENT_EVENT_BUS=redis
```

保留 `AGENT_RUN_EXECUTION_MODE=inline` 作为开发和测试兜底。这样改造可以分阶段落地，不必一次切断现有执行路径。

## 代码边界

建议新增模块：

- `apps/api/src/redis/runtime.ts`
  - 创建 Redis runtime 依赖。
  - 管理 client 生命周期。

- `apps/api/src/agent/agent-run-queue.ts`
  - 封装 BullMQ queue。
  - 提供 `enqueueRun(payload)`。

- `apps/api/src/agent/agent-run-worker.ts`
  - 封装 Worker 消费逻辑。
  - 调用 coordinator/service 执行 run。

- `apps/api/src/agent/agent-event-bus.ts`
  - 封装 publish / subscribe。
  - 本地 inline 模式可以使用内存实现，queue 模式使用 Redis Pub/Sub。

- `apps/api/src/agent/agent-cancellation-store.ts`
  - 封装 cancel key 的 set/get/remove。

- `apps/api/src/agent/agent-run-lock.ts`
  - 封装 Redis lock。

需要调整的现有模块：

- `app.ts`
  - 装配 Redis runtime、queue、event bus、running state store。

- `agent-message-coordinator.ts`
  - 拆分“创建 run”和“执行 run”。
  - inline 模式继续直接执行。
  - queue 模式只 enqueue。

- `server.ts`
  - API server 仍只启动 Fastify。
  - 新增独立 worker entry，例如 `worker.ts`。

- 根 `package.json`
  - 增加 `dev:worker`。
  - 根 `dev` 同时启动 api、web、worker。

## 错误处理

Redis 不可用时的策略要明确：

- 如果配置 `AGENT_RUN_EXECUTION_MODE=queue` 或 `AGENT_EVENT_BUS=redis`，Redis 启动失败应让服务启动失败，避免用户以为任务已入队但实际没有执行。
- 如果配置 `AGENT_RUNNING_STATE_STORE=redis`，Redis 写入失败应让当前 run 失败，而不是悄悄退回 memory。静默降级会让排查变困难。
- 本地开发可以通过 `.env` 切回 `inline + memory`，但这是显式选择。

Worker 失败策略：

- job 开始时检查 run 状态，不是 `running` 就跳过。
- job 执行异常时，SQLite run/message 标记 `failed`。
- 已取消的 run 不应被标记 failed。
- Worker 崩溃后遗留 running run，由现有 stale cleanup 逻辑标记为 failed 或 interrupted。

## 测试策略

单元测试：

- Redis running state store 已有 fake client 测试，继续保留。
- `AgentCancellationStore` 测试 set/get/ttl。
- `AgentRunLock` 测试获取锁、重复获取失败、释放锁。
- `AgentEventBus` 测试 publish/subscribe contract。
- `AgentRunQueue` 测试 payload 只包含 ID。

集成测试：

- inline 模式保持原测试通过。
- queue 模式创建 run 后会 enqueue job。
- Worker 消费 job 后能完成 assistant message。
- SSE 能收到 Worker 通过 Redis event bus 发布的事件。
- cancel run 后 Worker 能停止后续工具执行。
- Redis 不可用且配置 queue 时，服务启动失败或返回明确错误。

手动验证：

1. `docker compose up -d redis`
2. `.env` 切到 Redis + queue。
3. `npm run dev`
4. 发一条普通聊天消息，确认最终答案写入 SQLite。
5. 发一条图片生成任务，刷新页面确认 running snapshot 能恢复。
6. 生成中取消，确认 run/message 进入 cancelled。
7. 重启 API，不中断 Worker，确认 SSE 重新连接后仍能看到进度。

## 实施顺序

虽然目标是完整 Redis Runtime，但实现必须分段，方便定位问题。

1. 本地 Redis 基础设施
   - `docker-compose.yml`
   - env 文档
   - Redis client factory

2. Running draft 切 Redis
   - 使用现有 `RedisRunningMessageStateStore`
   - 验证刷新恢复和完成删除 draft

3. Event bus
   - 先保持 inline 执行
   - 把事件通过 Redis Pub/Sub 走一遍
   - 确认 SSE 不破

4. Queue + Worker
   - 新增 BullMQ queue
   - 新增 worker entry
   - `startRun` 支持 queue 模式

5. Cancel store
   - API 写 cancel key
   - Worker 检查 cancel key
   - 图片/视频轮询支持取消检查

6. Lock 和恢复
   - Worker 执行前加 run lock
   - 补重复执行保护
   - 复用 stale cleanup

7. 文档和验收
   - README 增加 Redis Runtime 运行说明
   - 测试覆盖 inline 和 queue 两种模式

## 学习重点

这次改造对前端转全栈很有价值，因为它覆盖后端真实系统里最常见的几类问题：

- 请求响应和长任务执行要拆开。
- 运行态和最终数据要拆开。
- 内存状态和跨进程状态要拆开。
- 实时事件和可回放事件要拆开。
- 取消、幂等、锁、重启恢复都需要显式设计。

Agent Runtime 不是“调一次模型”这么简单。它更像一个小型任务系统：前端看到的是一条消息在生成，后端实际需要协调 API、Worker、Redis、SQLite、供应商和 SSE。Redis 接进来后，这个边界会变得清楚，也更接近真实全栈项目的运行方式。
