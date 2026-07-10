import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agent_test";
const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL migrations", () => {
  it("记录基线版本并创建完整业务 schema", async () => {
    const migration = await pool.query<{ name: string }>(
      "SELECT name FROM pgmigrations WHERE name = $1",
      ["20260710060000000_initial-schema"]
    );
    expect(migration.rows).toEqual([{ name: "20260710060000000_initial-schema" }]);

    const tables = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'users',
          'agent_sessions',
          'agent_messages',
          'agent_runs',
          'agent_tool_calls',
          'agent_resources',
          'agent_process_steps',
          'agent_session_summaries',
          'knowledge_documents',
          'knowledge_chunks'
        )
      ORDER BY table_name
    `);
    expect(tables.rowCount).toBe(10);

    const dimension = await pool.query<{ dimension: number }>(`
      SELECT atttypmod AS dimension
      FROM pg_attribute
      WHERE attrelid = 'knowledge_chunks'::regclass
        AND attname = 'embedding'
    `);
    expect(dimension.rows[0]?.dimension).toBe(768);
  });
});
