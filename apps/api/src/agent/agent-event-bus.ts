import type { AgentEventListener, StoredAgentEvent } from "./agent-store.js";

export interface AgentEventBus {
  publishRunEvent(runId: string, event: StoredAgentEvent): Promise<void>;
  subscribeRun(runId: string, listener: AgentEventListener): Promise<() => Promise<void> | void>;
}

export interface RedisEventBusClient {
  publish(channel: string, payload: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, payload: string) => void): this;
  off(event: "message", listener: (channel: string, payload: string) => void): this;
}

export interface RedisAgentEventBusOptions {
  publisher: RedisEventBusClient;
  subscriber: RedisEventBusClient;
  keyPrefix?: string;
}

const defaultKeyPrefix = "agent";

export class InMemoryAgentEventBus implements AgentEventBus {
  private readonly runListeners = new Map<string, Set<AgentEventListener>>();

  async publishRunEvent(runId: string, event: StoredAgentEvent): Promise<void> {
    for (const listener of this.runListeners.get(runId) ?? []) {
      listener(event);
    }
  }

  async subscribeRun(runId: string, listener: AgentEventListener): Promise<() => void> {
    return this.addListener(this.runListeners, runId, listener);
  }

  private addListener(
    listenersById: Map<string, Set<AgentEventListener>>,
    id: string,
    listener: AgentEventListener
  ): () => void {
    const listeners = listenersById.get(id) ?? new Set<AgentEventListener>();
    listeners.add(listener);
    listenersById.set(id, listeners);

    return () => {
      listeners.delete(listener);

      if (listeners.size === 0) {
        listenersById.delete(id);
      }
    };
  }
}

export class RedisAgentEventBus implements AgentEventBus {
  private readonly keyPrefix: string;
  private readonly listenersByChannel = new Map<string, Set<AgentEventListener>>();
  private readonly handleMessage = (channel: string, payload: string) => {
    const listeners = this.listenersByChannel.get(channel);

    if (!listeners?.size) {
      return;
    }

    const event = JSON.parse(payload) as StoredAgentEvent;

    for (const listener of listeners) {
      listener(event);
    }
  };

  constructor(private readonly options: RedisAgentEventBusOptions) {
    this.keyPrefix = options.keyPrefix ?? defaultKeyPrefix;
    this.options.subscriber.on("message", this.handleMessage);
  }

  async publishRunEvent(runId: string, event: StoredAgentEvent): Promise<void> {
    // Pub/Sub 只负责实时扇出，不保证离线回放；断线恢复依赖 SQLite run events 和 snapshot。
    await this.options.publisher.publish(this.getRunChannel(runId), JSON.stringify(event));
  }

  async subscribeRun(runId: string, listener: AgentEventListener): Promise<() => Promise<void>> {
    // channel 按 runId 订阅。event.messageId 仍在 payload 里，前端用它更新对应 assistant message。
    return this.subscribe(this.getRunChannel(runId), listener);
  }

  private async subscribe(channel: string, listener: AgentEventListener): Promise<() => Promise<void>> {
    const listeners = this.listenersByChannel.get(channel) ?? new Set<AgentEventListener>();
    const shouldSubscribe = listeners.size === 0;
    listeners.add(listener);
    this.listenersByChannel.set(channel, listeners);

    if (shouldSubscribe) {
      await this.options.subscriber.subscribe(channel);
    }

    return async () => {
      listeners.delete(listener);

      if (listeners.size > 0) {
        return;
      }

      this.listenersByChannel.delete(channel);
      await this.options.subscriber.unsubscribe(channel);
    };
  }

  private getRunChannel(runId: string) {
    return `${this.keyPrefix}:events:run:{${runId}}`;
  }
}
