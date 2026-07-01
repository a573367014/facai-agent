import { Redis } from "ioredis";

export interface RedisRuntime {
  commandClient: Redis;
  eventPublisher: Redis;
  eventSubscriber: Redis;
  close(): void;
}

export interface RedisRuntimeOptions {
  url: string;
  onError?: (error: Error) => void;
}

export function createRedisRuntime(options: RedisRuntimeOptions): RedisRuntime {
  // ioredis 的订阅连接进入 subscribe 状态后不适合再跑普通命令，所以这里拆成三条连接：
  // commandClient 跑 get/set/eval，eventPublisher 只发布，eventSubscriber 只订阅。
  const createClient = (label: string) => {
    const client = new Redis(options.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2
    });
    client.on("error", (error: Error) => {
      options.onError?.(Object.assign(error, { redisClient: label }));
    });
    return client;
  };

  const commandClient = createClient("command");
  const eventPublisher = createClient("event-publisher");
  const eventSubscriber = createClient("event-subscriber");

  return {
    commandClient,
    eventPublisher,
    eventSubscriber,
    close: () => {
      commandClient.disconnect();
      eventPublisher.disconnect();
      eventSubscriber.disconnect();
    }
  };
}

export function toBullMqRedisConnectionOptions(redisUrl: string) {
  const url = new URL(redisUrl);
  const db = url.pathname.replace(/^\//, "");

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    db: db ? Number(db) : undefined,
    maxRetriesPerRequest: null
  };
}
