import {
  appendTextDelta,
  ensureAppendableTextPart,
  type MessagePart
} from "./message-parts.js";

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

export interface RunningMessageDeltaResult {
  state: RunningMessageState;
  partIndex: number;
}

// 运行态存储是“正在生成的单条 assistant message”的权威状态源。
// 它不是 event replay，也不是整段会话缓存；SSE 断线重连时会用这里的 full draft 拼 snapshot，
// 完成后再把 parts 一次性写回持久化 message。生产环境可以把这个接口替换成 Redis 实现。
export interface RunningMessageStateStore {
  init(input: InitRunningMessageStateInput): Promise<RunningMessageState>;
  get(messageId: string): Promise<RunningMessageState | undefined>;
  appendTextDelta(messageId: string, delta: string): Promise<RunningMessageDeltaResult | undefined>;
  setParts(messageId: string, parts: MessagePart[]): Promise<RunningMessageState | undefined>;
  remove(messageId: string): Promise<void>;
}

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

function cloneState(state: RunningMessageState): RunningMessageState {
  return {
    ...state,
    parts: cloneParts(state.parts)
  };
}

function cloneParts(parts: MessagePart[]): MessagePart[] {
  return JSON.parse(JSON.stringify(parts)) as MessagePart[];
}

function now() {
  return new Date().toISOString();
}
