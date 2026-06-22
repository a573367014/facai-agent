# Fastify React Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Fastify + React 的 LLM 工具调用型 Agent Demo，后端提供 `/agents/run`，前端提供可用的调试台。

**Architecture:** 根目录使用 npm workspaces 管理 `apps/api` 和 `apps/web`。API 层只负责 HTTP，AgentService 负责 agent loop，Provider Adapter 负责 OpenAI-compatible 请求，Tool Registry 负责工具注册和执行。React Demo 只调用 API，不包含 agent 业务逻辑。

**Tech Stack:** Node.js, npm workspaces, TypeScript, Fastify, @fastify/cors, Vite, React, Vitest, Testing Library, jsdom.

---

## 文件结构

需要创建：

- `package.json`：根 workspace 脚本。
- `.gitignore`：忽略依赖、构建产物和环境变量。
- `.env.example`：列出 API 和 Web 的环境变量。
- `apps/api/package.json`：API 依赖和脚本。
- `apps/api/tsconfig.json`：API TypeScript 配置。
- `apps/api/vitest.config.ts`：API 测试配置。
- `apps/api/src/app.ts`：创建 Fastify 实例并注册插件、路由、错误处理。
- `apps/api/src/server.ts`：读取环境变量并启动服务。
- `apps/api/src/config/env.ts`：解析 API 环境变量。
- `apps/api/src/agent/types.ts`：Agent 内部类型。
- `apps/api/src/agent/instructions.ts`：系统提示词。
- `apps/api/src/agent/agent-service.ts`：Agent loop。
- `apps/api/src/errors/app-error.ts`：统一应用错误。
- `apps/api/src/providers/types.ts`：Provider 接口。
- `apps/api/src/providers/openai-compatible-provider.ts`：OpenAI-compatible Provider。
- `apps/api/src/tools/registry.ts`：Tool Registry。
- `apps/api/src/tools/calculator.ts`：计算器工具。
- `apps/api/src/tools/current-time.ts`：当前时间工具。
- `apps/api/src/tools/index.ts`：默认工具集合。
- `apps/api/src/routes/health-routes.ts`：健康检查路由。
- `apps/api/src/routes/agent-routes.ts`：Agent 执行路由。
- `apps/api/test/tools/calculator.test.ts`：计算器测试。
- `apps/api/test/tools/registry.test.ts`：Tool Registry 测试。
- `apps/api/test/agent/agent-service.test.ts`：AgentService 测试。
- `apps/api/test/routes/agent-routes.test.ts`：API 路由测试。
- `apps/web/package.json`：Web 依赖和脚本。
- `apps/web/tsconfig.json`：Web TypeScript 配置。
- `apps/web/tsconfig.node.json`：Vite 配置的 TypeScript 配置。
- `apps/web/vite.config.ts`：Vite 配置。
- `apps/web/index.html`：React 入口 HTML。
- `apps/web/src/main.tsx`：React 入口。
- `apps/web/src/App.tsx`：页面容器。
- `apps/web/src/styles.css`：Demo 工作台样式。
- `apps/web/src/api/agent-client.ts`：前端 API client。
- `apps/web/src/components/AgentRunForm.tsx`：任务输入表单。
- `apps/web/src/components/AgentResultPanel.tsx`：结果面板。
- `apps/web/src/components/AgentSteps.tsx`：工具步骤展示。
- `apps/web/src/App.test.tsx`：React Demo 行为测试。
- `apps/web/src/test/setup.ts`：Testing Library 设置。

当前目录不是 git 仓库，所以计划中的提交步骤只有在执行 `git init` 后才运行。若不初始化 git，则跳过提交步骤。

---

### Task 1: Workspace 基础工程

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/tsconfig.node.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/test/setup.ts`

- [ ] **Step 1: 写根目录配置**

`package.json`:

```json
{
  "name": "fastify-react-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": [
    "apps/api",
    "apps/web"
  ],
  "scripts": {
    "dev": "npm run dev -w @agent/api",
    "dev:api": "npm run dev -w @agent/api",
    "dev:web": "npm run dev -w @agent/web",
    "build": "npm run build -w @agent/api && npm run build -w @agent/web",
    "test": "npm run test -w @agent/api && npm run test -w @agent/web",
    "typecheck": "npm run typecheck -w @agent/api && npm run typecheck -w @agent/web"
  },
  "engines": {
    "node": ">=20"
  }
}
```

`.gitignore`:

```gitignore
node_modules/
dist/
coverage/
.env
.DS_Store
```

`.env.example`:

```dotenv
PORT=3000
HOST=0.0.0.0
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=
AGENT_MAX_ITERATIONS=4
VITE_API_BASE_URL=http://localhost:3000
```

- [ ] **Step 2: 写 API package 配置**

`apps/api/package.json`:

```json
{
  "name": "@agent/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@fastify/cors": "^10.0.2",
    "fastify": "^5.2.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`apps/api/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "test"]
}
```

`apps/api/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
```

- [ ] **Step 3: 写 Web package 配置**

`apps/web/package.json`:

```json
{
  "name": "@agent/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 0.0.0.0",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b --noEmit"
  },
  "dependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "lucide-react": "^0.468.0",
    "vite": "^6.0.3",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "jsdom": "^25.0.1",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`apps/web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2020"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

`apps/web/tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

`apps/web/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"]
  }
});
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Agent Demo</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: 安装依赖**

Run:

```bash
npm install
```

Expected: 生成 `package-lock.json`，依赖安装成功。

- [ ] **Step 5: 运行基础检查**

Run:

```bash
npm run typecheck
```

Expected: 因为业务文件尚未创建，API 或 Web 可能提示入口文件缺失；后续任务补齐入口后再要求通过。

---

### Task 2: API 工具层

**Files:**
- Create: `apps/api/test/tools/calculator.test.ts`
- Create: `apps/api/test/tools/registry.test.ts`
- Create: `apps/api/src/errors/app-error.ts`
- Create: `apps/api/src/agent/types.ts`
- Create: `apps/api/src/tools/registry.ts`
- Create: `apps/api/src/tools/calculator.ts`
- Create: `apps/api/src/tools/current-time.ts`
- Create: `apps/api/src/tools/index.ts`

- [ ] **Step 1: 先写失败测试**

`apps/api/test/tools/calculator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { calculatorTool } from "../../src/tools/calculator.js";

describe("calculatorTool", () => {
  it("计算安全算术表达式", async () => {
    await expect(calculatorTool.execute({ expression: "12 * (9 + 1)" })).resolves.toEqual({ value: 120 });
  });

  it("拒绝非算术表达式", async () => {
    await expect(calculatorTool.execute({ expression: "process.exit()" })).rejects.toThrow("只支持安全的算术表达式");
  });
});
```

`apps/api/test/tools/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors/app-error.js";
import { ToolRegistry } from "../../src/tools/registry.js";

describe("ToolRegistry", () => {
  it("注册并执行工具", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "Echo input",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      },
      execute: async (args) => ({ text: String(args.text) })
    });

    await expect(registry.execute("echo", { text: "hi" })).resolves.toEqual({ text: "hi" });
    expect(registry.getDefinitions()).toHaveLength(1);
  });

  it("未知工具返回 TOOL_NOT_FOUND", async () => {
    const registry = new ToolRegistry();

    await expect(registry.execute("missing", {})).rejects.toMatchObject<AppError>({
      code: "TOOL_NOT_FOUND"
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npm run test -w @agent/api -- test/tools/calculator.test.ts test/tools/registry.test.ts
```

Expected: FAIL，提示找不到 `calculator.js`、`registry.js` 或 `app-error.js`。

- [ ] **Step 3: 实现错误和类型**

`apps/api/src/errors/app-error.ts`:

```ts
export type AppErrorCode =
  | "VALIDATION_ERROR"
  | "PROVIDER_ERROR"
  | "TOOL_NOT_FOUND"
  | "TOOL_EXECUTION_ERROR"
  | "AGENT_MAX_ITERATIONS";

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly statusCode = 500
  ) {
    super(message);
    this.name = "AppError";
  }
}
```

`apps/api/src/agent/types.ts`:

```ts
export type JsonObject = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
}

export interface RegisteredTool extends ToolDefinition {
  execute: (args: JsonObject) => Promise<unknown>;
}

export interface AgentStep {
  type: "tool_call";
  toolName: string;
  arguments: JsonObject;
  result: unknown;
}

export interface AgentRunResult {
  answer: string;
  steps: AgentStep[];
}
```

- [ ] **Step 4: 实现 Tool Registry**

`apps/api/src/tools/registry.ts`:

```ts
import type { JsonObject, RegisteredTool, ToolDefinition } from "../agent/types.js";
import { AppError } from "../errors/app-error.js";

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters
    }));
  }

  async execute(name: string, args: JsonObject): Promise<unknown> {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new AppError("TOOL_NOT_FOUND", `Tool not found: ${name}`, 404);
    }

    try {
      return await tool.execute(args);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : "Tool execution failed";
      throw new AppError("TOOL_EXECUTION_ERROR", message, 500);
    }
  }
}
```

- [ ] **Step 5: 实现内置工具**

`apps/api/src/tools/calculator.ts`:

```ts
import { z } from "zod";
import { AppError } from "../errors/app-error.js";
import type { RegisteredTool } from "../agent/types.js";

const calculatorArgsSchema = z.object({
  expression: z.string().min(1)
});

const safeExpressionPattern = /^[0-9+\-*/%().\s]+$/;

export const calculatorTool: RegisteredTool = {
  name: "calculator",
  description: "计算安全的基础算术表达式，只支持数字、括号、加减乘除和取模。",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "要计算的算术表达式，例如 12 * (9 + 1)"
      }
    },
    required: ["expression"]
  },
  async execute(args) {
    const { expression } = calculatorArgsSchema.parse(args);

    if (!safeExpressionPattern.test(expression)) {
      throw new AppError("TOOL_EXECUTION_ERROR", "只支持安全的算术表达式", 400);
    }

    const value = Function(`"use strict"; return (${expression});`)();

    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AppError("TOOL_EXECUTION_ERROR", "表达式结果不是有限数字", 400);
    }

    return { value };
  }
};
```

`apps/api/src/tools/current-time.ts`:

```ts
import { z } from "zod";
import type { RegisteredTool } from "../agent/types.js";

const currentTimeArgsSchema = z.object({
  timezone: z.string().optional().default("UTC")
});

export const currentTimeTool: RegisteredTool = {
  name: "current_time",
  description: "返回指定时区的当前时间。",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA 时区名称，例如 Asia/Shanghai"
      }
    }
  },
  async execute(args) {
    const { timezone } = currentTimeArgsSchema.parse(args);
    const now = new Date();

    return {
      iso: now.toISOString(),
      timezone,
      localized: new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: timezone
      }).format(now)
    };
  }
};
```

`apps/api/src/tools/index.ts`:

```ts
import { calculatorTool } from "./calculator.js";
import { currentTimeTool } from "./current-time.js";
import { ToolRegistry } from "./registry.js";

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(calculatorTool);
  registry.register(currentTimeTool);
  return registry;
}
```

- [ ] **Step 6: 运行测试确认通过**

Run:

```bash
npm run test -w @agent/api -- test/tools/calculator.test.ts test/tools/registry.test.ts
```

Expected: PASS。

---

### Task 3: API Agent Core 和 Provider

**Files:**
- Create: `apps/api/test/agent/agent-service.test.ts`
- Create: `apps/api/src/agent/instructions.ts`
- Create: `apps/api/src/agent/agent-service.ts`
- Create: `apps/api/src/providers/types.ts`
- Create: `apps/api/src/providers/openai-compatible-provider.ts`
- Modify: `apps/api/src/agent/types.ts`

- [ ] **Step 1: 写 AgentService 失败测试**

`apps/api/test/agent/agent-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AgentService } from "../../src/agent/agent-service.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";

describe("AgentService", () => {
  it("执行工具调用并返回最终答案", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "calculator",
      description: "calculator",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ value: 108 })
    });

    const provider: LlmProvider = {
      complete: async ({ messages }) => {
        if (messages.some((message) => message.role === "tool")) {
          return { content: "结果是 108。" };
        }

        return {
          toolCalls: [
            {
              id: "call_1",
              name: "calculator",
              arguments: { expression: "12 * 9" }
            }
          ]
        };
      }
    };

    const service = new AgentService({ provider, toolRegistry: registry, defaultMaxIterations: 4 });

    await expect(service.run({ input: "计算 12 * 9" })).resolves.toEqual({
      answer: "结果是 108。",
      steps: [
        {
          type: "tool_call",
          toolName: "calculator",
          arguments: { expression: "12 * 9" },
          result: { value: 108 }
        }
      ]
    });
  });

  it("达到最大迭代次数时返回 AGENT_MAX_ITERATIONS", async () => {
    const provider: LlmProvider = {
      complete: async () => ({
        toolCalls: [{ id: "call_1", name: "noop", arguments: {} }]
      })
    };
    const registry = new ToolRegistry();
    registry.register({
      name: "noop",
      description: "noop",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true })
    });
    const service = new AgentService({ provider, toolRegistry: registry, defaultMaxIterations: 1 });

    await expect(service.run({ input: "一直调用工具" })).rejects.toMatchObject({
      code: "AGENT_MAX_ITERATIONS"
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npm run test -w @agent/api -- test/agent/agent-service.test.ts
```

Expected: FAIL，提示找不到 `agent-service.js` 或 `providers/types.js`。

- [ ] **Step 3: 扩展 Agent 类型**

`apps/api/src/agent/types.ts`:

```ts
export type JsonObject = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
}

export interface RegisteredTool extends ToolDefinition {
  execute: (args: JsonObject) => Promise<unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface AgentStep {
  type: "tool_call";
  toolName: string;
  arguments: JsonObject;
  result: unknown;
}

export interface AgentRunInput {
  input: string;
  maxIterations?: number;
}

export interface AgentRunResult {
  answer: string;
  steps: AgentStep[];
}
```

- [ ] **Step 4: 实现 Provider 接口和 OpenAI-compatible Provider**

`apps/api/src/providers/types.ts`:

```ts
import type { AgentMessage, ToolCall, ToolDefinition } from "../agent/types.js";

export interface LlmProviderRequest {
  messages: AgentMessage[];
  tools: ToolDefinition[];
}

export interface LlmProviderResponse {
  content?: string;
  toolCalls?: ToolCall[];
}

export interface LlmProvider {
  complete(request: LlmProviderRequest): Promise<LlmProviderResponse>;
}
```

`apps/api/src/providers/openai-compatible-provider.ts`:

```ts
import { AppError } from "../errors/app-error.js";
import type { AgentMessage } from "../agent/types.js";
import type { LlmProvider, LlmProviderRequest, LlmProviderResponse } from "./types.js";

export interface OpenAiCompatibleProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function toProviderMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content ?? null,
      tool_calls: message.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments)
        }
      }))
    };
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content
    };
  }

  return message;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly options: OpenAiCompatibleProviderOptions) {}

  async complete(request: LlmProviderRequest): Promise<LlmProviderResponse> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: request.messages.map(toProviderMessage),
        tools: request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        }))
      })
    });

    if (!response.ok) {
      throw new AppError("PROVIDER_ERROR", `Provider request failed: ${response.status}`, 502);
    }

    const payload = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            function: {
              name: string;
              arguments: string;
            };
          }>;
        };
      }>;
    };

    const message = payload.choices?.[0]?.message;

    if (!message) {
      throw new AppError("PROVIDER_ERROR", "Provider returned no message", 502);
    }

    return {
      content: message.content ?? undefined,
      toolCalls: message.tool_calls?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>
      }))
    };
  }
}
```

- [ ] **Step 5: 实现 Agent 指令和 AgentService**

`apps/api/src/agent/instructions.ts`:

```ts
export const SYSTEM_INSTRUCTIONS = [
  "你是一个工具调用型 Agent。",
  "当用户问题需要计算或查询当前时间时，优先调用可用工具。",
  "工具返回结果后，用简洁中文回答用户。",
  "不知道的信息不要编造。"
].join("\n");
```

`apps/api/src/agent/agent-service.ts`:

```ts
import { AppError } from "../errors/app-error.js";
import type { LlmProvider } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { SYSTEM_INSTRUCTIONS } from "./instructions.js";
import type { AgentMessage, AgentRunInput, AgentRunResult, AgentStep } from "./types.js";

export interface AgentServiceOptions {
  provider: LlmProvider;
  toolRegistry: ToolRegistry;
  defaultMaxIterations: number;
}

export class AgentService {
  constructor(private readonly options: AgentServiceOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const maxIterations = input.maxIterations ?? this.options.defaultMaxIterations;
    const messages: AgentMessage[] = [
      { role: "system", content: SYSTEM_INSTRUCTIONS },
      { role: "user", content: input.input }
    ];
    const steps: AgentStep[] = [];
    const tools = this.options.toolRegistry.getDefinitions();

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const response = await this.options.provider.complete({ messages, tools });

      if (response.content && !response.toolCalls?.length) {
        return { answer: response.content, steps };
      }

      if (!response.toolCalls?.length) {
        return { answer: response.content ?? "", steps };
      }

      messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });

      for (const toolCall of response.toolCalls) {
        const result = await this.options.toolRegistry.execute(toolCall.name, toolCall.arguments);
        steps.push({
          type: "tool_call",
          toolName: toolCall.name,
          arguments: toolCall.arguments,
          result
        });
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: JSON.stringify(result)
        });
      }
    }

    throw new AppError("AGENT_MAX_ITERATIONS", "Agent reached max iterations without a final answer", 422);
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run:

```bash
npm run test -w @agent/api -- test/agent/agent-service.test.ts
```

Expected: PASS。

---

### Task 4: API 路由和服务启动

**Files:**
- Create: `apps/api/test/routes/agent-routes.test.ts`
- Create: `apps/api/src/config/env.ts`
- Create: `apps/api/src/routes/health-routes.ts`
- Create: `apps/api/src/routes/agent-routes.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/server.ts`

- [ ] **Step 1: 写路由失败测试**

`apps/api/test/routes/agent-routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { AgentService } from "../../src/agent/agent-service.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";

function createTestAgentService(): AgentService {
  const registry = new ToolRegistry();
  const provider: LlmProvider = {
    complete: async () => ({ content: "测试回答" })
  };
  return new AgentService({ provider, toolRegistry: registry, defaultMaxIterations: 4 });
}

describe("agent routes", () => {
  it("GET /health 返回 ok", async () => {
    const app = await buildApp({ agentService: createTestAgentService() });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("POST /agents/run 返回 agent 结果", async () => {
    const app = await buildApp({ agentService: createTestAgentService() });
    const response = await app.inject({
      method: "POST",
      url: "/agents/run",
      payload: { input: "你好" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ answer: "测试回答", steps: [] });
  });

  it("POST /agents/run 校验空 input", async () => {
    const app = await buildApp({ agentService: createTestAgentService() });
    const response = await app.inject({
      method: "POST",
      url: "/agents/run",
      payload: { input: "" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" }
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npm run test -w @agent/api -- test/routes/agent-routes.test.ts
```

Expected: FAIL，提示找不到 `app.js`。

- [ ] **Step 3: 实现配置和路由**

`apps/api/src/config/env.ts`:

```ts
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_MODEL: z.string().optional(),
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(8).default(4)
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
```

`apps/api/src/routes/health-routes.ts`:

```ts
import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok" }));
}
```

`apps/api/src/routes/agent-routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors/app-error.js";
import type { AgentService } from "../agent/agent-service.js";

const runRequestSchema = z.object({
  input: z.string().trim().min(1),
  maxIterations: z.number().int().min(1).max(8).optional()
});

export async function registerAgentRoutes(app: FastifyInstance, agentService: AgentService): Promise<void> {
  app.post("/agents/run", async (request) => {
    const parsed = runRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      throw new AppError("VALIDATION_ERROR", "input must be a non-empty string and maxIterations must be 1-8", 400);
    }

    return agentService.run(parsed.data);
  });
}
```

- [ ] **Step 4: 实现 app 和 server**

`apps/api/src/app.ts`:

```ts
import cors from "@fastify/cors";
import Fastify from "fastify";
import { AgentService } from "./agent/agent-service.js";
import { loadEnv } from "./config/env.js";
import { AppError } from "./errors/app-error.js";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible-provider.js";
import { registerAgentRoutes } from "./routes/agent-routes.js";
import { registerHealthRoutes } from "./routes/health-routes.js";
import { createDefaultToolRegistry } from "./tools/index.js";

export interface BuildAppOptions {
  agentService?: AgentService;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: ["http://localhost:5173"]
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message
        }
      });
      return;
    }

    reply.status(500).send({
      error: {
        code: "PROVIDER_ERROR",
        message: error.message
      }
    });
  });

  const env = loadEnv();
  const agentService = options.agentService ?? new AgentService({
    provider: new OpenAiCompatibleProvider({
      apiKey: env.OPENAI_API_KEY ?? "",
      baseUrl: env.OPENAI_BASE_URL,
      model: env.OPENAI_MODEL ?? ""
    }),
    toolRegistry: createDefaultToolRegistry(),
    defaultMaxIterations: env.AGENT_MAX_ITERATIONS
  });

  await registerHealthRoutes(app);
  await registerAgentRoutes(app, agentService);

  return app;
}
```

`apps/api/src/server.ts`:

```ts
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();
const app = await buildApp();

await app.listen({
  port: env.PORT,
  host: env.HOST
});
```

- [ ] **Step 5: 运行路由测试确认通过**

Run:

```bash
npm run test -w @agent/api -- test/routes/agent-routes.test.ts
```

Expected: PASS。

---

### Task 5: React Demo

**Files:**
- Create: `apps/web/src/App.test.tsx`
- Create: `apps/web/src/api/agent-client.ts`
- Create: `apps/web/src/components/AgentRunForm.tsx`
- Create: `apps/web/src/components/AgentResultPanel.tsx`
- Create: `apps/web/src/components/AgentSteps.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/styles.css`

- [ ] **Step 1: 写前端失败测试**

`apps/web/src/App.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("App", () => {
  it("提交任务并展示回答和步骤", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answer: "结果是 108",
        steps: [
          {
            type: "tool_call",
            toolName: "calculator",
            arguments: { expression: "12 * 9" },
            result: { value: 108 }
          }
        ]
      })
    } as Response);

    render(<App />);

    await userEvent.clear(screen.getByLabelText("任务"));
    await userEvent.type(screen.getByLabelText("任务"), "计算 12 * 9");
    await userEvent.click(screen.getByRole("button", { name: "运行" }));

    await waitFor(() => expect(screen.getByText("结果是 108")).toBeInTheDocument());
    expect(screen.getByText("calculator")).toBeInTheDocument();
    expect(screen.getByText(/12 \* 9/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
npm run test -w @agent/web -- src/App.test.tsx
```

Expected: FAIL，提示找不到 `App` 或相关组件。

- [ ] **Step 3: 实现前端 API client**

`apps/web/src/api/agent-client.ts`:

```ts
export interface AgentStep {
  type: "tool_call";
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface AgentRunResponse {
  answer: string;
  steps: AgentStep[];
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

export async function runAgent(input: string, maxIterations: number): Promise<AgentRunResponse> {
  const response = await fetch(`${apiBaseUrl}/agents/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ input, maxIterations })
  });

  const payload = await response.json() as AgentRunResponse | ApiErrorResponse;

  if (!response.ok) {
    const errorPayload = payload as ApiErrorResponse;
    throw new Error(`${errorPayload.error.code}: ${errorPayload.error.message}`);
  }

  return payload as AgentRunResponse;
}
```

- [ ] **Step 4: 实现 React 组件**

`apps/web/src/components/AgentRunForm.tsx`:

```tsx
import { Loader2, Play } from "lucide-react";
import type { FormEvent } from "react";

interface AgentRunFormProps {
  input: string;
  maxIterations: number;
  isRunning: boolean;
  onInputChange: (value: string) => void;
  onMaxIterationsChange: (value: number) => void;
  onSubmit: () => void;
}

const examples = [
  "计算 12 * 9，然后告诉我现在几点",
  "现在上海时间是多少？",
  "帮我计算 (32 + 18) * 4"
];

export function AgentRunForm(props: AgentRunFormProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onSubmit();
  }

  return (
    <form className="panel run-form" onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor="agent-input">任务</label>
        <textarea
          id="agent-input"
          value={props.input}
          onChange={(event) => props.onInputChange(event.target.value)}
          rows={8}
        />
      </div>

      <div className="form-row">
        <label htmlFor="max-iterations">最大迭代</label>
        <input
          id="max-iterations"
          type="number"
          min={1}
          max={8}
          value={props.maxIterations}
          onChange={(event) => props.onMaxIterationsChange(Number(event.target.value))}
        />
      </div>

      <button className="primary-button" type="submit" disabled={props.isRunning || !props.input.trim()}>
        {props.isRunning ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
        运行
      </button>

      <div className="examples">
        {examples.map((example) => (
          <button type="button" key={example} onClick={() => props.onInputChange(example)}>
            {example}
          </button>
        ))}
      </div>
    </form>
  );
}
```

`apps/web/src/components/AgentSteps.tsx`:

```tsx
import type { AgentStep } from "../api/agent-client";

interface AgentStepsProps {
  steps: AgentStep[];
}

export function AgentSteps({ steps }: AgentStepsProps) {
  if (steps.length === 0) {
    return <p className="muted">本次没有调用工具。</p>;
  }

  return (
    <ol className="steps">
      {steps.map((step, index) => (
        <li key={`${step.toolName}-${index}`}>
          <div className="step-header">
            <span>{index + 1}</span>
            <strong>{step.toolName}</strong>
          </div>
          <pre>{JSON.stringify({ arguments: step.arguments, result: step.result }, null, 2)}</pre>
        </li>
      ))}
    </ol>
  );
}
```

`apps/web/src/components/AgentResultPanel.tsx`:

```tsx
import type { AgentRunResponse } from "../api/agent-client";
import { AgentSteps } from "./AgentSteps";

interface AgentResultPanelProps {
  result: AgentRunResponse | null;
  error: string | null;
}

export function AgentResultPanel({ result, error }: AgentResultPanelProps) {
  return (
    <section className="panel result-panel">
      <div className="section-title">结果</div>
      {error ? <div className="error-box">{error}</div> : null}
      {result ? (
        <>
          <article className="answer">{result.answer}</article>
          <div className="section-title">工具步骤</div>
          <AgentSteps steps={result.steps} />
        </>
      ) : (
        <p className="muted">运行后会在这里展示回答和工具调用步骤。</p>
      )}
    </section>
  );
}
```

- [ ] **Step 5: 实现 App 和样式**

`apps/web/src/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { runAgent, type AgentRunResponse } from "./api/agent-client";
import { AgentResultPanel } from "./components/AgentResultPanel";
import { AgentRunForm } from "./components/AgentRunForm";
import "./styles.css";

const defaultInput = "计算 12 * 9，然后告诉我现在几点";

export default function App() {
  const [input, setInput] = useState(defaultInput);
  const [maxIterations, setMaxIterations] = useState(4);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<AgentRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState("检查中");

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000"}/health`)
      .then((response) => setHealth(response.ok ? "正常" : "异常"))
      .catch(() => setHealth("异常"));
  }, []);

  async function handleRun() {
    setIsRunning(true);
    setError(null);

    try {
      setResult(await runAgent(input, maxIterations));
    } catch (runError) {
      setResult(null);
      setError(runError instanceof Error ? runError.message : "请求失败");
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Agent Demo</h1>
          <p>Fastify + React 工具调用工作台</p>
        </div>
        <span className={health === "正常" ? "status ok" : "status"}>API {health}</span>
      </header>

      <div className="workspace">
        <AgentRunForm
          input={input}
          maxIterations={maxIterations}
          isRunning={isRunning}
          onInputChange={setInput}
          onMaxIterationsChange={setMaxIterations}
          onSubmit={handleRun}
        />
        <AgentResultPanel result={result} error={error} />
      </div>
    </main>
  );
}
```

`apps/web/src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

`apps/web/src/styles.css`:

```css
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
  color: #172033;
  background: #f4f6f8;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

button,
textarea,
input {
  font: inherit;
}

.app-shell {
  width: min(1180px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 24px 0;
}

.topbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.topbar h1 {
  margin: 0;
  font-size: 28px;
  letter-spacing: 0;
}

.topbar p {
  margin: 6px 0 0;
  color: #607089;
}

.status {
  border: 1px solid #cfd8e3;
  border-radius: 8px;
  padding: 6px 10px;
  background: #fff;
  color: #7b2d2d;
}

.status.ok {
  color: #176b42;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(320px, 420px) 1fr;
  gap: 16px;
}

.panel {
  border: 1px solid #dce3ec;
  border-radius: 8px;
  background: #fff;
  padding: 18px;
}

.run-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

label,
.section-title {
  color: #26364d;
  font-weight: 700;
}

textarea,
input {
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 10px 12px;
  background: #fff;
  color: #172033;
}

textarea {
  resize: vertical;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 96px;
  align-items: center;
  gap: 12px;
}

.primary-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 42px;
  border: 0;
  border-radius: 8px;
  background: #205493;
  color: #fff;
  cursor: pointer;
}

.primary-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.examples {
  display: grid;
  gap: 8px;
}

.examples button {
  border: 1px solid #d5dde8;
  border-radius: 8px;
  padding: 9px 10px;
  background: #f8fafc;
  color: #243247;
  text-align: left;
  cursor: pointer;
}

.result-panel {
  min-height: 420px;
}

.answer {
  margin: 12px 0 20px;
  border-left: 3px solid #205493;
  padding: 12px 14px;
  background: #f8fafc;
  line-height: 1.7;
}

.muted {
  color: #718096;
}

.error-box {
  margin: 12px 0;
  border: 1px solid #f0b8b8;
  border-radius: 8px;
  padding: 12px;
  background: #fff5f5;
  color: #8f1d1d;
}

.steps {
  display: grid;
  gap: 12px;
  padding-left: 0;
  list-style: none;
}

.step-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.step-header span {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: #e7eef8;
  color: #205493;
  font-weight: 700;
}

pre {
  overflow: auto;
  border-radius: 8px;
  margin: 0;
  padding: 12px;
  background: #111827;
  color: #e5e7eb;
  font-size: 13px;
  line-height: 1.5;
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 820px) {
  .workspace {
    grid-template-columns: 1fr;
  }

  .topbar {
    align-items: flex-start;
    flex-direction: column;
  }
}
```

- [ ] **Step 6: 运行前端测试确认通过**

Run:

```bash
npm run test -w @agent/web -- src/App.test.tsx
```

Expected: PASS。

---

### Task 6: 全量验证和本地运行

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 写 README**

`README.md`:

```md
# Fastify React Agent

一个基于 Node.js Fastify 和 React 的工具调用型 Agent Demo。

## 结构

- `apps/api`：Fastify Agent API
- `apps/web`：React Demo 工作台

## 环境变量

复制 `.env.example` 为 `.env`，并填写：

- `OPENAI_API_KEY`
- `OPENAI_MODEL`

## 安装

```bash
npm install
```

## 开发

启动 API：

```bash
npm run dev:api
```

启动 Web：

```bash
npm run dev:web
```

访问：

- API: `http://localhost:3000`
- Web: `http://localhost:5173`

## 测试

```bash
npm run test
npm run typecheck
npm run build
```
```

- [ ] **Step 2: 运行全部测试**

Run:

```bash
npm run test
```

Expected: API 和 Web 测试全部 PASS。

- [ ] **Step 3: 运行类型检查**

Run:

```bash
npm run typecheck
```

Expected: API 和 Web 类型检查全部 PASS。

- [ ] **Step 4: 运行构建**

Run:

```bash
npm run build
```

Expected: API 输出 `apps/api/dist`，Web 输出 `apps/web/dist`。

- [ ] **Step 5: 启动开发服务器**

Run:

```bash
npm run dev:api
```

Expected: API 监听 `http://localhost:3000`。

另开终端运行：

```bash
npm run dev:web
```

Expected: Web 监听 `http://localhost:5173`。

- [ ] **Step 6: 如果已经初始化 git，则提交**

Run:

```bash
git add .
git commit -m "feat: add fastify react agent demo"
```

Expected: 生成实现提交。当前目录未初始化 git 时跳过此步骤。

---

## 自查

- Spec 覆盖：API、Agent Core、Provider、Tool Registry、React Demo、配置、错误处理、测试策略都对应了任务。
- 类型一致：`AgentRunResponse`、`AgentStep`、`ToolCall`、`LlmProvider` 在计划中命名一致。
- 范围控制：第一版只做同步 Agent 和本地 Demo，不做持久化、队列、流式和多 Agent。
