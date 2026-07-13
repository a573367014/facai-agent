# Redis 运行时实施计划

> 2026-07-01 更新：运行时配置已经产品化。应用现在以 `API + Worker + Redis + SQLite` 为主路径，原先用于本地内存状态、内联运行执行和事件总线选择的环境变量开关已被取代。本计划作为 Redis 运行时基础能力的历史实施记录保留。

> **面向智能体执行者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐项实施本计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 将 Agent 运行执行迁移到由 Redis 支撑的运行时，其中包含运行中草稿、事件总线、队列、Worker、取消和锁等基础能力。

**架构：** SQLite 仍是会话、消息、运行、资源、工具调用和已存储事件的持久化事实来源。Redis 负责短期运行时协调：运行中草稿、实时事件扇出、BullMQ 任务、取消标记和运行锁。首个实现保留 `startMessage` 内联执行，并让队列执行聚焦于 `/agents/runs` 和 `/agents/sessions/:sessionId/runs` 使用的运行路径。

**技术栈：** Fastify、TypeScript、ioredis、BullMQ、Vitest、SQLite/sql.js、npm 工作区。

---

## 文件清单

- 修改 `apps/api/package.json`：添加 `bullmq`、`dev:worker` 和 `worker` 脚本。
- 修改根 `package.json`：在开发模式下一起启动 `api`、`web` 和 `worker`。
- 修改 `apps/api/src/config/env.ts`：添加执行模式、队列、Worker、锁、取消和事件总线配置。
- 创建 `docker-compose.yml`：本地 Redis 服务。
- 创建 `apps/api/src/redis/runtime.ts`：Redis 客户端工厂和生命周期容器。
- 创建 `apps/api/src/agent/agent-event-bus.ts`：内存与 Redis 实时事件总线。
- 创建 `apps/api/src/agent/agent-cancellation-store.ts`：内存与 Redis 取消标记。
- 创建 `apps/api/src/agent/agent-run-lock.ts`：内存与 Redis 运行锁。
- 创建 `apps/api/src/agent/agent-run-queue.ts`：BullMQ 队列封装。
- 创建 `apps/api/src/worker.ts`：Worker 进程入口。
- 修改 `apps/api/src/agent/agent-message-coordinator.ts`：分离运行创建和运行执行，并支持队列模式。
- 修改 `apps/api/src/app.ts`：装配 Redis 运行时、事件总线、队列、取消存储和锁。
- 修改 `README.md` 和 `.env.example`：记录 Redis 运行时设置。
- 在 `apps/api/test/agent/` 和 `apps/api/test/config/` 下添加测试。

## 任务 1：配置与本地 Redis

**文件：**
- 修改：`apps/api/src/config/env.ts`
- 修改：`.env.example`
- 修改：`README.md`
- 创建：`docker-compose.yml`
- 测试：`apps/api/test/config/env.test.ts`

- [x] **步骤 1：编写失败的环境变量测试**

添加测试，断言默认的内联/内存行为和 Redis 队列配置解析：

```ts
const env = loadEnv({});
expect(env.AGENT_RUN_EXECUTION_MODE).toBe("inline");
expect(env.AGENT_EVENT_BUS).toBe("memory");
expect(env.AGENT_QUEUE_NAME).toBe("agent-runs");
expect(env.AGENT_WORKER_CONCURRENCY).toBe(2);
expect(env.AGENT_RUN_LOCK_TTL_SECONDS).toBe(1800);
expect(env.AGENT_CANCEL_TTL_SECONDS).toBe(7200);

const redisEnv = loadEnv({
  AGENT_RUN_EXECUTION_MODE: "queue",
  AGENT_EVENT_BUS: "redis",
  AGENT_QUEUE_NAME: "facai-agent-runs",
  AGENT_WORKER_CONCURRENCY: "4",
  AGENT_RUN_LOCK_TTL_SECONDS: "900",
  AGENT_CANCEL_TTL_SECONDS: "3600"
});
expect(redisEnv.AGENT_RUN_EXECUTION_MODE).toBe("queue");
expect(redisEnv.AGENT_EVENT_BUS).toBe("redis");
expect(redisEnv.AGENT_QUEUE_NAME).toBe("facai-agent-runs");
expect(redisEnv.AGENT_WORKER_CONCURRENCY).toBe(4);
expect(redisEnv.AGENT_RUN_LOCK_TTL_SECONDS).toBe(900);
expect(redisEnv.AGENT_CANCEL_TTL_SECONDS).toBe(3600);
```

- [x] **步骤 2：验证测试失败**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/config/env.test.ts
```

预期：由于新的环境变量字段不存在而失败。

- [x] **步骤 3：实现配置并更新文档**

添加 zod 环境变量字段：

```ts
AGENT_RUN_EXECUTION_MODE: z.enum(["inline", "queue"]).default("inline"),
AGENT_QUEUE_NAME: z.string().min(1).default("agent-runs"),
AGENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
AGENT_RUN_LOCK_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(1800),
AGENT_CANCEL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(7200),
AGENT_EVENT_BUS: z.enum(["memory", "redis"]).default("memory")
```

添加 `.env.example` 条目和 `docker-compose.yml` Redis 服务：

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis-data:/data

volumes:
  redis-data:
```

- [x] **步骤 4：验证测试通过**

再次运行环境变量测试，并预期通过。

## 任务 2：Redis 运行时基础能力

**文件：**
- 创建：`apps/api/src/agent/agent-cancellation-store.ts`
- 创建：`apps/api/src/agent/agent-run-lock.ts`
- 创建：`apps/api/src/agent/agent-event-bus.ts`
- 测试：`apps/api/test/agent/agent-cancellation-store.test.ts`
- 测试：`apps/api/test/agent/agent-run-lock.test.ts`
- 测试：`apps/api/test/agent/agent-event-bus.test.ts`

- [x] **步骤 1：编写失败的基础能力测试**

使用模拟 Redis 客户端测试取消 TTL 行为、锁的 `NX EX` 行为，以及事件总线的发布/订阅行为。

- [x] **步骤 2：验证测试失败**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/agent/agent-cancellation-store.test.ts apps/api/test/agent/agent-run-lock.test.ts apps/api/test/agent/agent-event-bus.test.ts
```

预期：由于模块不存在而失败。

- [x] **步骤 3：实现最小化基础能力**

公开以下契约：

```ts
export interface AgentCancellationStore {
  cancelRun(runId: string): Promise<void>;
  isRunCancelled(runId: string): Promise<boolean>;
  clearRun(runId: string): Promise<void>;
}

export interface AgentRunLock {
  acquire(runId: string): Promise<AgentRunLockLease | undefined>;
}

export interface AgentEventBus {
  publishMessageEvent(messageId: string, event: StoredAgentEvent): Promise<void>;
  publishRunEvent(runId: string, event: StoredAgentEvent): Promise<void>;
  subscribeMessage(messageId: string, listener: AgentEventListener): Promise<() => Promise<void> | void>;
  subscribeRun(runId: string, listener: AgentEventListener): Promise<() => Promise<void> | void>;
}
```

- [x] **步骤 4：验证测试通过**

运行基础能力测试，并预期通过。

## 任务 3：队列封装与 Worker 入口

**文件：**
- 修改：`apps/api/package.json`
- 修改：根 `package.json`
- 创建：`apps/api/src/agent/agent-run-queue.ts`
- 创建：`apps/api/src/worker.ts`
- 测试：`apps/api/test/agent/agent-run-queue.test.ts`

- [x] **步骤 1：安装 BullMQ**

运行：

```bash
npm install bullmq -w @agent/api
```

- [x] **步骤 2：编写失败的队列封装测试**

测试 `AgentRunQueue.enqueueRun` 会写入稳定的任务名称、任务 ID，以及仅包含 ID 的载荷。

- [x] **步骤 3：验证测试失败**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/agent/agent-run-queue.test.ts
```

预期：由于封装不存在而失败。

- [x] **步骤 4：实现队列封装和 Worker 入口**

为 BullMQ `Queue` 创建封装，并创建负责构建应用运行时依赖和消费任务的 Worker 入口。

- [x] **步骤 5：验证测试通过**

运行队列封装测试和 `npm run typecheck -w @agent/api`。

## 任务 4：协调器队列模式

**文件：**
- 修改：`apps/api/src/agent/agent-message-coordinator.ts`
- 修改：`apps/api/src/app.ts`
- 测试：`apps/api/test/agent/agent-message-coordinator.test.ts`
- 测试：`apps/api/test/routes/agent-routes.test.ts`

- [x] **步骤 1：编写失败的队列模式协调器测试**

创建模拟运行队列。断言启用队列模式时，`startRun` 会创建用户、运行和助手记录，并将运行加入队列，而不是内联执行 `AgentService`。

- [x] **步骤 2：验证测试失败**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/agent/agent-message-coordinator.test.ts
```

预期：由于协调器尚不支持队列模式而失败。

- [x] **步骤 3：实现队列模式**

为协调器添加可选队列依赖。保持内联模式为默认值。提取一个 Worker 可使用 `runId` 调用的运行执行方法。

- [x] **步骤 4：验证测试通过**

运行协调器和路由测试。

## 任务 5：事件总线装配

**文件：**
- 修改：`apps/api/src/agent/agent-message-coordinator.ts`
- 修改：`apps/api/src/routes/agent-routes.ts`
- 修改：`apps/api/src/app.ts`
- 测试：`apps/api/test/routes/agent-routes.test.ts`

- [x] **步骤 1：编写失败的 SSE 事件总线测试**

在路由测试中使用内存事件总线。断言在 SSE 订阅后发布的事件会被传递到响应。

- [x] **步骤 2：验证测试失败**

运行目标路由测试，并预期失败。

- [x] **步骤 3：实现事件总线发布/订阅集成**

协调器追加已存储事件后，将其发布到事件总线。路由通过协调器订阅，使现有内存存储订阅者在内联模式下仍能工作。

- [x] **步骤 4：验证测试通过**

运行路由测试。

## 任务 6：取消与锁集成

**文件：**
- 修改：`apps/api/src/agent/agent-message-coordinator.ts`
- 修改：`apps/api/src/agent/agent-service.ts`
- 测试：`apps/api/test/agent/agent-message-coordinator.test.ts`

- [x] **步骤 1：编写失败的取消/锁测试**

断言 `cancelRun` 会写入取消存储、队列 Worker 会跳过已取消的运行，并且重复的 Worker 执行无法获取同一运行锁。

- [x] **步骤 2：验证测试失败**

运行目标协调器测试，并预期失败。

- [x] **步骤 3：实现取消和锁检查**

Worker 执行会在执行前、迭代之间和最终写入前检查取消状态。运行锁在执行前获取，并在 `finally` 中释放。

- [x] **步骤 4：验证测试通过**

运行协调器测试。

## 任务 7：最终验证

**文件：**
- 所有已修改文件

- [x] **步骤 1：运行目标 API 测试**

```bash
npm run test -w @agent/api -- apps/api/test/config/env.test.ts apps/api/test/agent/agent-cancellation-store.test.ts apps/api/test/agent/agent-run-lock.test.ts apps/api/test/agent/agent-event-bus.test.ts apps/api/test/agent/agent-run-queue.test.ts apps/api/test/agent/agent-message-coordinator.test.ts apps/api/test/routes/agent-routes.test.ts
```

- [x] **步骤 2：运行类型检查**

```bash
npm run typecheck -w @agent/api
```

- [x] **步骤 3：时间允许时运行完整 API 测试**

```bash
npm run test -w @agent/api
```

- [ ] **步骤 4：手动冒烟测试**

```bash
docker compose up -d redis
npm run dev
```

从界面创建一次运行并验证它会完成。取消一次耗时较长的运行，并验证它被标记为已取消。

已于 2026-06-30 尝试执行，但本地 Docker 守护进程未运行，机器上也未安装 `redis-server`。自动化测试现已覆盖队列入队和 Worker 执行、Redis 基础能力契约、跨进程事件总线传递、取消守卫行为、运行锁，以及 `sql.js` 多存储实例文件刷新。
