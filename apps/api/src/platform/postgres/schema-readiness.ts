import type { Pool } from "pg";

/**
 * Store 只检查迁移账本和自己依赖的基线表，不负责修改数据库结构。
 * 真正的 schema 变更必须进入 migrations 目录并由 `pnpm db:migrate` 执行。
 */
export async function assertPostgresSchemaReady(pool: Pool, tableName: string): Promise<void> {
  const relations = await pool.query<{ migrations: string | null; required_table: string | null }>(
    "SELECT to_regclass('public.pgmigrations') AS migrations, to_regclass($1) AS required_table",
    [`public.${tableName}`]
  );
  const relation = relations.rows[0];

  if (!relation?.migrations || !relation.required_table) {
    throw new Error(
      `PostgreSQL 数据库迁移未完成（缺少迁移账本或 ${tableName}），请先在项目根目录运行 pnpm db:migrate`
    );
  }

  const migration = await pool.query<{ applied: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM public.pgmigrations LIMIT 1) AS applied"
  );
  if (!migration.rows[0]?.applied) {
    throw new Error("PostgreSQL 数据库迁移账本为空，请先在项目根目录运行 pnpm db:migrate");
  }
}
