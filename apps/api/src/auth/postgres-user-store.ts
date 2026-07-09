import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool, QueryResultRow } from "pg";
import type { GithubUserInput, UserRecord, UserStore } from "./user-store.js";

type SqlValue = string | number | boolean | null;

export interface PostgresUserStoreOptions {
  connectionString: string;
}

function createId() {
  return `user_${randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function numberPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${(index += 1)}`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Postgres 字段 ${field} 不是字符串`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class PostgresUserStore implements UserStore {
  private constructor(private readonly pool: Pool) {}

  static async create(options: PostgresUserStoreOptions): Promise<PostgresUserStore> {
    const store = new PostgresUserStore(new pg.Pool({ connectionString: options.connectionString }));
    await store.initializeSchema();
    return store;
  }

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

  async reset(): Promise<void> {
    await this.execute(`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

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

  private async queryOne<T extends QueryResultRow>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    const result = await this.pool.query<T>(numberPlaceholders(sql), params);
    return result.rows[0];
  }

  private async execute(sql: string, params: SqlValue[] = []): Promise<void> {
    await this.pool.query(numberPlaceholders(sql), params);
  }

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
