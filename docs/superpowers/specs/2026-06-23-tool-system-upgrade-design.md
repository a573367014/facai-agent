# 工具系统升级 v1 设计

## 背景

当前项目已经具备一个工具调用型 Agent 的基本闭环：

- LLM 根据用户输入返回 `toolCalls`。
- `AgentService` 调用 `ToolRegistry.execute(toolName, arguments)`。
- 工具结果作为 `tool` 消息写回上下文。
- LLM 基于工具结果继续推理，并生成最终回答。
- 运行过程通过 SSE 事件推送到前端，并可持久化到 SQLite。

这个结构适合演示阶段，因为它直接、清晰、容易理解。但随着后续接入文件、网页搜索、数据库查询、RAG、代码执行等真实工具，单纯把工具调用塞在 `ToolRegistry.execute` 里会逐渐暴露问题：

- 参数校验不够统一，工具内部容易收到非法参数。
- 工具执行缺少统一超时，某个工具可能长期挂起。
- 错误格式不稳定，前端和 Agent 都难以判断失败原因。
- 缺少统一耗时记录，不利于排查慢工具。
- 缺少权限检查层，未来接入危险工具时风险较高。
- `AgentService` 会越来越关心工具细节，职责变重。

因此，下一阶段目标是把工具执行从“能调用”升级成“可治理、可观察、可扩展”的运行时能力。

## 目标

工具系统升级 v1 聚焦 Agent 运行时的基础能力，不做复杂插件平台。

本阶段目标：

- 标准化工具定义。
- 统一参数校验。
- 统一执行入口。
- 支持工具超时。
- 统一成功和失败返回结构。
- 记录工具执行耗时。
- 让前端能更清晰展示工具调用细节。
- 为后续运行取消、文件工具、网络工具、RAG 工具打基础。

非目标：

- 不做工具市场。
- 不做远程插件安装。
- 不做复杂多租户权限系统。
- 不做用户二次确认工具调用界面。
- 不引入独立任务队列。

## 推荐架构

保留 `ToolRegistry`，但让它专注做“工具目录”。新增 `ToolExecutor`，专门处理运行时执行逻辑。

```text
AgentService
  -> ToolExecutor
      -> ToolRegistry
      -> 参数校验
      -> 权限检查
      -> 超时控制
      -> 执行工具
      -> 统一结果
      -> 耗时记录
```

### 工具注册表的职责

`ToolRegistry` 只负责静态能力：

- 注册工具。
- 根据名称查找工具。
- 给 LLM 提供工具定义。
- 公开工具参数模式定义。

它不再承担完整运行时治理能力。

### 工具执行器的职责

`ToolExecutor` 负责每一次具体调用：

- 根据 `toolName` 找到工具。
- 校验参数。
- 检查工具是否允许执行。
- 创建超时控制。
- 调用工具函数。
- 捕获异常并转换成结构化错误。
- 记录 `durationMs`。
- 返回统一执行结果。

这样拆分后，`AgentService` 不需要关心工具执行细节，只需要处理工具结果和 Agent 推理流程。

## 类型设计

### 工具定义

建议把工具定义收敛成统一结构：

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  argumentSchema?: z.ZodTypeAny;
  execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown> | unknown;
}
```

`parameters` 保留为提供给 LLM 的 JSON 模式定义，确保 OpenAI 兼容的工具载荷不需要额外转换。`argumentSchema` 使用 zod，在真正执行前做运行时校验。

### 执行上下文

每次工具调用都应该带上上下文：

```ts
export interface ToolExecutionContext {
  runId?: string;
  sessionId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
}
```

这些字段暂时不一定全部使用，但提前放进上下文可以支撑后续能力：

- `runId`：把工具调用和运行关联起来。
- `sessionId`：后续做权限、审计、会话级资源时使用。
- `toolCallId`：与 LLM 返回的工具调用 ID 对齐。
- `signal`：支持取消和超时。

### 执行结果

工具执行结果统一为：

```ts
export type ToolExecutionResult =
  | {
      ok: true;
      data: unknown;
      durationMs: number;
      displayText?: string;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        recoverable: boolean;
      };
      durationMs: number;
    };
```

这样前端、日志和 `AgentService` 都可以用同一种结构理解工具执行结果。

## 执行流程

一次工具调用的新流程：

```text
1. LLM 返回 tool_call。
2. AgentService 发出 tool_call_ready 事件。
3. AgentService 调用 ToolExecutor.execute。
4. ToolExecutor 从 ToolRegistry 查找工具。
5. ToolExecutor 用 zod 校验 arguments。
6. ToolExecutor 检查工具权限。
7. ToolExecutor 创建超时控制。
8. ToolExecutor 执行工具函数。
9. ToolExecutor 计算 durationMs。
10. ToolExecutor 返回统一结果。
11. AgentService 发出 tool_result 或 tool_error 事件。
12. AgentService 把工具结果写回 LLM messages。
```

## 错误处理

工具错误分为几类：

- `TOOL_NOT_FOUND`：模型请求了不存在的工具。
- `TOOL_INVALID_ARGUMENTS`：参数不符合模式定义。
- `TOOL_TIMEOUT`：工具执行超过限制。
- `TOOL_PERMISSION_DENIED`：工具不允许在当前上下文执行。
- `TOOL_EXECUTION_ERROR`：工具内部执行失败。

这些错误都应该被转换为统一结构：

```ts
{
  ok: false,
  error: {
    code,
    message,
    recoverable
  },
  durationMs
}
```

`recoverable` 用于表示 Agent 是否可以尝试换一种方式继续。例如参数错误通常可恢复，权限错误通常不可恢复。

## 超时与取消

v1 先实现工具级超时，例如默认 `AGENT_TOOL_TIMEOUT_MS=10000`。

实现上可以由 `ToolExecutor` 创建内部 `AbortController`：

- 如果外层传入 `signal`，外层取消时同步取消工具。
- 如果达到超时时间，则中止内部控制器。
- 工具函数可以读取 `context.signal` 来主动中断。

这为后续 `POST /agents/runs/:runId/cancel` 做铺垫。到那一步时，运行取消可以同时中断 LLM 请求和工具请求。

## 事件设计

现有事件已经包含：

- `tool_call_ready`
- `tool_start`
- `tool_result`
- `tool_error`

v1 可以在不大改前端模型的情况下补字段：

- `toolCallId`
- `durationMs`
- `ok`
- `error.code`
- `error.recoverable`

这样时间线可以展示：

```text
调用 calculator
参数：{"expression":"1+1"}
结果：2
耗时：3ms
```

失败时展示：

```text
调用 search_web 失败
错误：TOOL_TIMEOUT
耗时：10000ms
```

## 文件改造范围

预计涉及：

- `apps/api/src/tools/types.ts`
  - 新增工具定义、执行上下文、执行结果类型。
- `apps/api/src/tools/registry.ts`
  - 保留注册和查找能力，减少运行时执行职责。
- `apps/api/src/tools/executor.ts`
  - 新增 `ToolExecutor`。
- `apps/api/src/tools/calculator.ts`
  - 改成新的工具定义格式。
- `apps/api/src/tools/current-time.ts`
  - 改成新的工具定义格式。
- `apps/api/src/agent/agent-service.ts`
  - 从直接调用注册表改成调用执行器。
- `apps/api/src/agent/types.ts`
  - 扩展工具事件字段。
- `apps/api/src/app.ts`
  - 组装 `ToolRegistry` 和 `ToolExecutor`。
- `apps/web/src/components/AgentTimeline.tsx`
  - 展示工具耗时和结构化错误。
- `apps/api/test/tools/*`
  - 增加执行器单元测试。
- `apps/api/test/agent/agent-service.test.ts`
  - 调整工具调用相关断言。

## 测试策略

后端重点测试：

- 正常工具调用返回 `ok: true`。
- 参数校验失败返回 `TOOL_INVALID_ARGUMENTS`。
- 未注册工具返回 `TOOL_NOT_FOUND`。
- 工具抛错返回 `TOOL_EXECUTION_ERROR`。
- 工具超时返回 `TOOL_TIMEOUT`。
- `durationMs` 存在且为数字。
- `AgentService` 能把成功工具结果写回 LLM 消息列表。
- `AgentService` 能把工具错误转换成事件。

前端重点测试：

- 工具结果仍能正常显示。
- 工具错误显示 `code` 和 `message`。
- `durationMs` 存在时展示耗时。

## 实施顺序

建议分 5 步实现：

1. 新增工具类型和 `ToolExecutor`，先不改 `AgentService`。
2. 把现有 `calculator`、`current-time` 迁移到新工具定义。
3. 改造 `ToolRegistry`，保留旧测试并补新测试。
4. 改造 `AgentService`，让工具调用走 `ToolExecutor`。
5. 调整事件和前端时间线展示。

这样每一步都可以独立验证，避免一次性改动太大。

## 后续衔接

工具系统升级 v1 完成后，最自然的下一步是运行生命周期升级：

- 运行取消可以复用 `ToolExecutionContext.signal`。
- 工具超时和运行取消可以共用取消机制。
- 工具调用日志可以继续进入 SQLite 事件流。
- 前端可以基于结构化工具事件做更好的调试视图。

因此本阶段不是孤立重构，而是在给后续取消、重试、文件工具、RAG 工具铺路。
