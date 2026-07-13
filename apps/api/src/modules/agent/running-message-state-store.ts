/**
 * 模块职责：运行中消息状态存储的接口契约 + 内存实现。
 *
 * 在 Agent 生成回复时，assistant message 的 parts 会高频变化（每个 token delta
 * 都是一次更新）。这些中间状态需要一个"权威源"来支撑：
 * - SSE 断线重连时，用这里的 full draft 拼 snapshot，让前端看到当前已生成的内容；
 * - 详情查询时，合并 SQLite 外壳和这里的 parts；
 * - 完成后，把 parts 一次性写回 SQLite 持久化 message。
 *
 * 本模块定义了 RunningMessageStateStore 接口契约，并提供了一个内存实现
 *（InMemoryRunningMessageStateStore）用于单进程场景和测试。
 * 生产环境可以替换成 Redis 实现（接口不变）。
 *
 * 边界：
 * - 只管"单条正在生成的 message"的 parts 状态，不管整段会话、不管事件回放。
 * - version 字段是乐观并发控制的核心：每次更新自增，前端用它去重。
 */
import {
  appendTextDelta,
  ensureAppendableTextPart,
  type MessagePart
} from "./message-parts.js";

/**
 * 运行中消息的完整状态。
 *
 * version 是乐观并发控制的关键：每次 parts 变化都自增。
 * 前端 SSE 事件携带 version，断线重连时用 version 去重，
 * 避免同一个 delta 被追加两次。
 */
export interface RunningMessageState {
  messageId: string;
  sessionId: string;
  runId?: string;
  parts: MessagePart[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface InitRunningMessageStateInput {
  messageId: string;
  sessionId: string;
  runId?: string;
  parts: MessagePart[];
}

/**
 * appendTextDelta 的返回值：更新后的完整 state + 被追加的 part 索引。
 * partIndex 告诉 SSE 事件这个 delta 属于哪个 part（文本可能跨多个 part）。
 */
export interface RunningMessageDeltaResult {
  state: RunningMessageState;
  partIndex: number;
}

// 运行态存储是"正在生成的单条 assistant message"的权威状态源。
// 它不是 event replay，也不是整段会话缓存；SSE 断线重连时会用这里的 full draft 拼 snapshot，
// 完成后再把 parts 一次性写回持久化 message。生产环境可以把这个接口替换成 Redis 实现。
export interface RunningMessageStateStore {
  init(input: InitRunningMessageStateInput): Promise<RunningMessageState>;
  get(messageId: string): Promise<RunningMessageState | undefined>;
  appendTextDelta(messageId: string, delta: string): Promise<RunningMessageDeltaResult | undefined>;
  setParts(messageId: string, parts: MessagePart[]): Promise<RunningMessageState | undefined>;
  remove(messageId: string): Promise<void>;
}

/**
 * 内存版运行态存储，用于单进程场景和测试。
 *
 * 用 Map<messageId, RunningMessageState> 存储。
 * 关键设计：所有返回给调用方的 state 都是深拷贝（cloneState），
 * 防止调用方修改返回值后污染内部存储。
 * 不适用于多进程：跨进程必须用 Redis 版。
 */
export class InMemoryRunningMessageStateStore implements RunningMessageStateStore {
  private readonly states = new Map<string, RunningMessageState>();

  async init(input: InitRunningMessageStateInput): Promise<RunningMessageState> {
    const timestamp = now();
    const state: RunningMessageState = {
      messageId: input.messageId,
      sessionId: input.sessionId,
      runId: input.runId,
      parts: cloneParts(input.parts),
      version: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.states.set(input.messageId, state);
    return cloneState(state);
  }

  async get(messageId: string): Promise<RunningMessageState | undefined> {
    const state = this.states.get(messageId);
    return state ? cloneState(state) : undefined;
  }

  /**
   * 追加文本 delta 到草稿。
   *
   * 流程：先确保 parts 末尾有一个可追加的 text part（没有就创建），
   * 然后把 delta 追加到该 part，最后 replaceState 更新版本和时间戳。
   * 返回 partIndex 让 SSE 事件知道这个 delta 属于哪个 part。
   */
  async appendTextDelta(messageId: string, delta: string): Promise<RunningMessageDeltaResult | undefined> {
    const state = this.states.get(messageId);

    if (!state) {
      return undefined;
    }

    const { parts, partIndex } = ensureAppendableTextPart(state.parts);
    const nextState = this.replaceState(state, appendTextDelta(parts, partIndex, delta));

    return {
      state: cloneState(nextState),
      partIndex
    };
  }

  async setParts(messageId: string, parts: MessagePart[]): Promise<RunningMessageState | undefined> {
    const state = this.states.get(messageId);

    if (!state) {
      return undefined;
    }

    return cloneState(this.replaceState(state, parts));
  }

  async remove(messageId: string): Promise<void> {
    this.states.delete(messageId);
  }

  /**
   * 用新 parts 替换 state，自增 version，更新时间戳。
   * 这是所有写入操作的统一出口，确保 version 一定自增、时间戳一定更新。
   */
  private replaceState(state: RunningMessageState, parts: MessagePart[]): RunningMessageState {
    const nextState: RunningMessageState = {
      ...state,
      parts: cloneParts(parts),
      version: state.version + 1,
      updatedAt: now()
    };

    this.states.set(state.messageId, nextState);
    return nextState;
  }
}

/**
 * 深拷贝 state：防止调用方修改返回值后污染内部存储。
 * parts 是数组，浅拷贝会导致调用方 push/splice 直接改到内部数据。
 */
function cloneState(state: RunningMessageState): RunningMessageState {
  return {
    ...state,
    parts: cloneParts(state.parts)
  };
}

/**
 * 深拷贝 parts 数组。
 * 用 JSON 序列化/反序列化实现深拷贝：简单可靠，且 parts 只含可序列化数据。
 * 不用 structuredClone 是为了兼容更老的 Node 版本。
 */
function cloneParts(parts: MessagePart[]): MessagePart[] {
  return JSON.parse(JSON.stringify(parts)) as MessagePart[];
}

function now() {
  return new Date().toISOString();
}
