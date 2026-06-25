import { randomUUID } from "node:crypto";
import type { AgentRunResult, AgentStreamEvent } from "./types.js";

export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";
const DEFAULT_ANSWER_CHUNK_CHAR_LIMIT = 24;

interface PendingAnswerChunk {
  iteration: number;
  text: string;
}

export interface AgentSessionRecord {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunRecord {
  id: string;
  sessionId: string;
  input: string;
  maxIterations?: number;
  status: AgentRunStatus;
  answer?: string;
  steps?: AgentRunResult["steps"];
  error?: {
    code: string;
    message: string;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface StoredAgentEvent {
  // id 标识“这一条事件本身”，适合将来做单条事件查询或跨 run 引用。
  id: string;
  // seq 是同一个 run 内的递增游标，SSE 重连的 after 参数按它回放后续事件。
  seq: number;
  runId: string;
  event: AgentStreamEvent;
  createdAt: string;
}

export type AgentRunEventListener = (event: StoredAgentEvent) => void;
export interface CreateAgentRunInput {
  sessionId: string;
  input: string;
  maxIterations?: number;
}

export interface AgentRunStore {
  createSession(title?: string): AgentSessionRecord;
  listSessions(): AgentSessionRecord[];
  getSession(sessionId: string): AgentSessionRecord | undefined;
  createRun(input: CreateAgentRunInput): AgentRunRecord;
  getRun(runId: string): AgentRunRecord | undefined;
  getRunsBySession(sessionId: string): AgentRunRecord[];
  appendEvent(runId: string, event: AgentStreamEvent): StoredAgentEvent | undefined;
  // after 表示 run 内事件 seq 游标；after=3 会返回 seq > 3 的事件。
  getEvents(runId: string, after?: number): StoredAgentEvent[];
  completeRun(runId: string, result: AgentRunResult): AgentRunRecord | undefined;
  failRun(runId: string, error: { code: string; message: string }): AgentRunRecord | undefined;
  cancelRun(runId: string): AgentRunRecord | undefined;
  subscribe(runId: string, listener: AgentRunEventListener): () => void;
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

export class InMemoryAgentRunStore implements AgentRunStore {
  private readonly sessions = new Map<string, AgentSessionRecord>();
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly events = new Map<string, StoredAgentEvent[]>();
  private readonly subscribers = new Map<string, Set<AgentRunEventListener>>();
  private readonly pendingAnswerChunks = new Map<string, PendingAnswerChunk>();

  constructor(private readonly answerChunkCharLimit = DEFAULT_ANSWER_CHUNK_CHAR_LIMIT) {}

  createSession(title?: string): AgentSessionRecord {
    const timestamp = now();
    const session: AgentSessionRecord = {
      id: createId("session"),
      title,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.sessions.set(session.id, session);
    return session;
  }

  listSessions(): AgentSessionRecord[] {
    return [...this.sessions.values()].sort((leftSession, rightSession) =>
      rightSession.updatedAt.localeCompare(leftSession.updatedAt)
    );
  }

  getSession(sessionId: string): AgentSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  createRun(input: CreateAgentRunInput): AgentRunRecord {
    const timestamp = now();
    const run: AgentRunRecord = {
      id: createId("run"),
      sessionId: input.sessionId,
      input: input.input,
      maxIterations: input.maxIterations,
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.runs.set(run.id, run);
    this.events.set(run.id, []);
    this.touchSession(run.sessionId, timestamp);
    return run;
  }

  getRun(runId: string): AgentRunRecord | undefined {
    return this.runs.get(runId);
  }

  getRunsBySession(sessionId: string): AgentRunRecord[] {
    return [...this.runs.values()].filter((run) => run.sessionId === sessionId);
  }

  appendEvent(runId: string, event: AgentStreamEvent): StoredAgentEvent | undefined {
    // 模型流式输出会产生很多 answer_delta。这里先合并成 answer_chunk，
    // 避免内存 store 和 SQLite store 保存过多细碎事件。
    if (event.type === "answer_delta") {
      return this.appendAnswerDelta(runId, event);
    }

    this.flushPendingAnswerChunk(runId);
    return this.appendStoredEvent(runId, event);
  }

  private appendStoredEvent(runId: string, event: AgentStreamEvent): StoredAgentEvent {
    const existingEvents = this.events.get(runId) ?? [];
    const storedEvent: StoredAgentEvent = {
      id: createId("event"),
      seq: existingEvents.length + 1,
      runId,
      event,
      createdAt: now()
    };

    existingEvents.push(storedEvent);
    this.events.set(runId, existingEvents);
    this.publish(storedEvent);
    return storedEvent;
  }

  private appendAnswerDelta(runId: string, event: Extract<AgentStreamEvent, { type: "answer_delta" }>): StoredAgentEvent | undefined {
    const currentChunk = this.pendingAnswerChunks.get(runId);

    if (currentChunk && currentChunk.iteration !== event.iteration) {
      this.flushPendingAnswerChunk(runId);
    }

    const pendingChunk = this.pendingAnswerChunks.get(runId) ?? { iteration: event.iteration, text: "" };
    pendingChunk.text += event.delta;
    this.pendingAnswerChunks.set(runId, pendingChunk);

    if (pendingChunk.text.length >= this.answerChunkCharLimit) {
      return this.flushPendingAnswerChunk(runId);
    }

    return undefined;
  }

  private flushPendingAnswerChunk(runId: string): StoredAgentEvent | undefined {
    const pendingChunk = this.pendingAnswerChunks.get(runId);

    if (!pendingChunk || pendingChunk.text.length === 0) {
      return undefined;
    }

    this.pendingAnswerChunks.delete(runId);
    return this.appendStoredEvent(runId, {
      type: "answer_chunk",
      iteration: pendingChunk.iteration,
      text: pendingChunk.text
    });
  }

  getEvents(runId: string, after = 0): StoredAgentEvent[] {
    return (this.events.get(runId) ?? []).filter((event) => event.seq > after);
  }

  completeRun(runId: string, result: AgentRunResult): AgentRunRecord | undefined {
    const run = this.runs.get(runId);

    if (!run) {
      return undefined;
    }

    this.flushPendingAnswerChunk(runId);
    const timestamp = now();
    run.status = "completed";
    run.answer = result.answer;
    run.steps = result.steps;
    run.updatedAt = timestamp;
    run.completedAt = timestamp;
    this.touchSession(run.sessionId, timestamp);
    return run;
  }

  failRun(runId: string, error: { code: string; message: string }): AgentRunRecord | undefined {
    const run = this.runs.get(runId);

    if (!run) {
      return undefined;
    }

    this.flushPendingAnswerChunk(runId);
    const timestamp = now();
    run.status = "failed";
    run.error = error;
    run.updatedAt = timestamp;
    run.completedAt = timestamp;
    this.touchSession(run.sessionId, timestamp);
    return run;
  }

  cancelRun(runId: string): AgentRunRecord | undefined {
    const run = this.runs.get(runId);

    if (!run) {
      return undefined;
    }

    this.flushPendingAnswerChunk(runId);
    const timestamp = now();
    run.status = "cancelled";
    run.updatedAt = timestamp;
    run.completedAt = timestamp;
    this.touchSession(run.sessionId, timestamp);
    return run;
  }

  subscribe(runId: string, listener: AgentRunEventListener): () => void {
    const listeners = this.subscribers.get(runId) ?? new Set<AgentRunEventListener>();
    listeners.add(listener);
    this.subscribers.set(runId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.subscribers.delete(runId);
      }
    };
  }

  private publish(event: StoredAgentEvent) {
    const listeners = this.subscribers.get(event.runId);

    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  private touchSession(sessionId: string, timestamp: string) {
    const session = this.sessions.get(sessionId);

    if (session) {
      session.updatedAt = timestamp;
    }
  }
}
