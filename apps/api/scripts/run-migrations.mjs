import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { runner } from "node-pg-migrate";

const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/agent";
const rootEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
const apiEnvPath = fileURLToPath(new URL("../.env", import.meta.url));
const migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

config({ path: rootEnvPath, quiet: true });
config({ path: apiEnvPath, quiet: true });

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  throw new Error("迁移方向必须是 up 或 down");
}

await runner({
  databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  dir: migrationsDirectory,
  direction,
  count: direction === "down" ? 1 : undefined,
  migrationsTable: "pgmigrations",
  schema: "public",
  checkOrder: true,
  singleTransaction: true,
  dryRun: process.argv.includes("--dry-run"),
  verbose: true
});
