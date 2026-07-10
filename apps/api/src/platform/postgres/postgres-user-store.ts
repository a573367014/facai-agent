/**
 * PostgreSQL 用户存储 —— UserStore 接口的生产环境实现。
 *
 * 【职责边界】
 * 本文件是 platform 基础设施层的一部分，实现 auth 模块定义的 UserStore 契约。
 * 它负责所有与 PostgreSQL 数据库的交互：建表、upsert、查询、连接池管理。
 *
 * 这里体现了六边形架构（端口与适配器）的思想：
 * - user-store.ts 中的 UserStore 是"端口"（Port），定义了需要什么
 * - 本文件是"适配器"（Adapter），用 PostgreSQL 具体实现这个端口
 * 业务层只依赖端口，不关心适配器用的是什么数据库。
 *
 * 【连接池设计】
 * 使用 pg.Pool 管理连接池，避免每个请求都新建/销毁 TCP 连接。
 * 池在创建时初始化一次，所有查询复用池中的连接，大幅提升吞吐量。
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool, QueryResultRow } from "pg";
import type { GithubUserInput, UserRecord, UserStore } from "../../modules/auth/user-store.js";

/** SQL 参数值允许的类型。pg 驱动只接受这些原始类型，不支持直接传对象/数组 */
type SqlValue = string | number | boolean | null;

export interface PostgresUserStoreOptions {
  connectionString: string;
}

/** 生成用户内部 id，带 user_ 前缀便于在日志/数据库中肉眼识别实体类型 */
function createId() {
  return `user_${randomUUID()}`;
}

/** 当前 UTC 时间的 ISO 字符串，用于记录时间戳 */
function now() {
  return new Date().toISOString();
}

/**
 * 将占位符风格从 ? 转换为 pg 的 $1/$2/$3 风格。
 *
 * 【为什么需要这层转换】
 * 代码中用 ? 写 SQL（更简洁、更通用），但 pg 驱动要求用 $N 风格的参数化占位符。
 * 这里做一层透明转换，让业务 SQL 保持可读性的同时兼容 pg 驱动。
 * 参数化查询（而非字符串拼接）是防 SQL 注入的根本手段。
 */
function numberPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${(index += 1)}`);
}

/** 类型守卫：确保数据库读出的字段是 string，否则抛错防止脏数据传播 */
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Postgres 字段 ${field} 不是字符串`);
  }

  return value;
}

/** 可选字符串字段的类型守卫：null 或非 string 一律归一化为 undefined */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class PostgresUserStore implements UserStore {
  /**
   * 构造函数设为 private，强制通过静态工厂方法 create() 创建实例。
   * 因为初始化需要先建表（异步操作），不能在构造函数中完成。
   */
  private constructor(private readonly pool: Pool) {}

  /**
   * 异步工厂方法：创建连接池 → 初始化表结构 → 返回可用实例。
   *
   * 【为什么用 async create 而非 constructor】
   * 建表是异步操作，而 constructor 不能是 async。用静态工厂方法把
   * "创建对象"和"异步初始化"合并为一步，保证调用方拿到的实例一定已就绪。
   * initializeSchema 用 CREATE TABLE IF NOT EXISTS，保证幂等可重复执行。
   */
  static async create(options: PostgresUserStoreOptions): Promise<PostgresUserStore> {
    const store = new PostgresUserStore(new pg.Pool({ connectionString: options.connectionString }));
    await store.initializeSchema();
    return store;
  }

  /**
   * upsert 用户：利用 PostgreSQL 的 INSERT ... ON CONFLICT 语法。
   *
   * 【ON CONFLICT (github_id) DO UPDATE 的含义】
   * 当 github_id 唯一约束冲突时（用户已存在），不报错而是执行 UPDATE。
   * EXCLUDED 关键字指向"本应插入但冲突的那行数据"，用它来更新已有记录。
   * 这样一条 SQL 就实现了"有则更新、无则插入"，且是数据库级别的原子操作，
   * 避免了"先 SELECT 再判断 INSERT/UPDATE"的竞态条件。
   *
   * 注意：id 和 created_at 不在 UPDATE SET 中——新用户插入时才赋值，
   * 老用户冲突时保持原值不变（id 不变、注册时间不变）。
   */
  async upsertGithubUser(input: GithubUserInput): Promise<UserRecord> {
    const timestamp = now();
    const id = createId();
    const row = await this.queryOne(
      `INSERT INTO users (
         id,
         github_id,
         github_login,
         name,
         email,
         avatar_url,
         github_url,
         created_at,
         updated_at,
         last_login_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (github_id) DO UPDATE SET
         github_login = EXCLUDED.github_login,
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         avatar_url = EXCLUDED.avatar_url,
         github_url = EXCLUDED.github_url,
         updated_at = EXCLUDED.updated_at,
         last_login_at = EXCLUDED.last_login_at
       RETURNING id, github_id, github_login, name, email, avatar_url, github_url, created_at, updated_at, last_login_at`,
      [
        id,
        input.githubId,
        input.githubLogin,
        input.name ?? null,
        input.email ?? null,
        input.avatarUrl ?? null,
        input.githubUrl ?? null,
        timestamp,
        timestamp,
        timestamp
      ]
    );

    if (!row) {
      throw new Error("users upsert 未返回记录");
    }

    return this.toUserRecord(row);
  }

  async getUserById(userId: string): Promise<UserRecord | undefined> {
    const row = await this.queryOne(
      `SELECT id, github_id, github_login, name, email, avatar_url, github_url, created_at, updated_at, last_login_at
       FROM users
       WHERE id = ?`,
      [userId]
    );

    return row ? this.toUserRecord(row) : undefined;
  }

  /**
   * 清空 users 表并重置自增序列。
   * 主要用于集成测试在用例之间清理数据，保证测试隔离性。
   * 生产环境绝不调用。
   */
  async reset(): Promise<void> {
    await this.execute(`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
  }

  /** 关闭连接池，释放所有数据库连接。应用优雅停机时必须调用 */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * 初始化表结构和索引。
   * 全部使用 IF NOT EXISTS，保证幂等——多次执行不会报错。
   *
   * 【索引设计】
   * - github_id UNIQUE：天然唯一，既是业务约束也是 upsert 的冲突检测依据
   * - github_login：可能按用户名查询/搜索，加普通索引加速
   * - updated_at：可能按更新时间排序/筛选活跃用户，加索引支持
   * - seq SERIAL：自增整数序列，为未来可能的全量分页或顺序遍历预留
   */
  private async initializeSchema(): Promise<void> {
    await this.execute(
      `CREATE TABLE IF NOT EXISTS users (
         id TEXT PRIMARY KEY,
         github_id TEXT NOT NULL UNIQUE,
         github_login TEXT NOT NULL,
         name TEXT,
         email TEXT,
         avatar_url TEXT,
         github_url TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         last_login_at TEXT NOT NULL,
         seq SERIAL
       )`
    );
    await this.execute(
      `CREATE INDEX IF NOT EXISTS idx_users_github_login
       ON users (github_login)`
    );
    await this.execute(
      `CREATE INDEX IF NOT EXISTS idx_users_updated_at
       ON users (updated_at)`
    );
  }

  /** 执行查询并返回第一行（用于 upsert/单条查询场景） */
  private async queryOne<T extends QueryResultRow>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    const result = await this.pool.query<T>(numberPlaceholders(sql), params);
    return result.rows[0];
  }

  /** 执行无返回值的 SQL（DDL、TRUNCATE 等） */
  private async execute(sql: string, params: SqlValue[] = []): Promise<void> {
    await this.pool.query(numberPlaceholders(sql), params);
  }

  /**
   * 将数据库行（snake_case）映射为领域对象 UserRecord（camelCase）。
   *
   * 【为什么需要这层映射】
   * 数据库列名用 snake_case（SQL 惯例），但 TS 领域对象用 camelCase（JS 惯例）。
   * 在此做一次统一转换，让上层业务代码始终面对干净的 camelCase 对象，
   * 不需要关心数据库的命名约定。同时通过 requiredString/optionalString
   * 做类型守卫，防止数据库返回 null 或意外类型污染到业务层。
   */
  private toUserRecord(row: QueryResultRow): UserRecord {
    return {
      id: requiredString(row.id, "id"),
      githubId: requiredString(row.github_id, "github_id"),
      githubLogin: requiredString(row.github_login, "github_login"),
      name: optionalString(row.name),
      email: optionalString(row.email),
      avatarUrl: optionalString(row.avatar_url),
      githubUrl: optionalString(row.github_url),
      createdAt: requiredString(row.created_at, "created_at"),
      updatedAt: requiredString(row.updated_at, "updated_at"),
      lastLoginAt: requiredString(row.last_login_at, "last_login_at")
    };
  }
}
