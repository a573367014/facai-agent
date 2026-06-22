import { randomUUID } from "node:crypto";
import type { AgentRunResult, AgentStreamEvent } from "./types.js";

export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";

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
  id: number;
  runId: string;
  event: AgentStreamEvent;
  createdAt: string;
}

export type AgentRunEventListener = (event: StoredAgentEvent) => void;

function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

export class InMemoryAgentRunStore {
  private readonly sessions = new Map<string, AgentSessionRecord>();
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly events = new Map<string, StoredAgentEvent[]>();
  private readonly subscribers = new Map<string, Set<AgentRunEventListener>>();

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

  getSession(sessionId: string): AgentSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  createRun(input: { sessionId: string; input: string; maxIterations?: number }): AgentRunRecord {
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

  appendEvent(runId: string, event: AgentStreamEvent): StoredAgentEvent {
    const existingEvents = this.events.get(runId) ?? [];
    const storedEvent: StoredAgentEvent = {
      id: existingEvents.length + 1,
      runId,
      event,
      createdAt: now()
    };

    existingEvents.push(storedEvent);
    this.events.set(runId, existingEvents);
    this.publish(storedEvent);
    return storedEvent;
  }

  getEvents(runId: string, after = 0): StoredAgentEvent[] {
    return (this.events.get(runId) ?? []).filter((event) => event.id > after);
  }

  completeRun(runId: string, result: AgentRunResult): AgentRunRecord | undefined {
    const run = this.runs.get(runId);

    if (!run) {
      return undefined;
    }

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

    const timestamp = now();
    run.status = "failed";
    run.error = error;
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
