# Redis Agent 运行时设计

> 2026-07-01 更新：运行时配置已按产品化方案收口。当前主路径固定为 `API + Worker + Redis + SQLite`；不再暴露切换内存运行态、API 进程内运行执行或 Redis 事件总线的环境变量。

## 背景

当前项目已经从最初的同步 Agent 演示演进到本地 Agent 工作台：

- Fastify API 负责会话、消息、运行和 SSE 路由。
- SQLite 保存最终消息、运行、工具调用、资源索引和短期事件。
- Worker 进程执行 LLM 调用和工具调用。
- `RunningMessageStateStore` 把运行中的助手草稿从持久化消息中拆出来。
- `RedisRunningMessageStateStore` 是产品运行时默认实现；内存实现仅用于单元测试注入。

这套结构适合单进程本地开发。问题出现在 Agent 任务变长之后：图片和视频生成要轮询，工具执行可能很慢，SSE 连接可能断开，API 进程可能重启，未来也可能出现多个 API / Worker 实例。仅靠 Node 内存保存运行态，就像前端只用组件内 `useState` 管理全局异步任务：刷新、切实例或重启时会丢状态。

Redis 运行时的目标不是替代 SQLite，而是补齐后端运行态这一层：短期、高频、跨进程共享、可过期、适合协作的状态放 Redis；长期、可审计、最终可信的数据仍放 SQLite。

## 目标

本阶段把 Redis 接成完整 Agent 运行时基础设施，而不是只切一个配置开关。

目标：

- 本地开发可以一键启动 Redis。
- 运行中的助手草稿使用 Redis 保存。
- Agent 运行支持队列化执行，API 不再长期承载模型和工具执行。
- Worker 可以消费运行任务，执行现有 Agent 流程。
- Worker 产生的事件可以跨进程实时推给 API SSE 连接。
- 取消信号可以跨进程传递，不能只依赖当前 Node 进程里的 `AbortController`。
- 对运行执行加幂等保护，避免同一个任务被重复执行。
- 保持 SQLite 作为最终事实源，不把长期业务数据搬到 Redis。

非目标：

- 不把会话、消息、资源全量迁移到 Redis。
- 不做多租户隔离和登录权限体系。
- 不做复杂成本审计。
- 不做完整 Redis Stream 事件回放；运行恢复依赖快照，过程排查依赖 OTel 日志/Loki。
- 不把前端改成直接连接 Redis；前端仍只通过 HTTP/SSE 访问 API。

## 核心分工

可以把它类比成前端状态分层：

- Node 内存类似组件内 `useState`：最快，但只属于当前进程，重启就没。
- Redis 类似后端共享运行态存储：多个 API/Worker 都能读写，适合短期状态和实时协作。
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

- 会话
- 用户/助手消息
- 运行状态
- 工具调用审计记录
- 资源索引
- 事件短期回放
- 摘要

Redis 保存：

- 运行中的助手草稿
- BullMQ 运行任务
- Pub/Sub 实时事件
- 取消键
- 运行锁

## 推荐架构

### 1. Redis 客户端工厂

新增统一 Redis 客户端创建模块，例如 `agent-redis-runtime.ts` 或 `redis-client.ts`。

原因：现在 `app.ts` 里只为运行中草稿创建 Redis 客户端。接入队列、Pub/Sub、取消和锁后，如果每个模块都自行新建 Redis 实例，连接生命周期会分散，测试也困难。统一工厂可以集中处理：

- `REDIS_URL`
- 延迟连接/重试策略
- 错误日志
- 应用关闭时断开连接
- 测试时注入模拟客户端

### 2. 运行中草稿

继续使用现有 `RedisRunningMessageStateStore`。

它解决的问题：

- 流式增量频率很高，不适合每个令牌都写 SQLite。
- 刷新页面时，API 可以从 Redis 读取当前草稿，先发送 `message.snapshot`。
- Worker 和 API 分进程后，API 进程不能再读取 Worker 内存里的草稿。
- 草稿完成后写回 SQLite，并删除 Redis 键。

Redis 键示例：

```text
agent:running-message:{messageId}:state
```

TTL 继续使用 `AGENT_RUNNING_STATE_TTL_SECONDS`。TTL 的意义是兜底清理异常中断的运行态，不是业务完成判断；业务完成仍以 SQLite 运行/消息状态为准。

### 3. BullMQ 运行队列

新增 `AgentRunQueue` 封装 BullMQ。

API 的职责变为：

1. 创建会话。
2. 创建用户消息。
3. 创建运行。
4. 创建运行中的助手消息。
5. 初始化 Redis 运行中草稿。
6. 投递运行任务。
7. 返回运行/消息信息。

Worker 的职责变为：

1. 消费运行任务。
2. 从 SQLite 读取运行和消息。
3. 检查运行是否仍是 `running`。
4. 构造上下文。
5. 调用 `AgentService`。
6. 执行工具和资源存储。
7. 写入 Redis 草稿、SQLite 事件和 SQLite 最终消息。

为什么要队列：图片/视频生成和工具轮询是长任务。API 进程如果直接执行长任务，会把“接请求”和“跑任务”绑在一起，未来扩容、重启、限流和重试都很难做。队列把请求接入和任务执行拆开，是后端长任务系统的基础。

任务载荷只放引用 ID，不放大对象：

```ts
interface AgentRunJobPayload {
  runId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
}
```

原因：队列消息应该小而稳定。真正的上下文、`parts`、`summary` 从 SQLite 读取，避免任务载荷和数据库状态不一致。

### 4. Redis 事件总线

新增 `AgentEventBus` 封装 Redis Pub/Sub。

Worker 执行时按运行发布事件；事件里仍带 `messageId`，前端用它定位助手消息：

```text
agent:events:run:{runId}
```

API SSE 连接订阅对应频道，把事件推给浏览器。

为什么不用前端直连 Worker：前端只应该认识 API。Worker 是后端内部执行器，数量、部署位置、重启策略都不应该影响前端连接方式。

为什么先用 Pub/Sub，不用 Redis Stream：当前产品方向不做历史事件全量回放，SSE 建连时先返回快照，Pub/Sub 只负责实时推送，简单够用。以后如果要跨进程可靠投递，再考虑 Redis Stream。

### 5. 取消存储

新增 `AgentCancellationStore`。

API 收到取消请求后：

1. 将 SQLite 运行/消息标记为取消。
2. 写入 Redis 取消键。
3. 发布运行级取消事件。

Worker 在这些位置检查取消键：

- 开始执行任务前。
- 每轮 LLM 调用前后。
- 每个工具调用前后。
- 图片/视频轮询循环里。
- 最终落库前。

Redis 键示例：

```text
agent:run:{runId}:cancelled
```

为什么不能只用 `AbortController`：`AbortController` 是当前 Node 进程里的对象。API 和 Worker 分进程后，在 API 中中止一个控制器不会自动中断 Worker 里的网络请求。Redis 取消键是跨进程可见的取消信号。

### 6. 运行锁

新增 `AgentRunLock`。

Worker 消费任务时尝试获取锁：

```text
agent:run:{runId}:lock
```

获取方式应使用 `SET key value NX EX ttl`。

为什么需要锁：队列系统里要假设任务可能重复投递、Worker 可能崩溃、任务可能被重新消费。锁可以降低重复执行概率。SQLite 状态机仍是最终防线：只有 `running` 状态的运行才能继续执行，`completed/failed/cancelled` 必须直接跳过。

## 执行流程

一次用户消息的完整流程：

```text
1. 前端 POST /agents/runs。
2. API 创建 user message、assistant running message、run。
3. API 初始化 Redis running draft。
4. API 投递 BullMQ job。
5. 前端连接 /agents/runs/:runId/stream。
6. API 从 Redis/SQLite 返回当前 snapshot。
7. Worker 消费 job，获取 run lock。
8. Worker 检查 SQLite run 状态和 Redis cancel key。
9. Worker 调用 AgentService。
10. LLM delta 写 Redis running draft。
11. 工具进度、结果和错误写 OTel logs，并通过 Redis Pub/Sub 发布。
12. API SSE 收到 Pub/Sub 事件，推给前端。
13. Worker 生成最终答案后，把 assistant message 写入 SQLite。
14. Worker 删除 Redis running draft，释放锁。
15. 前端刷新后从 SQLite 读取最终结果。
```

## 配置设计

当前运行时配置已按产品化方案收口，只保留真实部署需要的参数：

```env
REDIS_URL=redis://localhost:6379
AGENT_RUNNING_STATE_TTL_SECONDS=7200
AGENT_RUNNING_STATE_REDIS_KEY_PREFIX=agent

AGENT_QUEUE_NAME=agent-runs
AGENT_WORKER_CONCURRENCY=2
AGENT_RUN_LOCK_TTL_SECONDS=1800
AGENT_CANCEL_TTL_SECONDS=7200
```

不再提供 `AGENT_RUNNING_STATE_STORE`、`AGENT_RUN_EXECUTION_MODE`、`AGENT_EVENT_BUS` 这类模式开关。原因是产品主路径已经明确：API 负责接入和 SSE，Worker 负责执行，Redis 负责运行时协调，SQLite 负责持久化。保留多套运行模式会让调试时很难判断问题出在业务逻辑、内存实现还是 Redis 实现。

测试仍然可以通过 `BuildAppOptions` 注入内存实现，这属于单元测试隔离手段，不是产品配置。

## 代码边界

当前模块分工：

- `apps/api/src/redis/runtime.ts`
  - 集中创建 Redis 客户端。
  - `commandClient` 给普通键值和 Lua 脚本使用。
  - `eventPublisher` / `eventSubscriber` 给 Pub/Sub 使用，避免订阅连接和命令连接互相影响。

- `apps/api/src/agent/agent-run-queue.ts`
  - 封装 BullMQ 队列。
  - 任务载荷只放运行/消息 ID，避免队列里出现大对象或过期上下文。

- `apps/api/src/worker.ts`
  - 独立 Worker 入口。
  - 从 BullMQ 消费 `agent-run` 任务。
  - 调用 `AgentMessageCoordinator.executeQueuedRun()`。

- `apps/api/src/agent/agent-event-bus.ts`
  - 封装运行级发布/订阅。
  - `messageId` 仍保留在事件字段里，但 Pub/Sub 频道只按运行订阅。

- `apps/api/src/agent/agent-cancellation-store.ts`
  - 封装运行取消键的设置、读取和删除。

- `apps/api/src/agent/agent-run-lock.ts`
  - 封装 Redis 锁，防止同一个运行被多个 Worker 重复执行。

- `app.ts`
  - 装配 Redis 运行时、队列、事件总线、运行状态存储、取消存储和运行锁。
  - 关闭 Fastify 时统一关闭 BullMQ 队列、Redis 客户端和 SQLite 存储。

- `agent-message-coordinator.ts`
  - `startRun()` 创建用户消息、运行中的助手消息和运行，并投递任务。
  - `executeQueuedRun()` 是 Worker 执行入口，负责检查状态、抢锁、构造上下文和执行 `AgentService`。
  - `cancelRun()` 统一处理 API/Worker 可见的取消。

- 根 `package.json`
  - `dev` 同时启动 API、Web 和 Worker。
  - `dev:worker` 可单独启动 Worker。

## 错误处理

Redis 不可用时的策略要明确：

- 产品运行依赖 Redis。Redis 启动失败或连接失败时，不应该静默降级到内存实现。
- 运行中草稿写入失败应让当前运行失败，避免前端看到的实时状态和最终状态不一致。
- BullMQ 入队失败时，`POST /agents/runs` 应返回明确错误，不能让用户以为任务已经开始。
- Pub/Sub 失败会影响实时推送；前端重连后先获取快照，过程排查看 OTel 日志/Loki。

Worker 失败策略：

- 任务开始时检查运行状态，不是 `running` 就跳过。
- 任务执行异常时，将 SQLite 运行/消息标记为 `failed`。
- 已取消的运行不应被标记为 `failed`。
- Worker 崩溃后遗留的运行中任务，由现有过期清理逻辑标记为 `failed` 或 `interrupted`。

## 测试策略

单元测试：

- `RedisRunningMessageStateStore` 使用模拟客户端测试 Lua 脚本契约。
- `AgentCancellationStore` 测试设置、读取和 TTL。
- `AgentRunLock` 测试获取锁、重复获取失败、释放锁。
- `AgentEventBus` 测试发布/订阅契约。
- `AgentRunQueue` 测试载荷只包含 ID。

集成测试：

- 创建运行后会将任务入队。
- Worker 消费任务后能完成助手消息。
- SSE 能收到 Worker 通过 Redis 事件总线发布的事件。
- 取消运行后，Worker 能停止后续工具执行。
- 旧消息执行入口保持 404，避免重新出现双执行路径。

手动验证：

1. `docker compose up -d redis`
2. 配好 `.env` 里的模型、工具和 `REDIS_URL`。
3. `npm run dev`
4. 发一条普通聊天消息，确认最终答案写入 SQLite。
5. 发一条图片生成任务，刷新页面确认运行中快照能恢复。
6. 生成中取消，确认运行/消息进入 `cancelled`。
7. 重启 API，不中断 Worker，确认 SSE 重新连接后仍能看到进度。

## 阅读顺序

建议按这条线读代码：

1. `app.ts`：看 Redis、BullMQ、SQLite 和协调器如何装配。
2. `agent-message-coordinator.ts` 的 `startRun()`：看 API 请求如何变成运行和队列任务。
3. `worker.ts`：看 Worker 如何获取 BullMQ 任务。
4. `agent-message-coordinator.ts` 的 `executeQueuedRun()` / `executeRun()`：看真正执行、取消、锁、摘要和事件如何发生。
5. `agent-routes.ts` 的 `/agents/runs/:runId/stream`：看前端如何通过 SSE 接收快照和实时事件。
6. `redis-running-message-state-store.ts`、`agent-event-bus.ts`、`agent-cancellation-store.ts`、`agent-run-lock.ts`：分别看 Redis 四类运行态。

## 学习重点

这次改造对前端转全栈很有价值，因为它覆盖后端真实系统里最常见的几类问题：

- 请求响应和长任务执行要拆开。
- 运行态和最终数据要拆开。
- 内存状态和跨进程状态要拆开。
- 实时事件和可回放事件要拆开。
- 取消、幂等、锁、重启恢复都需要显式设计。

Agent 运行时不是“调一次模型”这么简单。它更像一个小型任务系统：前端看到的是一条消息在生成，后端实际需要协调 API、Worker、Redis、SQLite、提供方和 SSE。Redis 接进来后，这个边界会变得清楚，也更接近真实全栈项目的运行方式。
