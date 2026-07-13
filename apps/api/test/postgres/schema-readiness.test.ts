import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { assertPostgresSchemaReady } from "../../src/platform/postgres/schema-readiness.js";

function mockPool(...rows: object[]): Pool {
  const query = vi.fn();
  for (const row of rows) {
    query.mockResolvedValueOnce({ rows: [row] });
  }
  return { query } as unknown as Pool;
}

describe("PostgreSQL schema readiness", () => {
  it("拒绝只有旧业务表但没有迁移账本的数据库", async () => {
    const pool = mockPool({ migrations: null, required_table: "agent_sessions" });

    await expect(assertPostgresSchemaReady(pool, "agent_sessions")).rejects.toThrow(/pnpm db:migrate/);
  });

  it("拒绝迁移账本存在但没有成功版本记录的数据库", async () => {
    const pool = mockPool(
      { migrations: "pgmigrations", required_table: "agent_sessions" },
      { applied: false }
    );

    await expect(assertPostgresSchemaReady(pool, "agent_sessions")).rejects.toThrow(/迁移账本为空/);
  });

  it("迁移账本和依赖表都就绪时允许 Store 启动", async () => {
    const pool = mockPool(
      { migrations: "pgmigrations", required_table: "agent_sessions" },
      { applied: true }
    );

    await expect(assertPostgresSchemaReady(pool, "agent_sessions")).resolves.toBeUndefined();
  });
});
