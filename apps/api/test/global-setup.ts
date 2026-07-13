import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import pg from "pg";

const DEFAULT_TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/agent_test";
const migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

export default async function setupPostgresSchema(): Promise<void> {
  // 现有测试分别读取 DATABASE_URL 和 TEST_DATABASE_URL；去重后逐个迁移，
  // 保证单独运行任意测试文件时也不会依赖 Store 的旧式自动建表副作用。
  const databaseUrls = new Set([
    process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
    process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL
  ]);

  for (const databaseUrl of databaseUrls) {
    await ensureDatabaseExists(databaseUrl);
    await runner({
      databaseUrl,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      schema: "public",
      checkOrder: true,
      singleTransaction: true,
      verbose: false,
      log: () => undefined
    });
  }
}

async function ensureDatabaseExists(databaseUrl: string): Promise<void> {
  const targetUrl = new URL(databaseUrl);
  const databaseName = decodeURIComponent(targetUrl.pathname.slice(1));
  if (!databaseName) {
    throw new Error(`测试数据库连接串缺少数据库名：${databaseUrl}`);
  }

  const adminUrl = new URL(targetUrl);
  adminUrl.pathname = "/postgres";
  const client = new pg.Client({ connectionString: adminUrl.toString() });

  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (existing.rowCount === 0) {
      const quotedName = `"${databaseName.replaceAll('"', '""')}"`;
      try {
        await client.query(`CREATE DATABASE ${quotedName}`);
      } catch (error) {
        // 并行启动两个测试进程时，另一个进程可能刚好先创建成功。
        if (!(error instanceof Error && "code" in error && error.code === "42P04")) {
          throw error;
        }
      }
    }
  } finally {
    await client.end();
  }
}
