# Redis Runtime Implementation Plan

> 2026-07-01 update: runtime configuration has been productized. The app now assumes `API + Worker + Redis + SQLite` as the main path, and the old environment switches for local memory state, inline run execution, and event bus selection are superseded. This plan remains as the historical implementation trail for the Redis runtime primitives.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Agent run execution toward a Redis-backed runtime with running draft, event bus, queue, worker, cancellation, and lock primitives.

**Architecture:** SQLite remains the durable source of truth for sessions, messages, runs, resources, tool calls, and stored events. Redis owns short-lived runtime coordination: running draft, live event fanout, BullMQ jobs, cancellation flags, and run locks. The first implementation keeps `startMessage` inline and focuses queue execution on the run path used by `/agents/runs` and `/agents/sessions/:sessionId/runs`.

**Tech Stack:** Fastify, TypeScript, ioredis, BullMQ, Vitest, SQLite/sql.js, npm workspaces.

---

## File Map

- Modify `apps/api/package.json`: add `bullmq`, `dev:worker`, and `worker` scripts.
- Modify root `package.json`: start `api`, `web`, and `worker` together in dev mode.
- Modify `apps/api/src/config/env.ts`: add execution mode, queue, worker, lock, cancel, and event bus config.
- Create `docker-compose.yml`: local Redis service.
- Create `apps/api/src/redis/runtime.ts`: Redis client factory and lifecycle container.
- Create `apps/api/src/agent/agent-event-bus.ts`: in-memory and Redis live event bus.
- Create `apps/api/src/agent/agent-cancellation-store.ts`: in-memory and Redis cancellation flags.
- Create `apps/api/src/agent/agent-run-lock.ts`: in-memory and Redis run locks.
- Create `apps/api/src/agent/agent-run-queue.ts`: BullMQ queue wrapper.
- Create `apps/api/src/worker.ts`: worker process entry.
- Modify `apps/api/src/agent/agent-message-coordinator.ts`: split run creation from run execution and support queue mode.
- Modify `apps/api/src/app.ts`: wire Redis runtime, event bus, queue, cancellation store, and lock.
- Modify `README.md` and `.env.example`: document Redis Runtime setup.
- Add tests under `apps/api/test/agent/` and `apps/api/test/config/`.

## Task 1: Config And Local Redis

**Files:**
- Modify: `apps/api/src/config/env.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Create: `docker-compose.yml`
- Test: `apps/api/test/config/env.test.ts`

- [x] **Step 1: Write failing env tests**

Add tests that assert default inline/memory behavior and Redis queue config parsing:

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

- [x] **Step 2: Verify RED**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/config/env.test.ts
```

Expected: fail because the new env fields do not exist.

- [x] **Step 3: Implement config and docs**

Add zod env fields:

```ts
AGENT_RUN_EXECUTION_MODE: z.enum(["inline", "queue"]).default("inline"),
AGENT_QUEUE_NAME: z.string().min(1).default("agent-runs"),
AGENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
AGENT_RUN_LOCK_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(1800),
AGENT_CANCEL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(7200),
AGENT_EVENT_BUS: z.enum(["memory", "redis"]).default("memory")
```

Add `.env.example` entries and a `docker-compose.yml` Redis service:

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

- [x] **Step 4: Verify GREEN**

Run the env test again and expect pass.

## Task 2: Redis Runtime Primitives

**Files:**
- Create: `apps/api/src/agent/agent-cancellation-store.ts`
- Create: `apps/api/src/agent/agent-run-lock.ts`
- Create: `apps/api/src/agent/agent-event-bus.ts`
- Test: `apps/api/test/agent/agent-cancellation-store.test.ts`
- Test: `apps/api/test/agent/agent-run-lock.test.ts`
- Test: `apps/api/test/agent/agent-event-bus.test.ts`

- [x] **Step 1: Write failing primitive tests**

Test cancellation TTL behavior, lock `NX EX` behavior, and event bus publish/subscribe behavior using fake Redis clients.

- [x] **Step 2: Verify RED**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/agent/agent-cancellation-store.test.ts apps/api/test/agent/agent-run-lock.test.ts apps/api/test/agent/agent-event-bus.test.ts
```

Expected: fail because modules do not exist.

- [x] **Step 3: Implement minimal primitives**

Expose these contracts:

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

- [x] **Step 4: Verify GREEN**

Run primitive tests and expect pass.

## Task 3: Queue Wrapper And Worker Entry

**Files:**
- Modify: `apps/api/package.json`
- Modify: root `package.json`
- Create: `apps/api/src/agent/agent-run-queue.ts`
- Create: `apps/api/src/worker.ts`
- Test: `apps/api/test/agent/agent-run-queue.test.ts`

- [x] **Step 1: Install BullMQ**

Run:

```bash
npm install bullmq -w @agent/api
```

- [x] **Step 2: Write failing queue wrapper test**

Test that `AgentRunQueue.enqueueRun` writes a stable job name, job id, and payload containing only IDs.

- [x] **Step 3: Verify RED**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/agent/agent-run-queue.test.ts
```

Expected: fail because wrapper does not exist.

- [x] **Step 4: Implement queue wrapper and worker entry**

Create a wrapper around BullMQ `Queue` and a worker entry that builds the app runtime dependencies and consumes jobs.

- [x] **Step 5: Verify GREEN**

Run queue wrapper tests and `npm run typecheck -w @agent/api`.

## Task 4: Coordinator Queue Mode

**Files:**
- Modify: `apps/api/src/agent/agent-message-coordinator.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/agent/agent-message-coordinator.test.ts`
- Test: `apps/api/test/routes/agent-routes.test.ts`

- [x] **Step 1: Write failing queue-mode coordinator test**

Create a fake run queue. Assert `startRun` creates user/run/assistant records and enqueues the run instead of executing `AgentService` inline when queue mode is enabled.

- [x] **Step 2: Verify RED**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/agent/agent-message-coordinator.test.ts
```

Expected: fail because coordinator cannot accept queue mode yet.

- [x] **Step 3: Implement queue mode**

Add optional queue dependency to coordinator. Keep inline mode as default. Extract an executable run method that Worker can call with a `runId`.

- [x] **Step 4: Verify GREEN**

Run coordinator and route tests.

## Task 5: Event Bus Wiring

**Files:**
- Modify: `apps/api/src/agent/agent-message-coordinator.ts`
- Modify: `apps/api/src/routes/agent-routes.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/routes/agent-routes.test.ts`

- [x] **Step 1: Write failing SSE event bus test**

Use an in-memory event bus in route tests. Assert an event published after SSE subscription is delivered to the response.

- [x] **Step 2: Verify RED**

Run the targeted route test and expect failure.

- [x] **Step 3: Implement event bus publish/subscribe integration**

Coordinator publishes stored events to event bus after appending them. Routes subscribe through coordinator so existing in-memory store subscribers still work in inline mode.

- [x] **Step 4: Verify GREEN**

Run route tests.

## Task 6: Cancellation And Lock Integration

**Files:**
- Modify: `apps/api/src/agent/agent-message-coordinator.ts`
- Modify: `apps/api/src/agent/agent-service.ts`
- Test: `apps/api/test/agent/agent-message-coordinator.test.ts`

- [x] **Step 1: Write failing cancel/lock tests**

Assert `cancelRun` writes cancellation store, queued worker skips cancelled runs, and duplicate worker execution cannot acquire the same run lock.

- [x] **Step 2: Verify RED**

Run targeted coordinator tests and expect failure.

- [x] **Step 3: Implement cancel and lock checks**

Worker execution checks cancellation before execution, between iterations, and before final write. Run lock is acquired before executing and released in `finally`.

- [x] **Step 4: Verify GREEN**

Run coordinator tests.

## Task 7: Final Verification

**Files:**
- All modified files

- [x] **Step 1: Run targeted API tests**

```bash
npm run test -w @agent/api -- apps/api/test/config/env.test.ts apps/api/test/agent/agent-cancellation-store.test.ts apps/api/test/agent/agent-run-lock.test.ts apps/api/test/agent/agent-event-bus.test.ts apps/api/test/agent/agent-run-queue.test.ts apps/api/test/agent/agent-message-coordinator.test.ts apps/api/test/routes/agent-routes.test.ts
```

- [x] **Step 2: Run typecheck**

```bash
npm run typecheck -w @agent/api
```

- [x] **Step 3: Run full API tests if time allows**

```bash
npm run test -w @agent/api
```

- [ ] **Step 4: Manual smoke**

```bash
docker compose up -d redis
npm run dev
```

Create a run from the UI and verify it completes. Cancel a long run and verify it is marked cancelled.

Attempted on 2026-06-30, but the local Docker daemon was not running and `redis-server` was not installed on the machine. Automated coverage now includes queue enqueue/worker execution, Redis primitive contracts, cross-process event bus delivery, cancellation guard behavior, run locks, and `sql.js` multi-store file refresh.
