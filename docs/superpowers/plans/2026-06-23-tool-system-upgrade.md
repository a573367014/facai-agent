# Tool System Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade tool execution from a simple registry call into a small runtime layer with validation, timeout, structured errors, duration tracking, and clearer events.

**Architecture:** Keep `ToolRegistry` as the tool catalog and add `ToolExecutor` as the runtime execution boundary. `AgentService` will call the executor instead of calling registry execution directly, while the existing React timeline reads the enriched events.

**Tech Stack:** TypeScript, Fastify, Vitest, zod, React.

---

### Task 1: ToolExecutor Behavior

**Files:**
- Create: `apps/api/src/tools/types.ts`
- Create: `apps/api/src/tools/executor.ts`
- Create: `apps/api/test/tools/executor.test.ts`
- Modify: `apps/api/src/tools/registry.ts`

- [x] Write failing tests for successful execution, invalid arguments, missing tools, thrown errors, and timeout.
- [x] Run `npm run test -w @agent/api -- test/tools/executor.test.ts` and verify the new tests fail because `ToolExecutor` does not exist.
- [x] Implement the minimal tool types and executor.
- [x] Run the executor tests and verify they pass.

### Task 2: Existing Tool Migration

**Files:**
- Modify: `apps/api/src/tools/calculator.ts`
- Modify: `apps/api/src/tools/current-time.ts`
- Modify: `apps/api/src/tools/index.ts`
- Modify: `apps/api/test/tools/calculator.test.ts`
- Modify: `apps/api/test/tools/registry.test.ts`

- [x] Update existing tools to export the new `ToolDefinition` shape.
- [x] Keep their public behavior unchanged.
- [x] Run `npm run test -w @agent/api -- test/tools`.

### Task 3: AgentService Integration

**Files:**
- Modify: `apps/api/src/agent/agent-service.ts`
- Modify: `apps/api/src/agent/types.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `.env.example`
- Modify: `apps/api/test/agent/agent-service.test.ts`
- Modify: `apps/api/test/routes/agent-routes.test.ts`

- [x] Replace direct `toolRegistry.execute` calls with `toolExecutor.execute`.
- [x] Include `toolCallId`, `durationMs`, and structured error details in tool events.
- [x] Add `AGENT_TOOL_TIMEOUT_MS`, defaulting to 10000.
- [x] Run API tests and fix integration failures.

### Task 4: Frontend Timeline

**Files:**
- Modify: `apps/web/src/components/AgentTimeline.tsx`
- Modify: `apps/web/src/api/agent-client.ts`
- Modify: `apps/web/src/App.test.tsx`

- [x] Teach the client types about enriched tool events.
- [x] Display tool duration and structured error code/recoverable state when present.
- [x] Run web tests.

### Task 5: Final Verification

**Files:**
- Modify docs only if implementation differs from the design.

- [x] Run `npm run test`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Review `git diff` for accidental secrets or unrelated churn.
