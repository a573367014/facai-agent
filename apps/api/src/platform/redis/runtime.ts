/**
 * Redis 运行时连接管理。
 *
 * 职责：创建并持有本进程所需的 Redis 连接集合（命令、发布、订阅三条），
 * 以及把 Redis URL 拆解为 BullMQ 能接受的连接参数。
 * 边界：只负责连接的创建与关闭，不负责重连策略、不负责具体业务命令、
 * 不负责订阅消息的业务处理。连接错误通过 onError 回调上抛，由调用方决定如何记录/降级。
 */
import { Redis } from "ioredis";

/**
 * Redis 运行时连接集合。
 *
 * 三条连接各司其职：commandClient 跑普通命令，eventPublisher 只发消息，eventSubscriber 只订阅。
 * 拆分原因见 createRedisRuntime 内部注释——订阅态连接不能复用跑普通命令。
 * close() 必须在进程退出时调用，否则连接泄漏会导致测试进程无法退出。
 */
export interface RedisRuntime {
  commandClient: Redis;
  eventPublisher: Redis;
  eventSubscriber: Redis;
  close(): void;
}

/**
 * 创建 Redis 运行时的配置。
 *
 * onError 是可选的：不传时连接错误只走 ioredis 默认的 console.error，
 * 生产环境应传入统一错误处理回调，把连接异常接入可观测性体系。
 */
export interface RedisRuntimeOptions {
  url: string;
  onError?: (error: Error) => void;
}

/**
 * 创建 Redis 运行时，返回三条独立连接及统一关闭方法。
 *
 * lazyConnect: true：连接创建时不立即连，等首次命令才建立，避免进程启动时
 * 因 Redis 未就绪而直接抛错，把连接时机交给调用方。maxRetriesPerRequest: 2：
 * 命令级重试上限，超过即抛 MaxRetriesPerRequestError，由上层识别为依赖不可用。
 * 错误回调里给 error 打上 redisClient 标签：三条连接共用同一套错误处理，
 * 不打标签无法区分是哪条连接出问题，排障时只能盲猜。
 */
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

/**
 * 把 redis:// URL 拆解为 BullMQ 所需的连接参数对象。
 *
 * 为什么需要单独转换：BullMQ（基于 ioredis）在队列场景下需要自己管理重连，
 * maxRetriesPerRequest 必须设为 null（无限重试），否则队列任务在 Redis 抖动时
 * 会被直接判失败而非等待恢复。这与 commandClient 的 maxRetriesPerRequest: 2
 * 语义相反，所以不能复用 createRedisRuntime 的连接，必须单独构造参数。
 * 端口缺省时回退 6379：Redis 默认端口，URL 规范允许省略端口。
 */
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
