import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  InMemoryAgentEventBus,
  RedisAgentEventBus,
  type RedisEventBusClient
} from "../../src/agent/agent-event-bus.js";
import type { StoredAgentEvent } from "../../src/agent/agent-store.js";

class FakeRedisEventBusClient extends EventEmitter implements RedisEventBusClient {
  readonly subscriptions = new Set<string>();
  readonly published: Array<{ channel: string; payload: string }> = [];

  async publish(channel: string, payload: string): Promise<number> {
    this.published.push({ channel, payload });
    this.emit("message", channel, payload);
    return 1;
  }

  async subscribe(channel: string): Promise<unknown> {
    this.subscriptions.add(channel);
    return "OK";
  }

  async unsubscribe(channel: string): Promise<unknown> {
    this.subscriptions.delete(channel);
    return "OK";
  }
}

function createStoredEvent(type = "llm_start"): StoredAgentEvent {
  return {
    id: "event_1",
    seq: 1,
    messageId: "msg_1",
    runId: "run_1",
    event: { type, iteration: 0 } as StoredAgentEvent["event"],
    createdAt: "2026-06-30T00:00:00.000Z"
  };
}

describe("AgentEventBus", () => {
  it("publishes in-memory run events to active subscribers", async () => {
    const bus = new InMemoryAgentEventBus();
    const events: StoredAgentEvent[] = [];
    const unsubscribe = await bus.subscribeRun("run_1", (event) => events.push(event));
    const storedEvent = createStoredEvent();

    await bus.publishRunEvent("run_1", storedEvent);
    await unsubscribe();
    await bus.publishRunEvent("run_1", createStoredEvent("iteration_start"));

    expect(events).toEqual([storedEvent]);
  });

  it("uses Redis channels for run events", async () => {
    const client = new FakeRedisEventBusClient();
    const bus = new RedisAgentEventBus({
      publisher: client,
      subscriber: client,
      keyPrefix: "agent:test"
    });
    const runEvents: StoredAgentEvent[] = [];

    const unsubscribeRun = await bus.subscribeRun("run_1", (event) => runEvents.push(event));
    const storedEvent = createStoredEvent();

    await bus.publishRunEvent("run_1", storedEvent);

    expect(client.published.map((entry) => entry.channel)).toEqual(["agent:test:events:run:{run_1}"]);
    expect(runEvents).toEqual([storedEvent]);

    await unsubscribeRun();

    expect(client.subscriptions.size).toBe(0);
  });
});
