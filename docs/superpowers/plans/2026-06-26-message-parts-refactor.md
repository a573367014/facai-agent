# 消息分段重构实施计划

> **面向智能体执行者：** 必须使用子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项实施本计划。各步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 将当前的 `content + assets` 消息模型替换为单一的 `parts` 协议，使其与 ai-chat-vue 的文本/媒体方案保持一致，然后使用基于 ProseMirror 的编辑器实现富文本用户输入。

**架构：** 将每条用户消息和助手消息以 `MessagePart[]` 的形式持久化到 `agent_messages.parts_json`。流式更新通过 `messageId + partIndex` 定位分段；后端将分段投影为 LLM 可读文本，而不是向模型发送原始分段 JSON。前端渲染只读消息分段，并通过 React ProseMirror 编辑器编辑草稿分段。

**技术栈：** Node.js、Fastify、TypeScript、sql.js、React、MUI、ProseMirror、Vitest、Testing Library。

---

## 文件结构

- 新建 `apps/api/src/agent/message-parts.ts`
  - 定义 `MessagePart`、`TextPart`、`MediaPart`、`PartExtra`。
  - 提供 `stripRuntimePartFields`、`createTextPart`、`partsToLlmText`、`appendTextDelta`、`upsertGeneratedImageParts` 以及旧格式转换辅助函数。

- 修改 `apps/api/src/agent/types.ts`
  - 新增感知分段的流式事件：`message.part.created`、`message.part.delta`、`message.part.updated`。
  - 为 `AgentExecutionInput` 新增 `parts?: MessagePart[]`。

- 修改 `apps/api/src/agent/agent-store.ts`
  - 将主要消息载荷字段替换为 `parts: MessagePart[]`。
  - 不在消息记录上公开 `content`；旧的 SQLite `content` 列仅作为迁移来源和内部旧格式镜像保留。
  - 暂时保留 `AgentAssetRecord` 类型用于读取旧数据行，但新写入不再使用资源。

- 修改 `apps/api/src/agent/sqlite-agent-store.ts`
  - 为 `agent_messages` 新增 `parts_json TEXT NOT NULL DEFAULT '[]'`。
  - 当 `parts_json` 为空时，通过将 `content` 转换为文本分段来读取旧数据行。
  - 新增 `updateMessageParts(messageId, parts)`。

- 修改 `apps/api/src/agent/agent-message-coordinator.ts`
  - 根据提交的分段创建用户消息。
  - 使用一个空文本分段初始化助手消息。
  - 将回答增量和图像工具事件转换为 `message.part.*` 事件及持久化分段。
  - 停止向 `agent_assets` 写入新生成的图像。

- 修改 `apps/api/src/agent/context-builder.ts`
  - 通过 `partsToLlmText` 从 `message.parts` 构建上下文。

- 修改 `apps/api/src/routes/agent-routes.ts`
  - 接受 `{ parts }` 作为主要请求体。
  - 通过将 `{ input }` 转换为 `[{ type: "text", value: input }]` 保持兼容性。

- 修改 `apps/web/src/api/agent-client.ts`
  - 在前端公开相同的 `MessagePart` 协议。
  - 修改 `startAgentMessage` 以发送分段。
  - 在 App 集成完成前，仅在调用点内部保留 `input` 辅助兼容逻辑。

- 新建 `apps/web/src/components/MessagePartRenderer.tsx`
  - 将助手文本按 Markdown 格式渲染。
  - 将用户文本按纯文本渲染。
  - 根据 `extra.lifecycle` 渲染媒体的等待中、成功和失败状态。

- 新建 `apps/web/src/prosemirror/part-schema.ts`
  - 为段落文本、硬换行、媒体原子节点和选择型原子节点定义最小 ProseMirror 模式。

- 新建 `apps/web/src/prosemirror/part-serialization.ts`
  - 在 `RuntimePart[]` 与 ProseMirror 文档之间转换。
  - 提交前移除 `$` 运行时字段。

- 新建 `apps/web/src/components/PartComposer.tsx`
  - React ProseMirror 编辑器。
  - 支持文本编辑、按 Enter 提交、按 Shift+Enter 换行以及运行时分段状态。

- 修改 `apps/web/src/App.tsx`
  - 使用 `composerParts: RuntimePart[]` 替换 `input: string` 状态。
  - 向 API 发送 `MessagePart[]`。
  - 将 `message.part.*` 事件应用到当前助手消息的分段。

- 修改 `apps/web/src/components/AgentConversation.tsx`
  - 移除作为主要界面的 `content/assets` 渲染路径。
  - 使用 `MessagePartRenderer`。
  - 工具时间线面板仅用于可观测性。

- 修改 `apps/web/package.json`
  - 新增 ProseMirror 依赖。

---

### 任务 1：定义后端消息分段协议

**文件：**
- 新建：`apps/api/src/agent/message-parts.ts`
- 测试：`apps/api/test/agent/message-parts.test.ts`

- [ ] **步骤 1：编写失败的协议测试**

新建 `apps/api/test/agent/message-parts.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  appendTextDelta,
  createTextPart,
  legacyContentToParts,
  partsToLlmText,
  stripRuntimePartFields,
  upsertGeneratedImageParts,
  type MessagePart
} from "../../src/agent/message-parts.js";

describe("message parts", () => {
  it("strips runtime fields that start with $", () => {
    const parts = stripRuntimePartFields([
      { type: "text", value: "hello", $id: "runtime_1", $uploadStatus: "success" } as MessagePart & Record<string, unknown>
    ]);

    expect(parts).toEqual([{ type: "text", value: "hello" }]);
  });

  it("converts legacy content into one text part", () => {
    expect(legacyContentToParts("你好")).toEqual([{ type: "text", value: "你好" }]);
    expect(legacyContentToParts("")).toEqual([]);
  });

  it("projects select values to labels for LLM context", () => {
    const parts: MessagePart[] = [
      { type: "text", value: "帮我生成" },
      {
        type: "text",
        value: "warm_pastoral",
        extra: {
          placeholder: {
            type: "select",
            label: "风格",
            options: [{ label: "温馨田园风", value: "warm_pastoral" }]
          }
        }
      },
      { type: "text", value: "小猪图片" }
    ];

    expect(partsToLlmText(parts)).toBe("帮我生成\n风格：温馨田园风\n小猪图片");
  });

  it("does not project pending media into LLM context", () => {
    const parts: MessagePart[] = [
      { type: "text", value: "正在生成图片" },
      {
        type: "media",
        mime: "image/png",
        url: "",
        extra: { lifecycle: { state: "pending" } }
      }
    ];

    expect(partsToLlmText(parts)).toBe("正在生成图片");
  });

  it("appends text delta to the addressed text part", () => {
    expect(appendTextDelta([createTextPart("")], 0, "你好")).toEqual([{ type: "text", value: "你好" }]);
  });

  it("creates and updates generated image parts by tool call id and output index", () => {
    const pending = upsertGeneratedImageParts([], {
      state: "pending",
      toolName: "generate_image",
      toolCallId: "call_1",
      outputIndex: 0,
      mime: "image/png"
    });

    expect(pending).toEqual([
      {
        type: "media",
        mime: "image/png",
        url: "",
        extra: {
          placeholder: { type: "image", label: "图片生成中" },
          lifecycle: { state: "pending" },
          tool: { name: "generate_image", toolCallId: "call_1", outputIndex: 0 }
        }
      }
    ]);

    const completed = upsertGeneratedImageParts(pending, {
      state: "succeeded",
      toolName: "generate_image",
      toolCallId: "call_1",
      outputIndex: 0,
      mime: "image/png",
      url: "https://example.com/pig.png",
      width: 1024,
      height: 1024,
      generation: { prompt: "小猪", provider: "volcengine", model: "seedream" }
    });

    expect(completed[0]).toMatchObject({
      type: "media",
      mime: "image/png",
      url: "https://example.com/pig.png",
      width: 1024,
      height: 1024,
      extra: {
        lifecycle: { state: "succeeded" },
        tool: { name: "generate_image", toolCallId: "call_1", outputIndex: 0 },
        generation: { prompt: "小猪", provider: "volcengine", model: "seedream" }
      }
    });
  });
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/agent/message-parts.test.ts
```

预期：测试失败，因为 `apps/api/src/agent/message-parts.ts` 不存在。

- [ ] **步骤 3：实现消息分段辅助函数**

新建 `apps/api/src/agent/message-parts.ts`：

```ts
import type { JsonObject } from "../tools/types.js";

export type PlaceholderType = "text" | "input" | "select" | "image" | "skill";
export type LifecycleState = "pending" | "succeeded" | "failed";

export interface PlaceholderOption {
  label: string;
  value: string;
  icon?: string;
}

export interface PartExtra {
  placeholder?: {
    type: PlaceholderType;
    label: string;
    defaultValue?: string;
    options?: PlaceholderOption[];
    removable?: boolean;
    emphasize?: boolean;
    code?: string;
    icon?: string;
    guide?: {
      description?: string;
      image?: string;
      video?: string;
    };
  };
  lifecycle?: {
    state: LifecycleState;
    error?: {
      code: string;
      message: string;
    };
  };
  tool?: {
    name: string;
    toolCallId: string;
    outputIndex?: number;
  };
  generation?: {
    prompt?: string;
    provider?: string;
    model?: string;
  };
  [key: string]: unknown;
}

interface PartBase {
  type: "text" | "media";
  extra?: PartExtra;
}

export interface TextPart extends PartBase {
  type: "text";
  value: string;
}

export interface MediaPart extends PartBase {
  type: "media";
  mime: string;
  url: string;
  name?: string;
  width?: number;
  height?: number;
}

export type MessagePart = TextPart | MediaPart;

export function createTextPart(value: string): TextPart {
  return { type: "text", value };
}

export function stripRuntimePartFields(parts: Array<MessagePart & Record<string, unknown>>): MessagePart[] {
  return parts.map((part) => {
    const cleanEntries = Object.entries(part).filter(([key]) => !key.startsWith("$"));
    return Object.fromEntries(cleanEntries) as MessagePart;
  });
}

export function legacyContentToParts(content: string): MessagePart[] {
  return content ? [createTextPart(content)] : [];
}

export function partsToLlmText(parts: MessagePart[]): string {
  return parts
    .flatMap((part) => {
      if (part.type === "text") {
        return projectTextPart(part);
      }

      return projectMediaPart(part);
    })
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

function projectTextPart(part: TextPart): string {
  const placeholder = part.extra?.placeholder;
  if (placeholder?.type === "select") {
    const selected = placeholder.options?.find((option) => option.value === part.value);
    return `${placeholder.label}：${selected?.label ?? part.value}`;
  }

  if ((placeholder?.type === "input" || placeholder?.type === "text") && !part.value) {
    return placeholder.defaultValue ?? placeholder.label;
  }

  return part.value;
}

function projectMediaPart(part: MediaPart): string {
  const state = part.extra?.lifecycle?.state;
  if (state === "pending") {
    return "";
  }

  if (state === "failed") {
    const message = part.extra?.lifecycle?.error?.message;
    return message ? `资源生成失败：${message}` : "资源生成失败。";
  }

  if (!part.url) {
    return "";
  }

  const label = part.name ?? part.extra?.placeholder?.label ?? "媒体资源";
  return `${label}：${part.url}`;
}

export function appendTextDelta(parts: MessagePart[], partIndex: number, delta: string): MessagePart[] {
  return parts.map((part, index) => {
    if (index !== partIndex || part.type !== "text") {
      return part;
    }

    return { ...part, value: part.value + delta };
  });
}

export interface GeneratedImagePartInput {
  state: LifecycleState;
  toolName: string;
  toolCallId: string;
  outputIndex: number;
  mime: string;
  url?: string;
  name?: string;
  width?: number;
  height?: number;
  error?: { code: string; message: string };
  generation?: PartExtra["generation"];
}

export function upsertGeneratedImageParts(parts: MessagePart[], input: GeneratedImagePartInput): MessagePart[] {
  const existingIndex = parts.findIndex(
    (part) =>
      part.type === "media" &&
      part.extra?.tool?.toolCallId === input.toolCallId &&
      part.extra.tool.outputIndex === input.outputIndex
  );
  const mediaPart: MediaPart = {
    type: "media",
    mime: input.mime,
    url: input.url ?? "",
    ...(input.name ? { name: input.name } : {}),
    ...(input.width ? { width: input.width } : {}),
    ...(input.height ? { height: input.height } : {}),
    extra: {
      placeholder: input.state === "pending" ? { type: "image", label: "图片生成中" } : undefined,
      lifecycle: {
        state: input.state,
        ...(input.error ? { error: input.error } : {})
      },
      tool: {
        name: input.toolName,
        toolCallId: input.toolCallId,
        outputIndex: input.outputIndex
      },
      ...(input.generation ? { generation: input.generation } : {})
    }
  };
  const compactPart = removeUndefinedDeep(mediaPart) as MediaPart;

  if (existingIndex === -1) {
    return [...parts, compactPart];
  }

  return parts.map((part, index) => (index === existingIndex ? compactPart : part));
}

function removeUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedDeep);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, removeUndefinedDeep(entryValue)])
    ) as JsonObject;
  }

  return value;
}
```

- [ ] **步骤 4：运行测试**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/agent/message-parts.test.ts
```

预期：测试通过。

- [ ] **步骤 5：提交**

```bash
git add apps/api/src/agent/message-parts.ts apps/api/test/agent/message-parts.test.ts
git commit -m "feat(api): define message parts protocol"
```

---

### 任务 2：在 SQLite 中持久化消息分段

**文件：**
- 修改：`apps/api/src/agent/agent-store.ts`
- 修改：`apps/api/src/agent/sqlite-agent-store.ts`
- 测试：`apps/api/test/agent/sqlite-agent-store.test.ts`

- [ ] **步骤 1：新增失败的存储测试**

向 `apps/api/test/agent/sqlite-agent-store.test.ts` 追加测试：

```ts
import type { MessagePart } from "../../src/agent/message-parts.js";

it("persists message parts across store instances", async () => {
  const databasePath = join(tmpdir(), `agent-parts-${randomUUID()}.sqlite`);
  const store = await SqliteAgentStore.create({ databasePath });
  const parts: MessagePart[] = [{ type: "text", value: "你好" }];

  const message = store.createMessage({
    sessionId: store.createSession("parts").id,
    role: "user",
    status: "completed",
    parts
  });

  store.close();

  const reopened = await SqliteAgentStore.create({ databasePath });
  expect(reopened.getMessage(message.id)?.parts).toEqual(parts);
  reopened.close();
});

it("updates message parts without changing status", async () => {
  const databasePath = join(tmpdir(), `agent-parts-update-${randomUUID()}.sqlite`);
  const store = await SqliteAgentStore.create({ databasePath });
  const session = store.createSession("parts");
  const message = store.createMessage({
    sessionId: session.id,
    role: "assistant",
    status: "running",
    parts: [{ type: "text", value: "" }]
  });

  const updated = store.updateMessageParts(message.id, [{ type: "text", value: "流式文本" }]);

  expect(updated?.status).toBe("running");
  expect(updated?.parts).toEqual([{ type: "text", value: "流式文本" }]);
  store.close();
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/agent/sqlite-agent-store.test.ts
```

预期：测试失败，因为 `parts` 和 `updateMessageParts` 不存在。

- [ ] **步骤 3：更新存储接口**

修改 `apps/api/src/agent/agent-store.ts`：

```ts
import type { MessagePart } from "./message-parts.js";

export interface AgentMessageRecord {
  id: string;
  sessionId: string;
  role: AgentMessageRole;
  status: AgentMessageStatus;
  parts: MessagePart[];
  maxIterations?: number;
  steps?: AgentExecutionResult["steps"];
  error?: {
    code: string;
    message: string;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CreateAgentMessageInput {
  sessionId: string;
  role: AgentMessageRole;
  status: AgentMessageStatus;
  parts: MessagePart[];
  maxIterations?: number;
  error?: {
    code: string;
    message: string;
  };
}

export interface UpdateAgentMessageInput {
  status?: AgentMessageStatus;
  parts?: MessagePart[];
  steps?: AgentExecutionResult["steps"];
  error?: {
    code: string;
    message: string;
  };
  completedAt?: string;
}

export interface AgentStore {
  createSession(title?: string): AgentSessionRecord;
  listSessions(): AgentSessionRecord[];
  getSession(sessionId: string): AgentSessionRecord | undefined;
  createMessage(input: CreateAgentMessageInput): AgentMessageRecord;
  updateMessage(messageId: string, input: UpdateAgentMessageInput): AgentMessageRecord | undefined;
  updateMessageParts(messageId: string, parts: MessagePart[]): AgentMessageRecord | undefined;
  getMessage(messageId: string): AgentMessageRecord | undefined;
  getMessagesBySession(sessionId: string): AgentMessageRecord[];
  createAsset(input: CreateAgentAssetInput): AgentAssetRecord;
  getAssetsBySession(sessionId: string): AgentAssetRecord[];
  appendEvent(messageId: string, event: AgentStreamEvent): StoredAgentEvent | undefined;
  getEvents(messageId: string, after?: number): StoredAgentEvent[];
  subscribe(messageId: string, listener: AgentEventListener): () => void;
}
```

- [ ] **步骤 4：新增 `parts_json` 存储**

修改 `apps/api/src/agent/sqlite-agent-store.ts`：

```ts
import { legacyContentToParts, type MessagePart } from "./message-parts.js";
```

在 `createMessage` 中，为记录构建 `parts`，并仅为旧 SQLite 列构建 `contentMirror`：

```ts
const parts = input.parts;
const contentMirror = partsToLegacyContent(parts);
const message: AgentMessageRecord = {
  id: createId("msg"),
  sessionId: input.sessionId,
  role: input.role,
  status: input.status,
  parts,
  maxIterations: input.maxIterations,
  error: input.error,
  createdAt: timestamp,
  updatedAt: timestamp
};
```

插入 `parts_json`：

```sql
INSERT INTO agent_messages (
  id,
  session_id,
  role,
  status,
  content,
  parts_json,
  max_iterations,
  steps_json,
  error_json,
  created_at,
  updated_at,
  completed_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

更新 `updateMessage` 以保留分段：

```ts
const parts = input.parts ?? existingMessage.parts;
const contentMirror = partsToLegacyContent(parts);
```

新增 `updateMessageParts`：

```ts
updateMessageParts(messageId: string, parts: MessagePart[]): AgentMessageRecord | undefined {
  return this.updateMessage(messageId, { parts });
}
```

向模式中新增列：

```sql
parts_json TEXT NOT NULL DEFAULT '[]',
```

在 `initializeSchema()` 创建表之后新增迁移：

```ts
private ensureMessagePartsColumn() {
  const columns = this.database.exec(`PRAGMA table_info(agent_messages)`)[0]?.values ?? [];
  const hasPartsJson = columns.some((row) => row[1] === "parts_json");
  if (!hasPartsJson) {
    this.database.run(`ALTER TABLE agent_messages ADD COLUMN parts_json TEXT NOT NULL DEFAULT '[]'`);
  }
}
```

在 `initializeSchema()` 末尾调用 `this.ensureMessagePartsColumn()`。

更新 `toMessageRecord`：

```ts
const legacyContent = requiredString(row.content, "content");
const parsedParts = parseJson<MessagePart[]>(row.parts_json);
const parts = parsedParts && parsedParts.length > 0 ? parsedParts : legacyContentToParts(legacyContent);

return {
  id: requiredString(row.id, "id"),
  sessionId: requiredString(row.session_id, "session_id"),
  role: requiredString(row.role, "role") as AgentMessageRole,
  status: requiredString(row.status, "status") as AgentMessageStatus,
  parts,
  maxIterations: optionalNumber(row.max_iterations),
  steps: parseJson<AgentMessageRecord["steps"]>(row.steps_json),
  error: parseJson<AgentMessageRecord["error"]>(row.error_json),
  createdAt: requiredString(row.created_at, "created_at"),
  updatedAt: requiredString(row.updated_at, "updated_at"),
  completedAt: optionalString(row.completed_at)
};
```

新增辅助函数：

```ts
function partsToLegacyContent(parts: MessagePart[]): string {
  return parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.value)
    .join("");
}
```

- [ ] **步骤 5：运行存储测试**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/agent/sqlite-agent-store.test.ts
```

预期：测试通过。

- [ ] **步骤 6：提交**

```bash
git add apps/api/src/agent/agent-store.ts apps/api/src/agent/sqlite-agent-store.ts apps/api/test/agent/sqlite-agent-store.test.ts
git commit -m "feat(api): persist message parts"
```

---

### 任务 3：新增分段流式事件和协调器更新

**文件：**
- 修改：`apps/api/src/agent/types.ts`
- 修改：`apps/api/src/agent/agent-message-coordinator.ts`
- 测试：`apps/api/test/agent/agent-message-coordinator.test.ts`
- 测试：`apps/api/test/routes/agent-routes.test.ts`

- [ ] **步骤 1：新增失败的协调器测试**

向 `apps/api/test/agent/agent-message-coordinator.test.ts` 新增测试：

```ts
it("streams assistant text into the first text part", async () => {
  const { coordinator, store, provider } = createCoordinatorFixture();
  provider.queueStream(["你好", "，世界"]);

  const { assistantMessage } = coordinator.startMessage({
    input: "打招呼",
    parts: [{ type: "text", value: "打招呼" }],
    maxIterations: 4
  });

  await waitForMessageStatus(store, assistantMessage.id, "completed");

  expect(store.getMessage(assistantMessage.id)?.parts).toEqual([{ type: "text", value: "你好，世界" }]);
  expect(store.getEvents(assistantMessage.id).map((item) => item.event.type)).toContain("message.part.delta");
});

it("stores generated images as assistant media parts", async () => {
  const { coordinator, store, provider } = createCoordinatorFixture();
  provider.queueToolCall("generate_image", { prompt: "小猪" });
  provider.queueStream(["图片已生成。"]);

  const { assistantMessage } = coordinator.startMessage({
    input: "生成小猪图片",
    parts: [{ type: "text", value: "生成小猪图片" }],
    maxIterations: 4
  });

  await waitForMessageStatus(store, assistantMessage.id, "completed");

  expect(store.getMessage(assistantMessage.id)?.parts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "text", value: "图片已生成。" }),
      expect.objectContaining({
        type: "media",
        mime: "image/png",
        url: expect.stringContaining("http")
      })
    ])
  );
});
```

- [ ] **步骤 2：运行协调器测试并确认失败**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/agent/agent-message-coordinator.test.ts
```

预期：测试失败，因为协调器仍在写入 `content` 和 `assets`。

- [ ] **步骤 3：扩展流式事件联合类型**

修改 `apps/api/src/agent/types.ts`：

```ts
import type { MessagePart } from "./message-parts.js";

export type AgentStreamEvent =
  | { type: "iteration_start"; iteration: number }
  | { type: "iteration_end"; iteration: number; outcome: "tool_calls" | "final_answer" }
  | { type: "agent_state"; iteration: number; state: AgentState; label: string }
  | { type: "llm_start"; iteration: number }
  | { type: "answer_delta"; iteration: number; delta: string }
  | { type: "answer_chunk"; iteration: number; text: string }
  | { type: "message.part.created"; messageId: string; partIndex: number; part: MessagePart }
  | { type: "message.part.delta"; messageId: string; partIndex: number; delta: string }
  | { type: "message.part.updated"; messageId: string; partIndex: number; patch: Partial<MessagePart> }
  | { type: "llm_response"; iteration: number; content?: string; toolCalls?: ToolCall[] }
  | { type: "tool_call_ready"; iteration: number; toolCallId: string; toolName: string; arguments: JsonObject }
  | { type: "tool_start"; iteration: number; toolCallId?: string; toolName: string; arguments: JsonObject }
  | { type: "tool_progress"; iteration: number; toolCallId?: string; toolName: string; progress: JsonObject }
  | { type: "tool_result"; iteration: number; toolCallId?: string; toolName: string; result: unknown; durationMs?: number }
  | { type: "tool_error"; iteration: number; toolCallId?: string; toolName: string; durationMs?: number; error: AgentErrorDetail }
  | { type: "cancelled"; reason?: string }
  | { type: "final_answer"; answer: string; steps: AgentStep[] }
  | { type: "error"; code: string; message: string };
```

更新 `AgentExecutionInput`：

```ts
parts?: MessagePart[];
```

- [ ] **步骤 4：更新协调器的消息创建逻辑**

修改 `apps/api/src/agent/agent-message-coordinator.ts`：

```ts
import {
  appendTextDelta,
  createTextPart,
  upsertGeneratedImageParts,
  type MessagePart
} from "./message-parts.js";
```

在 `startMessage` 中：

```ts
const userParts = input.parts?.length ? input.parts : [createTextPart(input.input)];
const history = this.buildConversationHistory(session.id);
const userMessage = this.store.createMessage({
  sessionId: session.id,
  role: "user",
  status: "completed",
  parts: userParts
});
const assistantMessage = this.store.createMessage({
  sessionId: session.id,
  role: "assistant",
  status: "running",
  parts: [createTextPart("")],
  maxIterations: input.maxIterations
});
```

- [ ] **步骤 5：更新协调器的事件持久化逻辑**

为 `AgentMessageCoordinator` 新增辅助方法：

```ts
private appendEventAndUpdateParts(messageId: string, event: AgentStreamEvent) {
  this.store.appendEvent(messageId, event);

  if (event.type === "answer_delta") {
    const message = this.store.getMessage(messageId);
    if (!message) return;
    const parts = appendTextDelta(message.parts, 0, event.delta);
    this.store.updateMessageParts(messageId, parts);
    this.store.appendEvent(messageId, {
      type: "message.part.delta",
      messageId,
      partIndex: 0,
      delta: event.delta
    });
  }

  if (event.type === "tool_start" && event.toolName === "generate_image" && event.toolCallId) {
    this.upsertImagePart(messageId, {
      state: "pending",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      outputIndex: 0,
      mime: "image/png"
    });
  }

  if (event.type === "tool_result" && event.toolName === "generate_image" && event.toolCallId) {
    this.completeImagePartsFromToolResult(messageId, event);
  }

  if (event.type === "tool_error" && event.toolName === "generate_image" && event.toolCallId) {
    this.upsertImagePart(messageId, {
      state: "failed",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      outputIndex: 0,
      mime: "image/png",
      error: {
        code: event.error.code,
        message: event.error.message
      }
    });
  }
}
```

将 `executeMessage` 中的 `this.store.appendEvent(messageId, event)` 替换为：

```ts
this.appendEventAndUpdateParts(messageId, event);
```

新增 `upsertImagePart`：

```ts
private upsertImagePart(messageId: string, input: Parameters<typeof upsertGeneratedImageParts>[1]) {
  const message = this.store.getMessage(messageId);
  if (!message) return;
  const beforeLength = message.parts.length;
  const parts = upsertGeneratedImageParts(message.parts, input);
  const updated = this.store.updateMessageParts(messageId, parts);
  const partIndex = parts.findIndex(
    (part) =>
      part.type === "media" &&
      part.extra?.tool?.toolCallId === input.toolCallId &&
      part.extra.tool.outputIndex === input.outputIndex
  );

  if (!updated || partIndex === -1) return;

  this.store.appendEvent(messageId, {
    type: partIndex >= beforeLength ? "message.part.created" : "message.part.updated",
    messageId,
    partIndex,
    ...(partIndex >= beforeLength ? { part: parts[partIndex] } : { patch: parts[partIndex] })
  } as AgentStreamEvent);
}
```

新增 `completeImagePartsFromToolResult`：调整现有 `extractImageAssets` 逻辑，使其针对每个生成的 URL 调用 `upsertImagePart`。

- [ ] **步骤 6：移除新的资源写入**

从成功完成流程中移除对 `persistGeneratedAssets` 的调用。在任务 8 删除旧兼容路径前，保留 `persistGeneratedAssets`、`extractImageAssets` 和 `agent_assets`。

- [ ] **步骤 7：运行测试**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/agent/agent-message-coordinator.test.ts apps/api/test/routes/agent-routes.test.ts
```

预期：测试通过。

- [ ] **步骤 8：提交**

```bash
git add apps/api/src/agent/types.ts apps/api/src/agent/agent-message-coordinator.ts apps/api/test/agent/agent-message-coordinator.test.ts apps/api/test/routes/agent-routes.test.ts
git commit -m "feat(api): stream and persist message parts"
```

---

### 任务 4：将分段投影到 LLM 上下文

**文件：**
- 修改：`apps/api/src/agent/context-builder.ts`
- 修改：`apps/api/src/agent/agent-service.ts`
- 测试：`apps/api/test/agent/context-builder.test.ts`
- 测试：`apps/api/test/agent/agent-service.test.ts`

- [ ] **步骤 1：新增失败的上下文测试**

向 `apps/api/test/agent/context-builder.test.ts` 新增测试：

```ts
it("uses message parts for user and assistant context", () => {
  const builder = new AgentContextBuilder();

  expect(
    builder.buildConversationHistory([
      {
        id: "user_1",
        sessionId: "session_1",
        role: "user",
        status: "completed",
        parts: [{ type: "text", value: "你好" }],
        createdAt: "2026-06-26T00:00:00.000Z",
        updatedAt: "2026-06-26T00:00:00.000Z"
      },
      {
        id: "assistant_1",
        sessionId: "session_1",
        role: "assistant",
        status: "completed",
        parts: [{ type: "text", value: "你好，我在。" }],
        createdAt: "2026-06-26T00:00:01.000Z",
        updatedAt: "2026-06-26T00:00:01.000Z"
      }
    ])
  ).toEqual([
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好，我在。" }
  ]);
});
```

- [ ] **步骤 2：运行上下文测试并确认失败**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/agent/context-builder.test.ts
```

预期：测试失败，因为上下文仍在读取 `message.content`。

- [ ] **步骤 3：实现上下文投影**

修改 `apps/api/src/agent/context-builder.ts`：

```ts
import { partsToLlmText } from "./message-parts.js";
```

更新 `countMessageCharacters`：

```ts
function countMessageCharacters(message: AgentMessageRecord): number {
  const contextMessage = toContextMessage(message);
  return contextMessage?.content?.length ?? 0;
}
```

更新 `toContextMessage`：

```ts
function toContextMessage(message: AgentMessageRecord): AgentMessage | undefined {
  const projectedContent = partsToLlmText(message.parts);

  if (message.role === "user" && projectedContent) {
    return { role: "user", content: projectedContent };
  }

  if (message.role !== "assistant") {
    return undefined;
  }

  if (message.status === "completed" && projectedContent) {
    return { role: "assistant", content: projectedContent };
  }

  if (message.status === "failed") {
    return { role: "assistant", content: buildFailureSummary(message) };
  }

  if (message.status === "cancelled") {
    return { role: "assistant", content: "上一轮回答被用户中断。" };
  }

  return undefined;
}
```

- [ ] **步骤 4：将投影后的当前用户输入传入 AgentService**

在 `agent-message-coordinator.ts` 中，将当前输入作为投影文本传入：

```ts
const userInputText = partsToLlmText(userParts);
void this.executeMessage(assistantMessage.id, {
  ...input,
  input: userInputText,
  parts: userParts,
  sessionId: session.id,
  messageId: assistantMessage.id,
  history,
  signal: controller.signal
});
```

- [ ] **步骤 5：运行 API 测试**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/agent/context-builder.test.ts apps/api/test/agent/agent-service.test.ts
```

预期：测试通过。

- [ ] **步骤 6：提交**

```bash
git add apps/api/src/agent/context-builder.ts apps/api/src/agent/agent-message-coordinator.ts apps/api/test/agent/context-builder.test.ts apps/api/test/agent/agent-service.test.ts
git commit -m "feat(api): project message parts into llm context"
```

---

### 任务 5：在 Agent 路由和客户端类型中接受分段

**文件：**
- 修改：`apps/api/src/routes/agent-routes.ts`
- 修改：`apps/web/src/api/agent-client.ts`
- 测试：`apps/api/test/routes/agent-routes.test.ts`
- 测试：`apps/web/src/main.test.tsx`

- [ ] **步骤 1：为分段输入新增失败的路由测试**

向 `apps/api/test/routes/agent-routes.test.ts` 新增测试：

```ts
it("accepts parts as the primary message input", async () => {
  const app = await buildTestApp();

  const response = await app.inject({
    method: "POST",
    url: "/agents/messages",
    payload: {
      parts: [{ type: "text", value: "你好" }],
      maxIterations: 4
    }
  });

  expect(response.statusCode).toBe(201);
  const body = response.json();
  expect(body.userMessage.parts).toEqual([{ type: "text", value: "你好" }]);
});
```

- [ ] **步骤 2：运行路由测试并确认失败**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/routes/agent-routes.test.ts
```

预期：测试失败，因为路由模式要求提供 `input`。

- [ ] **步骤 3：更新路由模式**

修改 `apps/api/src/routes/agent-routes.ts`：

```ts
const textPartSchema = z.object({
  type: z.literal("text"),
  value: z.string(),
  extra: z.record(z.unknown()).optional()
});

const mediaPartSchema = z.object({
  type: z.literal("media"),
  mime: z.string(),
  url: z.string(),
  name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  extra: z.record(z.unknown()).optional()
});

const messagePartSchema = z.union([textPartSchema, mediaPartSchema]);

const startMessageBodySchema = z.object({
  input: z.string().optional(),
  parts: z.array(messagePartSchema).optional(),
  maxIterations: z.number().int().positive().optional(),
  sessionId: z.string().optional()
}).refine((body) => Boolean(body.input?.trim() || body.parts?.length), {
  message: "请输入消息内容"
});
```

路由处理程序：

```ts
const parts = parsed.data.parts ?? [{ type: "text" as const, value: parsed.data.input ?? "" }];
const input = parsed.data.input ?? partsToLlmText(parts);
const response = coordinator.startMessage({
  input,
  parts,
  maxIterations: parsed.data.maxIterations,
  sessionId: parsed.data.sessionId
});
```

- [ ] **步骤 4：更新前端客户端类型**

修改 `apps/web/src/api/agent-client.ts`：

```ts
export type MessagePart = TextPart | MediaPart;

export interface TextPart {
  type: "text";
  value: string;
  extra?: PartExtra;
}

export interface MediaPart {
  type: "media";
  mime: string;
  url: string;
  name?: string;
  width?: number;
  height?: number;
  extra?: PartExtra;
}

export interface PartExtra {
  placeholder?: {
    type: "text" | "input" | "select" | "image" | "skill";
    label: string;
    defaultValue?: string;
    options?: Array<{ label: string; value: string; icon?: string }>;
    removable?: boolean;
    emphasize?: boolean;
    code?: string;
    icon?: string;
    guide?: {
      description?: string;
      image?: string;
      video?: string;
    };
  };
  lifecycle?: {
    state: "pending" | "succeeded" | "failed";
    error?: {
      code: string;
      message: string;
    };
  };
  tool?: {
    name: string;
    toolCallId: string;
    outputIndex?: number;
  };
  generation?: {
    prompt?: string;
    provider?: string;
    model?: string;
  };
  [key: string]: unknown;
}
```

更新 `AgentMessageRecord`：

```ts
parts: MessagePart[];
```

更新 `startAgentMessage`：

```ts
export async function startAgentMessage(
  parts: MessagePart[],
  maxIterations: number,
  sessionId?: string
): Promise<StartAgentMessageResponse> {
  const response = await fetch(`${apiBaseUrl}/agents/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts, maxIterations, sessionId })
  });
  ...
}
```

- [ ] **步骤 5：运行路由和 Web 类型测试**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/routes/agent-routes.test.ts
npm run typecheck -w @agent/web
```

预期：路由测试通过；在任务 7 完成 App 集成前，Web 类型检查可能仍会失败。记录错误并继续执行任务 6。

- [ ] **步骤 6：仅提交 API 路由改动**

```bash
git add apps/api/src/routes/agent-routes.ts apps/api/test/routes/agent-routes.test.ts apps/web/src/api/agent-client.ts
git commit -m "feat(api): accept message parts in agent route"
```

---

### 任务 6：在对话中渲染消息分段

**文件：**
- 新建：`apps/web/src/components/MessagePartRenderer.tsx`
- 修改：`apps/web/src/components/AgentConversation.tsx`
- 测试：`apps/web/src/components/AgentConversation.test.tsx`

- [ ] **步骤 1：新增失败的渲染器测试**

在 `apps/web/src/components/AgentConversation.test.tsx` 中新增测试：

```tsx
it("renders assistant text parts as markdown", () => {
  render(
    <AgentConversation
      messages={[
        {
          id: "msg_1",
          role: "assistant",
          parts: [{ type: "text", value: "**重点**" }],
          status: "completed"
        }
      ]}
      isActive={false}
    />
  );

  expect(screen.getByText("重点").tagName.toLowerCase()).toBe("strong");
});

it("renders media parts in the main message body", () => {
  render(
    <AgentConversation
      messages={[
        {
          id: "msg_1",
          role: "assistant",
          parts: [
            { type: "text", value: "图片已生成。" },
            {
              type: "media",
              mime: "image/png",
              url: "https://example.com/pig.png",
              width: 1024,
              height: 1024
            }
          ],
          status: "completed"
        }
      ]}
      isActive={false}
    />
  );

  expect(screen.getByText("图片已生成。")).toBeInTheDocument();
  expect(screen.getByRole("img")).toHaveAttribute("src", "https://example.com/pig.png");
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：

```bash
npm run test -w @agent/web -- apps/web/src/components/AgentConversation.test.tsx
```

预期：测试失败，因为 `ChatMessage` 仍在使用 `content/assets`。

- [ ] **步骤 3：新建 `MessagePartRenderer`**

新建 `apps/web/src/components/MessagePartRenderer.tsx`：

```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MessagePart } from "../api/agent-client";

interface MessagePartRendererProps {
  role: "user" | "assistant";
  parts: MessagePart[];
  showCursor?: boolean;
}

export function MessagePartRenderer({ role, parts, showCursor = false }: MessagePartRendererProps) {
  return (
    <div className="message-parts">
      {parts.map((part, index) => {
        const key = `${part.type}:${index}`;

        if (part.type === "text") {
          return role === "assistant" ? (
            <div className="markdown-body" key={key}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.value}</ReactMarkdown>
              {showCursor && index === parts.length - 1 ? <span className="typing-cursor" aria-hidden="true" /> : null}
            </div>
          ) : (
            <p className="chat-text" key={key}>
              {part.value}
              {showCursor && index === parts.length - 1 ? <span className="typing-cursor" aria-hidden="true" /> : null}
            </p>
          );
        }

        const state = part.extra?.lifecycle?.state;
        if (state === "pending") {
          return (
            <div className="part-media-loading" key={key}>
              <span>{part.extra?.placeholder?.label ?? "资源处理中"}</span>
            </div>
          );
        }

        if (state === "failed") {
          return (
            <div className="part-media-error" key={key}>
              {part.extra?.lifecycle?.error?.message ?? "资源生成失败"}
            </div>
          );
        }

        if (part.mime.startsWith("image/") && part.url) {
          return (
            <figure className="part-media-image" key={key}>
              <img src={part.url} alt={part.name ?? "生成图片"} />
            </figure>
          );
        }

        return (
          <a className="part-media-file" href={part.url} key={key} rel="noreferrer" target="_blank">
            {part.name ?? part.url}
          </a>
        );
      })}
    </div>
  );
}
```

- [ ] **步骤 4：将渲染器接入对话**

修改 `AgentConversation.tsx` 中的 `ChatMessage`：

```ts
parts: MessagePart[];
```

将 `MessageContent` 的使用替换为：

```tsx
<MessagePartRenderer
  role={message.role}
  parts={message.parts}
  showCursor={isActive && message.role === "assistant" && message.status === "running"}
/>
```

将 `ToolTraceList` 保留在消息正文下方，用于可观测性。

- [ ] **步骤 5：新增 CSS**

修改 `apps/web/src/styles.css`：

```css
.message-parts {
  display: grid;
  gap: 12px;
}

.part-media-image {
  margin: 0;
  max-width: min(520px, 100%);
}

.part-media-image img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 8px;
}

.part-media-loading,
.part-media-error {
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 8px;
  padding: 18px;
  color: #64748b;
  background: rgba(248, 250, 252, 0.8);
}
```

- [ ] **步骤 6：运行渲染器测试**

运行：

```bash
npm run test -w @agent/web -- apps/web/src/components/AgentConversation.test.tsx
```

预期：将旧测试夹具更新为使用 `parts` 后，测试通过。

- [ ] **步骤 7：提交**

```bash
git add apps/web/src/components/MessagePartRenderer.tsx apps/web/src/components/AgentConversation.tsx apps/web/src/components/AgentConversation.test.tsx apps/web/src/styles.css
git commit -m "feat(web): render message parts"
```

---

### 任务 7：在 App 状态和 SSE 中集成分段

**文件：**
- 修改：`apps/web/src/App.tsx`
- 修改：`apps/web/src/main.test.tsx`
- 修改：`apps/web/src/App.test.tsx`

- [ ] **步骤 1：新增失败的 SSE 分段事件测试**

向 `apps/web/src/App.test.tsx` 新增测试：

```tsx
it("applies message part delta events to assistant parts", async () => {
  mockFetchForSessions();
  server.use(
    http.post("http://localhost:4001/agents/messages", () =>
      HttpResponse.json({
        session: { id: "session_1", createdAt: now, updatedAt: now },
        userMessage: {
          id: "msg_user",
          sessionId: "session_1",
          role: "user",
          status: "completed",
          parts: [{ type: "text", value: "你好" }],
          createdAt: now,
          updatedAt: now
        },
        assistantMessage: {
          id: "msg_assistant",
          sessionId: "session_1",
          role: "assistant",
          status: "running",
          parts: [{ type: "text", value: "" }],
          createdAt: now,
          updatedAt: now
        }
      })
    ),
    http.get("http://localhost:4001/agents/messages/msg_assistant/events", () =>
      createStoredSseResponse("msg_assistant", [
        { type: "message.part.delta", messageId: "msg_assistant", partIndex: 0, delta: "你好" },
        { type: "message.part.delta", messageId: "msg_assistant", partIndex: 0, delta: "，世界" }
      ])
    )
  );

  render(<App />);
  await userEvent.type(screen.getByRole("textbox"), "你好");
  await userEvent.keyboard("{Enter}");

  expect(await screen.findByText("你好，世界")).toBeInTheDocument();
});
```

- [ ] **步骤 2：运行 App 测试并确认失败**

运行：

```bash
npm run test -w @agent/web -- apps/web/src/App.test.tsx
```

预期：测试失败，因为 App 仍将 `answer_delta` 追加到 `content`。

- [ ] **步骤 3：将记录转换为包含分段的聊天消息**

修改 `App.tsx` 中的 `createMessageFromRecord`：

```ts
function createMessageFromRecord(message: AgentMessageRecord): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts,
    status: toChatMessageStatus(message.status),
    steps: message.steps,
    error: message.error?.message,
    events: [],
    assets: message.assets ?? []
  };
}
```

- [ ] **步骤 4：应用分段流式事件**

在 `App.tsx` 中新增辅助函数：

```ts
function applyPartEventToMessage(message: ChatMessage, event: AgentStreamEvent): ChatMessage {
  if (event.type === "message.part.created") {
    const parts = [...message.parts];
    parts.splice(event.partIndex, 0, event.part);
    return { ...message, parts };
  }

  if (event.type === "message.part.delta") {
    return {
      ...message,
      parts: message.parts.map((part, index) =>
        index === event.partIndex && part.type === "text"
          ? { ...part, value: part.value + event.delta }
          : part
      )
    };
  }

  if (event.type === "message.part.updated") {
    return {
      ...message,
      parts: message.parts.map((part, index) =>
        index === event.partIndex ? ({ ...part, ...event.patch } as MessagePart) : part
      )
    };
  }

  return message;
}
```

在 `applyStoredEvent` 中，先应用分段事件，再执行旧回答增量的回退逻辑：

```ts
if (event.type.startsWith("message.part.")) {
  return {
    ...applyPartEventToMessage(message, event),
    events: nextEvents
  };
}
```

- [ ] **步骤 5：更新提交流程以发送分段**

在完成任务 8 前，暂时将现有字符串输入转换为分段：

```ts
const submittedParts: MessagePart[] = [{ type: "text", value: submittedInput }];
return await startAgentMessage(submittedParts, maxIterations, sessionId);
```

- [ ] **步骤 6：运行 App 测试**

运行：

```bash
npm run test -w @agent/web -- apps/web/src/App.test.tsx apps/web/src/main.test.tsx
```

预期：更新夹具后测试通过。

- [ ] **步骤 7：提交**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/main.test.tsx
git commit -m "feat(web): apply message part stream events"
```

---

### 任务 8：构建 ProseMirror PartComposer

**文件：**
- 修改：`apps/web/package.json`
- 新建：`apps/web/src/prosemirror/part-schema.ts`
- 新建：`apps/web/src/prosemirror/part-serialization.ts`
- 新建：`apps/web/src/components/PartComposer.tsx`
- 测试：`apps/web/src/prosemirror/part-serialization.test.ts`
- 测试：`apps/web/src/components/PartComposer.test.tsx`

- [ ] **步骤 1：新增 ProseMirror 依赖**

修改 `apps/web/package.json` 中的依赖：

```json
"prosemirror-commands": "^1.7.1",
"prosemirror-history": "^1.4.1",
"prosemirror-keymap": "^1.2.3",
"prosemirror-model": "^1.25.3",
"prosemirror-schema-basic": "^1.2.4",
"prosemirror-state": "^1.4.4",
"prosemirror-view": "^1.40.1"
```

运行：

```bash
npm install
```

预期：锁文件已更新。

- [ ] **步骤 2：新增失败的序列化测试**

新建 `apps/web/src/prosemirror/part-serialization.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { docToParts, partsToDoc, stripRuntimeFields, type RuntimePart } from "./part-serialization";

describe("part prosemirror serialization", () => {
  it("round trips text parts", () => {
    const parts: RuntimePart[] = [{ type: "text", value: "你好", $id: "part_1" }];
    const doc = partsToDoc(parts);

    expect(docToParts(doc)).toEqual([{ type: "text", value: "你好" }]);
  });

  it("strips runtime fields before submit", () => {
    expect(stripRuntimeFields([{ type: "text", value: "你好", $id: "part_1" }])).toEqual([
      { type: "text", value: "你好" }
    ]);
  });
});
```

- [ ] **步骤 3：运行序列化测试并确认失败**

运行：

```bash
npm run test -w @agent/web -- apps/web/src/prosemirror/part-serialization.test.ts
```

预期：测试失败，因为 ProseMirror 文件不存在。

- [ ] **步骤 4：实现最小模式**

新建 `apps/web/src/prosemirror/part-schema.ts`：

```ts
import { Schema } from "prosemirror-model";

export const partSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0]
    },
    text: { group: "inline" },
    hard_break: {
      inline: true,
      group: "inline",
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"]
    },
    media_part: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: {
        mime: { default: "" },
        url: { default: "" },
        name: { default: "" }
      },
      toDOM: (node) => [
        "span",
        {
          class: "pm-part pm-part--media",
          "data-mime": node.attrs.mime,
          "data-url": node.attrs.url,
          "data-name": node.attrs.name
        },
        node.attrs.name || node.attrs.url || "媒体"
      ],
      parseDOM: [
        {
          tag: "span.pm-part--media",
          getAttrs: (dom) => {
            const element = dom as HTMLElement;
            return {
              mime: element.dataset.mime ?? "",
              url: element.dataset.url ?? "",
              name: element.dataset.name ?? ""
            };
          }
        }
      ]
    }
  }
});
```

- [ ] **步骤 5：实现序列化**

新建 `apps/web/src/prosemirror/part-serialization.ts`：

```ts
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { partSchema } from "./part-schema";
import type { MessagePart } from "../api/agent-client";

export type RuntimePart = MessagePart & Record<`$${string}`, unknown>;

export function stripRuntimeFields(parts: RuntimePart[]): MessagePart[] {
  return parts.map((part) => Object.fromEntries(Object.entries(part).filter(([key]) => !key.startsWith("$"))) as MessagePart);
}

export function partsToDoc(parts: RuntimePart[]): ProseMirrorNode {
  const inlineNodes = parts.flatMap((part) => {
    if (part.type === "text") {
      return part.value ? [partSchema.text(part.value)] : [];
    }

    return [
      partSchema.nodes.media_part.create({
        mime: part.mime,
        url: part.url,
        name: part.name ?? ""
      })
    ];
  });

  return partSchema.nodes.doc.create(null, [partSchema.nodes.paragraph.create(null, inlineNodes)]);
}

export function docToParts(doc: ProseMirrorNode): MessagePart[] {
  const parts: MessagePart[] = [];
  let textBuffer = "";

  function flushText() {
    if (textBuffer) {
      parts.push({ type: "text", value: textBuffer });
      textBuffer = "";
    }
  }

  doc.descendants((node) => {
    if (node.isText) {
      textBuffer += node.text ?? "";
      return false;
    }

    if (node.type.name === "hard_break") {
      textBuffer += "\n";
      return false;
    }

    if (node.type.name === "media_part") {
      flushText();
      parts.push({
        type: "media",
        mime: String(node.attrs.mime ?? ""),
        url: String(node.attrs.url ?? ""),
        ...(node.attrs.name ? { name: String(node.attrs.name) } : {})
      });
      return false;
    }

    return true;
  });

  flushText();
  return parts;
}
```

- [ ] **步骤 6：运行序列化测试**

运行：

```bash
npm run test -w @agent/web -- apps/web/src/prosemirror/part-serialization.test.ts
```

预期：测试通过。

- [ ] **步骤 7：实现 PartComposer**

新建 `apps/web/src/components/PartComposer.tsx`：

```tsx
import { useEffect, useRef } from "react";
import { baseKeymap, chainCommands, createParagraphNear, liftEmptyBlock, newlineInCode, splitBlock } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { MessagePart } from "../api/agent-client";
import { docToParts, partsToDoc, type RuntimePart } from "../prosemirror/part-serialization";
import { partSchema } from "../prosemirror/part-schema";

interface PartComposerProps {
  parts: RuntimePart[];
  disabled?: boolean;
  onChange: (parts: RuntimePart[]) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function PartComposer({ parts, disabled = false, onChange, onSubmit, onCancel }: PartComposerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onCancelRef = useRef(onCancel);

  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!rootRef.current || viewRef.current) return;

    const state = EditorState.create({
      schema: partSchema,
      doc: partsToDoc(parts),
      plugins: [
        history(),
        keymap({
          Enter: () => {
            onSubmitRef.current();
            return true;
          },
          "Shift-Enter": chainCommands(newlineInCode, createParagraphNear, liftEmptyBlock, splitBlock),
          "Mod-z": undo,
          "Mod-y": redo,
          "Mod-Shift-z": redo,
          Escape: () => {
            onCancelRef.current();
            return true;
          }
        }),
        keymap(baseKeymap)
      ]
    });

    const view = new EditorView(rootRef.current, {
      state,
      editable: () => !disabled,
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        onChangeRef.current(docToParts(nextState.doc) as RuntimePart[]);
      }
    });

    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (viewRef.current) {
      viewRef.current.setProps({ editable: () => !disabled });
    }
  }, [disabled]);

  return <div className="part-composer" ref={rootRef} role="textbox" aria-label="发送消息" />;
}
```

- [ ] **步骤 8：新增基础编辑器测试**

新建 `apps/web/src/components/PartComposer.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PartComposer } from "./PartComposer";

it("submits on Enter and changes text through ProseMirror", async () => {
  const onChange = vi.fn();
  const onSubmit = vi.fn();

  render(<PartComposer parts={[{ type: "text", value: "" }]} onCancel={vi.fn()} onChange={onChange} onSubmit={onSubmit} />);

  const textbox = screen.getByRole("textbox", { name: "发送消息" });
  await userEvent.click(textbox);
  await userEvent.keyboard("你好");
  await userEvent.keyboard("{Enter}");

  expect(onChange).toHaveBeenCalled();
  expect(onSubmit).toHaveBeenCalled();
});
```

- [ ] **步骤 9：运行编辑器测试**

运行：

```bash
npm run test -w @agent/web -- apps/web/src/prosemirror/part-serialization.test.ts apps/web/src/components/PartComposer.test.tsx
```

预期：测试通过。

- [ ] **步骤 10：提交**

```bash
git add apps/web/package.json package-lock.json apps/web/src/prosemirror apps/web/src/components/PartComposer.tsx apps/web/src/components/PartComposer.test.tsx
git commit -m "feat(web): add prosemirror part composer"
```

---

### 任务 9：使用 PartComposer 替换 AgentComposer 文本区域

**文件：**
- 修改：`apps/web/src/components/AgentComposer.tsx`
- 修改：`apps/web/src/components/AgentComposer.test.tsx`
- 修改：`apps/web/src/App.tsx`
- 修改：`apps/web/src/App.test.tsx`

- [ ] **步骤 1：新增失败的编辑器集成测试**

更新 `apps/web/src/components/AgentComposer.test.tsx`：

```tsx
it("renders a prosemirror composer and submits parts with Enter", async () => {
  const onSubmit = vi.fn();
  const onPartsChange = vi.fn();

  render(
    <AgentComposer
      parts={[{ type: "text", value: "" }]}
      maxIterations={4}
      isStreaming={false}
      onPartsChange={onPartsChange}
      onMaxIterationsChange={vi.fn()}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />
  );

  await userEvent.click(screen.getByRole("textbox", { name: "发送消息" }));
  await userEvent.keyboard("你好{Enter}");

  expect(onPartsChange).toHaveBeenCalled();
  expect(onSubmit).toHaveBeenCalled();
});
```

- [ ] **步骤 2：运行编辑器集成测试并确认失败**

运行：

```bash
npm run test -w @agent/web -- apps/web/src/components/AgentComposer.test.tsx
```

预期：测试失败，因为 `AgentComposer` 仍要求字符串输入。

- [ ] **步骤 3：更新 AgentComposer 属性**

修改 `apps/web/src/components/AgentComposer.tsx`：

```ts
import type { MessagePart } from "../api/agent-client";
import { PartComposer } from "./PartComposer";
import type { RuntimePart } from "../prosemirror/part-serialization";

interface AgentComposerProps {
  parts: RuntimePart[];
  maxIterations: number;
  isStreaming: boolean;
  onPartsChange: (parts: RuntimePart[]) => void;
  onMaxIterationsChange: (value: number) => void;
  onSubmit: () => void;
  onCancel: () => void;
}
```

在当前文本区域的位置渲染 `PartComposer`：

```tsx
<PartComposer
  parts={parts}
  disabled={isStreaming}
  onChange={onPartsChange}
  onSubmit={onSubmit}
  onCancel={onCancel}
/>
```

- [ ] **步骤 4：更新 App 编辑器状态**

修改 `apps/web/src/App.tsx`：

```ts
const [composerParts, setComposerParts] = useState<RuntimePart[]>([{ type: "text", value: "" }]);
```

提交：

```ts
const submittedParts = stripRuntimeFields(composerParts).filter(
  (part) => part.type === "media" || (part.type === "text" && part.value.trim())
);

if (submittedParts.length === 0) {
  return;
}

setComposerParts([{ type: "text", value: "" }]);
return await startAgentMessage(submittedParts, maxIterations, sessionId);
```

建议：

```ts
function handleSuggestionSelect(suggestion: string) {
  setComposerParts([{ type: "text", value: suggestion }]);
}
```

- [ ] **步骤 5：运行 Web 测试**

运行：

```bash
npm run test -w @agent/web -- apps/web/src/components/AgentComposer.test.tsx apps/web/src/App.test.tsx
```

预期：将夹具更新为使用 `parts` 后，测试通过。

- [ ] **步骤 6：提交**

```bash
git add apps/web/src/components/AgentComposer.tsx apps/web/src/components/AgentComposer.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): submit rich message parts"
```

---

### 任务 10：移除新界面对资源的依赖

**文件：**
- 修改：`apps/web/src/components/AgentConversation.tsx`
- 修改：`apps/api/src/agent/agent-message-coordinator.ts`
- 修改：`apps/api/test/agent/agent-message-coordinator.test.ts`
- 修改：`apps/web/src/components/AgentConversation.test.tsx`

- [ ] **步骤 1：新增失败的无资源断言**

向 `apps/api/test/agent/agent-message-coordinator.test.ts` 新增测试：

```ts
it("does not create new asset rows for generated images", async () => {
  const { coordinator, store, provider } = createCoordinatorFixture();
  provider.queueToolCall("generate_image", { prompt: "小猪" });
  provider.queueStream(["完成"]);

  const { session, assistantMessage } = coordinator.startMessage({
    input: "生成小猪",
    parts: [{ type: "text", value: "生成小猪" }],
    maxIterations: 4
  });

  await waitForMessageStatus(store, assistantMessage.id, "completed");

  expect(store.getAssetsBySession(session.id)).toEqual([]);
});
```

- [ ] **步骤 2：移除基于资源的主要渲染逻辑**

在 `AgentConversation.tsx` 中，从主要消息正文移除 `MessageImageAssets`。保留 `ToolTraceList`，仅用于时间线和工具观测。

- [ ] **步骤 3：移除生成资源的持久化调用和无效辅助函数引用**

在 `AgentMessageCoordinator` 中移除：

```ts
this.persistGeneratedAssets(...)
```

在本计划中，为保持向后兼容，请在存储中保留 `createAsset` 和 `agent_assets` 表。不要删除旧表数据。

- [ ] **步骤 4：运行针对性测试**

运行：

```bash
npm run test -w @agent/api -- apps/api/test/agent/agent-message-coordinator.test.ts
npm run test -w @agent/web -- apps/web/src/components/AgentConversation.test.tsx
```

预期：测试通过。

- [ ] **步骤 5：提交**

```bash
git add apps/api/src/agent/agent-message-coordinator.ts apps/api/test/agent/agent-message-coordinator.test.ts apps/web/src/components/AgentConversation.tsx apps/web/src/components/AgentConversation.test.tsx
git commit -m "refactor: render generated media from message parts"
```

---

### 任务 11：最终验证

**文件：**
- 按需修改：仅限测试夹具。

- [ ] **步骤 1：运行 API 测试**

运行：

```bash
npm run test -w @agent/api
```

预期：所有 API 测试均通过。

- [ ] **步骤 2：运行 Web 测试**

运行：

```bash
npm run test -w @agent/web
```

预期：所有 Web 测试均通过。

- [ ] **步骤 3：运行类型检查**

运行：

```bash
npm run typecheck
```

预期：TypeScript 以状态码 0 退出。

- [ ] **步骤 4：运行构建**

运行：

```bash
npm run build
```

预期：API 和 Web 构建完成。

- [ ] **步骤 5：手动冒烟测试**

运行：

```bash
npm run dev
```

打开 `http://127.0.0.1:4000` 并验证：

- 新建对话会显示 ProseMirror 编辑器。
- 输入文本并按 Enter 后会提交消息。
- 按 Shift+Enter 会插入换行。
- 用户消息通过分段渲染。
- 助手的流式文本会原地更新。
- 生成图像时会创建一个内联的加载中媒体分段。
- 图像生成完成后，会将同一媒体分段更新为预览。
- 刷新页面后会恢复消息分段。
- 右侧时间线仍会显示事件。

- [ ] **步骤 6：提交验证夹具修复**

如果验证需要更新测试夹具：

```bash
git add apps/api/test apps/web/src
git commit -m "test: update message parts fixtures"
```

如果没有文件发生变更，则跳过此次提交。

---

## 自查

- 规格覆盖：
  - 仅支持 `text/media`：任务 1、2、6。
  - 不支持 `element`：任务 1 仅定义 `TextPart | MediaPart`。
  - 不包含 `key`、`uuid`、`thumbnailUrl`、`content`、`ui` 或 `format`：任务 1 的类型定义排除了这些字段。
  - 移除运行时 `$` 字段：任务 1 和 8。
  - 使用 `messageId + partIndex` 进行流式更新：任务 3 和 7。
  - 使用 LLM 投影而非原始分段：任务 4。
  - ProseMirror 富文本输入：任务 8 和 9。
  - 通过分段显示用户消息：任务 6 和 9。
  - 将生成的图像作为媒体分段：任务 3 和 10。

- 占位内容扫描：
  - 没有 `TBD`、`TODO` 或未明确说明的测试任务。

- 类型一致性：
  - 后端和前端都使用 `MessagePart = TextPart | MediaPart`。
  - 文本字段始终为 `value`。
  - 媒体字段为 `mime`、`url`，以及可选的 `name`、`width`、`height`。
  - 分段流式事件使用 `message.part.created`、`message.part.delta`、`message.part.updated`。
