/**
 * 模块职责：Agent 运行事件的"扇出总线"。
 *
 * 在整个 Agent 系统里，一个 run 的执行过程会产生大量事件（token delta、工具调用、
 * 步骤更新等）。这些事件需要被多个消费者接收：SSE 推送给前端、事件日志写入、
 * 运行态草稿更新等。事件总线负责把"一次发布"扇出给"多个订阅者"。
 *
 * 边界：
 * - 只负责"实时扇出"，不负责持久化、不负责离线回放。断线重连的补偿由
 *   running-message-state-store 的 full draft snapshot 机制兜底。
 * - 订阅粒度是 runId 级别：同一个 run 的事件只发给订阅了该 run 的 listener。
 * - 本文件只提供 Redis Pub/Sub 实现；内存版（单进程）由调用方按需注入。
 */
import type { AgentEventListener, StoredAgentEvent } from "./agent-store.js";

/**
 * Agent 事件总线契约。
 *
 * publishRunEvent：把一个事件发布到 runId 对应的通道，所有订阅者都会收到。
 * subscribeRun：为指定 run 注册一个 listener，返回一个取消订阅函数。
 *
 * 为什么返回 Promise<() => Promise> 而不是直接返回 void：
 * 取消订阅时需要异步清理 Redis 订阅（unsubscribe 是异步的），
 * 调用方必须 await 这个清理，否则会留下僵尸订阅。
 */
export interface AgentEventBus {
  publishRunEvent(runId: string, event: StoredAgentEvent): Promise<void>;
  subscribeRun(runId: string, listener: AgentEventListener): Promise<() => Promise<void> | void>;
}

/**
 * Redis 客户端的最小契约——只暴露 Pub/Sub 所需的方法。
 *
 * 为什么不直接依赖 ioredis/redis 类型：
 * 1. 解耦：测试时可以注入 mock，生产时注入真实 client；
 * 2. publisher 和 subscriber 必须是两个独立连接（Redis 规定订阅连接不能发 publish），
 *    所以这里分成两个字段。
 */
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

/**
 * 基于 Redis Pub/Sub 的事件总线实现。
 *
 * 核心设计：引用计数订阅。
 * 多个 listener 订阅同一个 run 时，底层只 subscribe 一次 Redis channel；
 * 最后一个 listener 取消订阅时才真正 unsubscribe。
 * 不这么做会导致：每个 listener 都 subscribe 一次，Redis 连接上挂满重复订阅，
 * 既浪费连接资源，又会让同一消息被重复投递。
 */
export class RedisAgentEventBus implements AgentEventBus {
  private readonly keyPrefix: string;
  private readonly listenersByChannel = new Map<string, Set<AgentEventListener>>();

  /**
   * Redis "message" 事件的统一回调。
   *
   * 所有 channel 的消息都走这一个函数，再按 channel 分发到对应 listener 集合。
   * 为什么不在 subscribeRun 里单独 on("message")：Redis 客户端的 on 是全局的，
   * 每次调用都会叠加一个监听器，多次订阅会导致同一消息被处理多次。
   * 集中注册一次、按 channel 路由，是最安全的方式。
   */
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
    // Pub/Sub 只负责实时扇出，不保证离线回放；断线恢复依赖 message snapshot。
    await this.options.publisher.publish(this.getRunChannel(runId), JSON.stringify(event));
  }

  async subscribeRun(runId: string, listener: AgentEventListener): Promise<() => Promise<void>> {
    // channel 按 runId 订阅。event.messageId 仍在 payload 里，前端用它更新对应 assistant message。
    return this.subscribe(this.getRunChannel(runId), listener);
  }

  /**
   * 引用计数订阅的核心实现。
   *
   * shouldSubscribe 判断：当 channel 的 listener 集合从 0 变 1 时才真正 subscribe。
   * 取消订阅时反过来：从 1 变 0 时才 unsubscribe，并清理 Map 条目防止内存泄漏。
   */
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

  /**
   * 生成 run 级别的 Redis channel 名。
   *
   * {runId} 花括号是 Redis Cluster 的 hash tag：保证同一个 run 的所有 key
   *（事件、锁、取消标记）落在同一个 hash slot，可以执行跨 key 操作。
   */
  private getRunChannel(runId: string) {
    return `${this.keyPrefix}:events:run:{${runId}}`;
  }
}
