# Message Parts Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current `content + assets` message model with a single `parts` protocol aligned with ai-chat-vue's text/media approach, then use a ProseMirror-based composer for rich user input.

**Architecture:** Persist every user and assistant message as `MessagePart[]` in `agent_messages.parts_json`. Stream updates address parts by `messageId + partIndex`; the backend projects parts into LLM-readable text instead of sending raw part JSON to the model. The frontend renders read-only message parts and edits draft parts through a React ProseMirror composer.

**Tech Stack:** Node.js, Fastify, TypeScript, sql.js, React, MUI, ProseMirror, Vitest, Testing Library.

---

## File Structure

- Create `apps/api/src/agent/message-parts.ts`
  - Defines `MessagePart`, `TextPart`, `MediaPart`, `PartExtra`.
  - Provides `stripRuntimePartFields`, `createTextPart`, `partsToLlmText`, `appendTextDelta`, `upsertGeneratedImageParts`, and legacy conversion helpers.

- Modify `apps/api/src/agent/types.ts`
  - Adds part-aware stream events: `message.part.created`, `message.part.delta`, `message.part.updated`.
  - Adds `parts?: MessagePart[]` to `AgentExecutionInput`.

- Modify `apps/api/src/agent/agent-store.ts`
  - Replaces the primary message payload field with `parts: MessagePart[]`.
  - Does not expose `content` on message records; the old SQLite `content` column remains only as a migration source and internal legacy mirror.
  - Keeps `AgentAssetRecord` types temporarily for reading old rows, but new writes stop using assets.

- Modify `apps/api/src/agent/sqlite-agent-store.ts`
  - Adds `parts_json TEXT NOT NULL DEFAULT '[]'` to `agent_messages`.
  - Reads legacy rows by converting `content` into a text part when `parts_json` is empty.
  - Adds `updateMessageParts(messageId, parts)`.

- Modify `apps/api/src/agent/agent-message-coordinator.ts`
  - Creates user messages from submitted parts.
  - Initializes assistant messages with one empty text part.
  - Converts answer deltas and image tool events into `message.part.*` events and persisted parts.
  - Stops writing new generated images to `agent_assets`.

- Modify `apps/api/src/agent/context-builder.ts`
  - Builds context from `message.parts` through `partsToLlmText`.

- Modify `apps/api/src/routes/agent-routes.ts`
  - Accepts `{ parts }` as the primary request body.
  - Keeps `{ input }` compatibility by converting it to `[{ type: "text", value: input }]`.

- Modify `apps/web/src/api/agent-client.ts`
  - Exposes the same `MessagePart` protocol on the frontend.
  - Changes `startAgentMessage` to send parts.
  - Keeps `input` helper compatibility only inside call sites until App integration is complete.

- Create `apps/web/src/components/MessagePartRenderer.tsx`
  - Renders assistant text as Markdown.
  - Renders user text as plain text.
  - Renders media pending/succeeded/failed states from `extra.lifecycle`.

- Create `apps/web/src/prosemirror/part-schema.ts`
  - Defines the minimal ProseMirror schema for paragraph text, hard breaks, media atom nodes, and select atom nodes.

- Create `apps/web/src/prosemirror/part-serialization.ts`
  - Converts `RuntimePart[] <-> ProseMirror doc`.
  - Strips `$` runtime fields before submit.

- Create `apps/web/src/components/PartComposer.tsx`
  - React ProseMirror composer.
  - Supports text editing, Enter submit, Shift+Enter newline, and runtime part state.

- Modify `apps/web/src/App.tsx`
  - Replaces `input: string` state with `composerParts: RuntimePart[]`.
  - Sends `MessagePart[]` to the API.
  - Applies `message.part.*` events to active assistant message parts.

- Modify `apps/web/src/components/AgentConversation.tsx`
  - Removes `content/assets` rendering path as primary UI.
  - Uses `MessagePartRenderer`.
  - Keeps tool timeline panel as observability only.

- Modify `apps/web/package.json`
  - Adds ProseMirror dependencies.

---

### Task 1: Define Backend Message Part Protocol

**Files:**
- Create: `apps/api/src/agent/message-parts.ts`
- Test: `apps/api/test/agent/message-parts.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Create `apps/api/test/agent/message-parts.test.ts`:

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

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/agent/message-parts.test.ts
```

Expected: fail because `apps/api/src/agent/message-parts.ts` does not exist.

- [ ] **Step 3: Implement message part helpers**

Create `apps/api/src/agent/message-parts.ts`:

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

- [ ] **Step 4: Run tests**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/agent/message-parts.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/message-parts.ts apps/api/test/agent/message-parts.test.ts
git commit -m "feat(api): define message parts protocol"
```

---

### Task 2: Persist Message Parts In SQLite

**Files:**
- Modify: `apps/api/src/agent/agent-store.ts`
- Modify: `apps/api/src/agent/sqlite-agent-store.ts`
- Test: `apps/api/test/agent/sqlite-agent-store.test.ts`

- [ ] **Step 1: Add failing store tests**

Append tests to `apps/api/test/agent/sqlite-agent-store.test.ts`:

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

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/agent/sqlite-agent-store.test.ts
```

Expected: fail because `parts` and `updateMessageParts` do not exist.

- [ ] **Step 3: Update store interfaces**

Modify `apps/api/src/agent/agent-store.ts`:

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

- [ ] **Step 4: Add `parts_json` storage**

Modify `apps/api/src/agent/sqlite-agent-store.ts`:

```ts
import { legacyContentToParts, type MessagePart } from "./message-parts.js";
```

In `createMessage`, build `parts` for the record and `contentMirror` only for the legacy SQLite column:

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

Insert `parts_json`:

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

Update `updateMessage` to keep parts:

```ts
const parts = input.parts ?? existingMessage.parts;
const contentMirror = partsToLegacyContent(parts);
```

Add `updateMessageParts`:

```ts
updateMessageParts(messageId: string, parts: MessagePart[]): AgentMessageRecord | undefined {
  return this.updateMessage(messageId, { parts });
}
```

Add column to schema:

```sql
parts_json TEXT NOT NULL DEFAULT '[]',
```

Add migration after `initializeSchema()` creates tables:

```ts
private ensureMessagePartsColumn() {
  const columns = this.database.exec(`PRAGMA table_info(agent_messages)`)[0]?.values ?? [];
  const hasPartsJson = columns.some((row) => row[1] === "parts_json");
  if (!hasPartsJson) {
    this.database.run(`ALTER TABLE agent_messages ADD COLUMN parts_json TEXT NOT NULL DEFAULT '[]'`);
  }
}
```

Call `this.ensureMessagePartsColumn()` at the end of `initializeSchema()`.

Update `toMessageRecord`:

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

Add helper:

```ts
function partsToLegacyContent(parts: MessagePart[]): string {
  return parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.value)
    .join("");
}
```

- [ ] **Step 5: Run store tests**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/agent/sqlite-agent-store.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/agent/agent-store.ts apps/api/src/agent/sqlite-agent-store.ts apps/api/test/agent/sqlite-agent-store.test.ts
git commit -m "feat(api): persist message parts"
```

---

### Task 3: Add Part Stream Events And Coordinator Updates

**Files:**
- Modify: `apps/api/src/agent/types.ts`
- Modify: `apps/api/src/agent/agent-message-coordinator.ts`
- Test: `apps/api/test/agent/agent-message-coordinator.test.ts`
- Test: `apps/api/test/routes/agent-routes.test.ts`

- [ ] **Step 1: Add failing coordinator tests**

Add tests to `apps/api/test/agent/agent-message-coordinator.test.ts`:

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

- [ ] **Step 2: Run coordinator tests to verify failure**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/agent/agent-message-coordinator.test.ts
```

Expected: fail because the coordinator still writes `content` and `assets`.

- [ ] **Step 3: Extend stream event union**

Modify `apps/api/src/agent/types.ts`:

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

Update `AgentExecutionInput`:

```ts
parts?: MessagePart[];
```

- [ ] **Step 4: Update coordinator message creation**

Modify `apps/api/src/agent/agent-message-coordinator.ts`:

```ts
import {
  appendTextDelta,
  createTextPart,
  upsertGeneratedImageParts,
  type MessagePart
} from "./message-parts.js";
```

In `startMessage`:

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

- [ ] **Step 5: Update coordinator event persistence**

Add helper methods to `AgentMessageCoordinator`:

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

Replace `this.store.appendEvent(messageId, event)` in `executeMessage` with:

```ts
this.appendEventAndUpdateParts(messageId, event);
```

Add `upsertImagePart`:

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

Add `completeImagePartsFromToolResult` by adapting existing `extractImageAssets` logic to call `upsertImagePart` for each generated URL.

- [ ] **Step 6: Remove new asset writes**

Remove the call to `persistGeneratedAssets` from successful completion. Leave `persistGeneratedAssets`, `extractImageAssets`, and `agent_assets` in place until old compatibility paths are deleted in Task 8.

- [ ] **Step 7: Run tests**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/agent/agent-message-coordinator.test.ts apps/api/test/routes/agent-routes.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/agent/types.ts apps/api/src/agent/agent-message-coordinator.ts apps/api/test/agent/agent-message-coordinator.test.ts apps/api/test/routes/agent-routes.test.ts
git commit -m "feat(api): stream and persist message parts"
```

---

### Task 4: Project Parts Into LLM Context

**Files:**
- Modify: `apps/api/src/agent/context-builder.ts`
- Modify: `apps/api/src/agent/agent-service.ts`
- Test: `apps/api/test/agent/context-builder.test.ts`
- Test: `apps/api/test/agent/agent-service.test.ts`

- [ ] **Step 1: Add failing context tests**

Add to `apps/api/test/agent/context-builder.test.ts`:

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

- [ ] **Step 2: Run context tests to verify failure**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/agent/context-builder.test.ts
```

Expected: fail because context still reads `message.content`.

- [ ] **Step 3: Implement context projection**

Modify `apps/api/src/agent/context-builder.ts`:

```ts
import { partsToLlmText } from "./message-parts.js";
```

Update `countMessageCharacters`:

```ts
function countMessageCharacters(message: AgentMessageRecord): number {
  const contextMessage = toContextMessage(message);
  return contextMessage?.content?.length ?? 0;
}
```

Update `toContextMessage`:

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

- [ ] **Step 4: Pass projected current user input into AgentService**

In `agent-message-coordinator.ts`, pass current input as projected text:

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

- [ ] **Step 5: Run API tests**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/agent/context-builder.test.ts apps/api/test/agent/agent-service.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/agent/context-builder.ts apps/api/src/agent/agent-message-coordinator.ts apps/api/test/agent/context-builder.test.ts apps/api/test/agent/agent-service.test.ts
git commit -m "feat(api): project message parts into llm context"
```

---

### Task 5: Accept Parts In Agent Routes And Client Types

**Files:**
- Modify: `apps/api/src/routes/agent-routes.ts`
- Modify: `apps/web/src/api/agent-client.ts`
- Test: `apps/api/test/routes/agent-routes.test.ts`
- Test: `apps/web/src/main.test.tsx`

- [ ] **Step 1: Add failing route test for parts input**

Add to `apps/api/test/routes/agent-routes.test.ts`:

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

- [ ] **Step 2: Run route test to verify failure**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/routes/agent-routes.test.ts
```

Expected: fail because route schema requires `input`.

- [ ] **Step 3: Update route schema**

Modify `apps/api/src/routes/agent-routes.ts`:

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

Route handler:

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

- [ ] **Step 4: Update frontend client types**

Modify `apps/web/src/api/agent-client.ts`:

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

Update `AgentMessageRecord`:

```ts
parts: MessagePart[];
```

Update `startAgentMessage`:

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

- [ ] **Step 5: Run route and web type tests**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/routes/agent-routes.test.ts
npm run typecheck -w @agent/web
```

Expected: route tests pass; web typecheck may still fail until App integration in Task 7. Record the errors and continue to Task 6.

- [ ] **Step 6: Commit API route changes only**

```bash
git add apps/api/src/routes/agent-routes.ts apps/api/test/routes/agent-routes.test.ts apps/web/src/api/agent-client.ts
git commit -m "feat(api): accept message parts in agent route"
```

---

### Task 6: Render Message Parts In Conversation

**Files:**
- Create: `apps/web/src/components/MessagePartRenderer.tsx`
- Modify: `apps/web/src/components/AgentConversation.tsx`
- Test: `apps/web/src/components/AgentConversation.test.tsx`

- [ ] **Step 1: Add failing renderer tests**

Add tests in `apps/web/src/components/AgentConversation.test.tsx`:

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

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm run test -w @agent/web -- apps/web/src/components/AgentConversation.test.tsx
```

Expected: fail because `ChatMessage` still uses `content/assets`.

- [ ] **Step 3: Create `MessagePartRenderer`**

Create `apps/web/src/components/MessagePartRenderer.tsx`:

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

- [ ] **Step 4: Wire renderer into conversation**

Modify `ChatMessage` in `AgentConversation.tsx`:

```ts
parts: MessagePart[];
```

Replace `MessageContent` usage with:

```tsx
<MessagePartRenderer
  role={message.role}
  parts={message.parts}
  showCursor={isActive && message.role === "assistant" && message.status === "running"}
/>
```

Keep `ToolTraceList` below the message body for observability.

- [ ] **Step 5: Add CSS**

Modify `apps/web/src/styles.css`:

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

- [ ] **Step 6: Run renderer tests**

Run:

```bash
npm run test -w @agent/web -- apps/web/src/components/AgentConversation.test.tsx
```

Expected: pass after updating old test fixtures to use `parts`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/MessagePartRenderer.tsx apps/web/src/components/AgentConversation.tsx apps/web/src/components/AgentConversation.test.tsx apps/web/src/styles.css
git commit -m "feat(web): render message parts"
```

---

### Task 7: Integrate Parts In App State And SSE

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/main.test.tsx`
- Modify: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Add failing SSE part event test**

Add to `apps/web/src/App.test.tsx`:

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

- [ ] **Step 2: Run App tests to verify failure**

Run:

```bash
npm run test -w @agent/web -- apps/web/src/App.test.tsx
```

Expected: fail because App still appends `answer_delta` to `content`.

- [ ] **Step 3: Convert records to chat messages with parts**

Modify `createMessageFromRecord` in `App.tsx`:

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

- [ ] **Step 4: Apply part stream events**

Add helper in `App.tsx`:

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

In `applyStoredEvent`, apply part events before old answer delta fallback:

```ts
if (event.type.startsWith("message.part.")) {
  return {
    ...applyPartEventToMessage(message, event),
    events: nextEvents
  };
}
```

- [ ] **Step 5: Update submit flow to send parts**

Temporarily convert the existing string input to parts until Task 8:

```ts
const submittedParts: MessagePart[] = [{ type: "text", value: submittedInput }];
return await startAgentMessage(submittedParts, maxIterations, sessionId);
```

- [ ] **Step 6: Run App tests**

Run:

```bash
npm run test -w @agent/web -- apps/web/src/App.test.tsx apps/web/src/main.test.tsx
```

Expected: pass after fixture updates.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/main.test.tsx
git commit -m "feat(web): apply message part stream events"
```

---

### Task 8: Build ProseMirror PartComposer

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/prosemirror/part-schema.ts`
- Create: `apps/web/src/prosemirror/part-serialization.ts`
- Create: `apps/web/src/components/PartComposer.tsx`
- Test: `apps/web/src/prosemirror/part-serialization.test.ts`
- Test: `apps/web/src/components/PartComposer.test.tsx`

- [ ] **Step 1: Add ProseMirror dependencies**

Modify `apps/web/package.json` dependencies:

```json
"prosemirror-commands": "^1.7.1",
"prosemirror-history": "^1.4.1",
"prosemirror-keymap": "^1.2.3",
"prosemirror-model": "^1.25.3",
"prosemirror-schema-basic": "^1.2.4",
"prosemirror-state": "^1.4.4",
"prosemirror-view": "^1.40.1"
```

Run:

```bash
npm install
```

Expected: lockfile updates.

- [ ] **Step 2: Add failing serialization tests**

Create `apps/web/src/prosemirror/part-serialization.test.ts`:

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

- [ ] **Step 3: Run serialization test to verify failure**

Run:

```bash
npm run test -w @agent/web -- apps/web/src/prosemirror/part-serialization.test.ts
```

Expected: fail because ProseMirror files do not exist.

- [ ] **Step 4: Implement minimal schema**

Create `apps/web/src/prosemirror/part-schema.ts`:

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

- [ ] **Step 5: Implement serialization**

Create `apps/web/src/prosemirror/part-serialization.ts`:

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

- [ ] **Step 6: Run serialization tests**

Run:

```bash
npm run test -w @agent/web -- apps/web/src/prosemirror/part-serialization.test.ts
```

Expected: pass.

- [ ] **Step 7: Implement PartComposer**

Create `apps/web/src/components/PartComposer.tsx`:

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

- [ ] **Step 8: Add basic composer test**

Create `apps/web/src/components/PartComposer.test.tsx`:

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

- [ ] **Step 9: Run composer tests**

Run:

```bash
npm run test -w @agent/web -- apps/web/src/prosemirror/part-serialization.test.ts apps/web/src/components/PartComposer.test.tsx
```

Expected: pass.

- [ ] **Step 10: Commit**

```bash
git add apps/web/package.json package-lock.json apps/web/src/prosemirror apps/web/src/components/PartComposer.tsx apps/web/src/components/PartComposer.test.tsx
git commit -m "feat(web): add prosemirror part composer"
```

---

### Task 9: Replace AgentComposer Textarea With PartComposer

**Files:**
- Modify: `apps/web/src/components/AgentComposer.tsx`
- Modify: `apps/web/src/components/AgentComposer.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Add failing composer integration test**

Update `apps/web/src/components/AgentComposer.test.tsx`:

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

- [ ] **Step 2: Run composer integration test to verify failure**

Run:

```bash
npm run test -w @agent/web -- apps/web/src/components/AgentComposer.test.tsx
```

Expected: fail because `AgentComposer` still expects string input.

- [ ] **Step 3: Update AgentComposer props**

Modify `apps/web/src/components/AgentComposer.tsx`:

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

Render `PartComposer` where the textarea currently lives:

```tsx
<PartComposer
  parts={parts}
  disabled={isStreaming}
  onChange={onPartsChange}
  onSubmit={onSubmit}
  onCancel={onCancel}
/>
```

- [ ] **Step 4: Update App composer state**

Modify `apps/web/src/App.tsx`:

```ts
const [composerParts, setComposerParts] = useState<RuntimePart[]>([{ type: "text", value: "" }]);
```

Submit:

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

Suggestion:

```ts
function handleSuggestionSelect(suggestion: string) {
  setComposerParts([{ type: "text", value: suggestion }]);
}
```

- [ ] **Step 5: Run web tests**

Run:

```bash
npm run test -w @agent/web -- apps/web/src/components/AgentComposer.test.tsx apps/web/src/App.test.tsx
```

Expected: pass after fixtures are updated to use `parts`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/AgentComposer.tsx apps/web/src/components/AgentComposer.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): submit rich message parts"
```

---

### Task 10: Remove New UI Dependency On Assets

**Files:**
- Modify: `apps/web/src/components/AgentConversation.tsx`
- Modify: `apps/api/src/agent/agent-message-coordinator.ts`
- Modify: `apps/api/test/agent/agent-message-coordinator.test.ts`
- Modify: `apps/web/src/components/AgentConversation.test.tsx`

- [ ] **Step 1: Add failing no-assets assertion**

Add to `apps/api/test/agent/agent-message-coordinator.test.ts`:

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

- [ ] **Step 2: Remove asset-based main rendering**

In `AgentConversation.tsx`, remove `MessageImageAssets` from the main message body. Keep `ToolTraceList` for timeline/tool observation only.

- [ ] **Step 3: Remove generated asset persistence call and dead helper references**

In `AgentMessageCoordinator`, remove:

```ts
this.persistGeneratedAssets(...)
```

Keep `createAsset` and `agent_assets` table in the store for backward compatibility in this plan. Do not drop old table data.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm run test -w @agent/api -- apps/api/test/agent/agent-message-coordinator.test.ts
npm run test -w @agent/web -- apps/web/src/components/AgentConversation.test.tsx
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/agent-message-coordinator.ts apps/api/test/agent/agent-message-coordinator.test.ts apps/web/src/components/AgentConversation.tsx apps/web/src/components/AgentConversation.test.tsx
git commit -m "refactor: render generated media from message parts"
```

---

### Task 11: Final Verification

**Files:**
- Modify as needed: test fixtures only.

- [ ] **Step 1: Run API tests**

Run:

```bash
npm run test -w @agent/api
```

Expected: all API tests pass.

- [ ] **Step 2: Run web tests**

Run:

```bash
npm run test -w @agent/web
```

Expected: all web tests pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: TypeScript exits with code 0.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: API and web builds complete.

- [ ] **Step 5: Manual smoke test**

Run:

```bash
npm run dev
```

Open `http://127.0.0.1:4000` and verify:

- New conversation opens with the ProseMirror composer.
- Typing text and pressing Enter submits the message.
- Shift+Enter inserts a newline.
- User message renders from parts.
- Assistant streaming text updates in place.
- Image generation creates an inline loading media part.
- Image completion updates the same media part into a preview.
- Refreshing the page restores message parts.
- Right-side timeline still shows events.

- [ ] **Step 6: Commit verification fixture fixes**

If verification required test fixture updates:

```bash
git add apps/api/test apps/web/src
git commit -m "test: update message parts fixtures"
```

If no files changed, skip this commit.

---

## Self-Review

- Spec coverage:
  - `text/media` only: Tasks 1, 2, 6.
  - No `element`: Task 1 defines only `TextPart | MediaPart`.
  - No `key`, `uuid`, `thumbnailUrl`, `content`, `ui`, or `format`: Task 1 type definitions exclude them.
  - Runtime `$` fields stripped: Tasks 1 and 8.
  - `messageId + partIndex` streaming: Tasks 3 and 7.
  - LLM projection instead of raw parts: Task 4.
  - ProseMirror rich input: Tasks 8 and 9.
  - User message display from parts: Tasks 6 and 9.
  - Generated images as media parts: Tasks 3 and 10.

- Placeholder scan:
  - No `TBD`, no `TODO`, no unspecified test task.

- Type consistency:
  - Backend and frontend both use `MessagePart = TextPart | MediaPart`.
  - Text field is always `value`.
  - Media fields are `mime`, `url`, optional `name`, `width`, `height`.
  - Part stream events use `message.part.created`, `message.part.delta`, `message.part.updated`.
