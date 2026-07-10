/**
 * 用户存储 —— 认证子系统的数据访问抽象层。
 *
 * 【职责边界】
 * 本文件只负责定义"用户数据长什么样"以及"存储层必须提供哪些能力"，
 * 但绝不关心数据最终落在内存、Postgres 还是其他什么地方。
 *
 * 这里的 `UserStore` 接口是依赖倒置（DIP）的关键：上层 AuthService
 * 依赖这个抽象接口，而不是某个具体存储实现。这样做的好处是——
 * 生产环境注入 PostgresUserStore，测试/开发环境注入 InMemoryUserStore，
 * 业务逻辑完全不需要改动。
 *
 * 通俗比喻：UserStore 是一份"用户档案柜的操作规范"，规定了必须能
 * 存档（upsert）和查档（getById），但不管这柜子是铁皮柜还是数据库。
 */
import { randomUUID } from "node:crypto";

/**
 * 系统内部使用的用户完整记录。
 * 所有时间字段均为 ISO 8601 字符串（UTC），而非时间戳数字，
 * 这样可以直接序列化进 JSON 响应，也便于跨时区一致存储。
 */
export interface UserRecord {
  id: string;
  /** GitHub 平台的用户唯一标识，用作 upsert 的天然业务主键（同一 GitHub 用户多次登录不会创建重复记录） */
  githubId: string;
  githubLogin: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  githubUrl?: string;
  createdAt: string;
  updatedAt: string;
  /** 最近一次登录时间，每次 OAuth 回调成功都会刷新，用于审计与活跃度统计 */
  lastLoginAt: string;
}

/**
 * 从 GitHub OAuth 拿到的用户资料，作为 upsert 的入参。
 * 字段集合是 UserRecord 的子集——没有 id 和时间戳，因为这些由存储层自行生成。
 */
export interface GithubUserInput {
  githubId: string;
  githubLogin: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  githubUrl?: string;
}

/**
 * 用户存储契约。任何实现都必须提供这两个操作：
 * - upsertGithubUser：根据 githubId 做"有则更新、无则创建"，保证幂等
 * - getUserById：按内部 id 查询，用于 token 校验后还原当前用户
 */
export interface UserStore {
  upsertGithubUser(input: GithubUserInput): Promise<UserRecord>;
  getUserById(userId: string): Promise<UserRecord | undefined>;
}

/**
 * 内存版用户存储，主要用于单元测试和本地开发。
 *
 * 【为什么需要双索引】
 * 维护两个 Map 是为了支撑两种查询路径：
 * - usersById：按内部 id 查（对应 getUserById）
 * - idsByGithubId：按 githubId 反查（对应 upsert 时的"判断用户是否已存在"）
 * 如果只用一个 Map，每次 upsert 都得遍历整张表去匹配 githubId，O(n) 退化。
 */
export class InMemoryUserStore implements UserStore {
  private readonly usersById = new Map<string, UserRecord>();
  private readonly idsByGithubId = new Map<string, string>();

  async upsertGithubUser(input: GithubUserInput): Promise<UserRecord> {
    const timestamp = new Date().toISOString();
    const existingId = this.idsByGithubId.get(input.githubId);
    const existingUser = existingId ? this.usersById.get(existingId) : undefined;
    const user: UserRecord = {
      // 复用已有 id，保证同一 GitHub 用户在系统中的身份不变（id 是后续 token sub 的来源）
      id: existingUser?.id ?? `user_${randomUUID()}`,
      githubId: input.githubId,
      githubLogin: input.githubLogin,
      name: input.name,
      email: input.email,
      avatarUrl: input.avatarUrl,
      githubUrl: input.githubUrl,
      // createdAt 只在首次创建时写入，之后永不修改，保留用户的原始注册时间
      createdAt: existingUser?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastLoginAt: timestamp
    };

    this.usersById.set(user.id, user);
    this.idsByGithubId.set(user.githubId, user.id);
    return user;
  }

  async getUserById(userId: string): Promise<UserRecord | undefined> {
    return this.usersById.get(userId);
  }
}
