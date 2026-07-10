/**
 * PostgreSQL schema 初始化与在线迁移。
 *
 * 模块职责：在 store 启动时保证数据库结构"就绪"——建表、建索引、做必要的列级迁移。
 * 这是一个"幂等自举"模块：无论库是空的、是旧版本、还是最新版本，执行后都应收敛到
 * 一个可用且一致的状态。因此所有 DDL 都使用 IF NOT EXISTS / IF EXISTS 这类防御性写法。
 *
 * 边界：本模块只负责"结构"，不负责任何业务读写；也不做数据回填，只在结构变化导致
 * 语义不一致时（如 user_id 缺失）清空相关数据以保证安全。
 *
 * 设计取舍：没有引入独立的 migration 工具（如 knex/umzug），而是用代码内联的
 * 增量 DDL。原因是表结构相对稳定，且 store 需要在无外部脚本的前提下自启动；
 * 代价是迁移能力较弱，复杂的 schema 变更仍需人工介入。
 */
import type { Pool, QueryResultRow } from "pg";
import { DEFAULT_SESSION_USER_ID, DEFAULT_VECTOR_DIMENSION } from "./constants.js";

/**
 * 执行一条无参数的 DDL/DML 语句（建表、建索引、ALTER 等）。
 * 这些语句都是结构变更，不涉及用户输入，因此不需要参数化。
 */
async function execute(pool: Pool, sql: string): Promise<void> {
  await pool.query(sql);
}

/**
 * 执行一条无参数查询并仅取首行。
 * 主要用于 information_schema / pg_attribute 的探测式查询（检查列/表是否存在、读取列类型）。
 */
async function queryOne<T extends QueryResultRow>(pool: Pool, sql: string): Promise<T | undefined> {
  const result = await pool.query<T>(sql);
  return result.rows[0];
}

/**
 * 确保 agent_sessions 表具备 user_id 列（多租户隔离字段）。
 *
 * 为什么这么做：早期版本没有 user_id，所有会话混在一起；引入用户隔离后，需要给存量库补列。
 * 为什么不顺带迁移数据：历史数据无法判断归属哪个真实用户，强行分配会越权；因此选择
 * "清空所有引用了 session 的关联表 + 给新列一个系统兜底默认值"，保证升级后结构一致、
 * 且不会出现 NULL 破坏 NOT NULL 约束。
 *
 * 为什么 TRUNCATE 要 CASCADE：agent_runs / agent_messages 等表通过 session_id 关联，
 * 这里按依赖顺序显式列出，配合 RESTART IDENTITY 把自增 seq 也重置，避免新旧数据 seq 错位。
 *
 * 不这么做会怎样：若直接 ADD COLUMN NOT NULL 而无默认值，存量行会因无值而报错；
 * 若不清空关联数据，则旧会话会被错误地归属到默认用户，造成越权读取。
 */
async function ensureAgentSessionUserScope(pool: Pool): Promise<void> {
  const row = await queryOne<{ exists: boolean }>(
    pool,
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_name = 'agent_sessions'
         AND column_name = 'user_id'
     ) AS exists`
  );

  if (row?.exists) {
    return;
  }

  await execute(
    pool,
    `TRUNCATE TABLE agent_resources,
                    agent_tool_calls,
                    agent_process_steps,
                    agent_session_summaries,
                    agent_runs,
                    agent_messages,
                    agent_sessions
     RESTART IDENTITY CASCADE`
  );
  await execute(
    pool,
    `ALTER TABLE agent_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT '${DEFAULT_SESSION_USER_ID}'`
  );
}

/**
 * 在线迁移 knowledge_chunks.embedding 的向量维度。
 *
 * 为什么需要：更换 Embedding 模型会导致向量维度变化（如 768 -> 1024），而 pgvector 的
 * vector(n) 是定长类型，维度不匹配时写入会直接报错。
 *
 * 实现要点：
 * - 通过 pg_attribute.atttypmod 读取当前列的实际维度（vector 类型的 typmod 即维度）；
 * - 维度已一致则跳过，保证幂等；
 * - 改维度前必须先 DROP HNSW 索引：HNSW 索引绑定具体维度，ALTER TYPE 会因索引依赖而失败；
 * - 注意：ALTER TYPE vector(N) 对存量向量数据是"有损"的——pgvector 无法自动重新生成
 *   embedding，旧向量在维度变更后语义失效，需要业务侧重跑索引。这里只保证结构可用。
 *
 * 边界：仅在外部显式传入 vectorDimension 时调用（见 initializePostgresAgentStoreSchema）。
 */
async function migrateVectorDimension(pool: Pool, vectorDimension: number): Promise<void> {
  const row = await queryOne<{ dimension: number }>(
    pool,
    `SELECT atttypmod AS dimension
     FROM pg_attribute
     WHERE attrelid = 'knowledge_chunks'::regclass
       AND attname = 'embedding'`
  );

  if (!row || row.dimension === vectorDimension) {
    return;
  }

  await execute(pool, `DROP INDEX IF EXISTS idx_knowledge_chunks_embedding_hnsw`);
  await execute(pool, `ALTER TABLE knowledge_chunks ALTER COLUMN embedding TYPE vector(${vectorDimension})`);
}

/**
 * 创建业务查询所需的全部索引（幂等）。
 *
 * 设计原则：所有索引都用 IF NOT EXISTS，保证可重复执行。索引覆盖了两类高频访问路径：
 * 1) 按 session 维度的列表/游标分页（session_id + 时间戳 + seq）；
 * 2) 按消息定位关联数据（message_id + tool_call_id 等）。
 *
 * 关键索引说明：
 * - 带 seq 的复合索引用于游标分页的稳定排序（created_at 可能重复，seq 作为 tie-breaker）；
 * - idx_knowledge_chunks_embedding_hnsw 是向量检索的核心：HNSW 近似最近邻索引，
 *   vector_cosine_ops 指定使用余弦距离，与 searchKnowledgeChunks 中的 <=> 算子对应。
 *   没有它，向量检索会退化为全表扫描，在大数据量下不可用。
 */
async function createIndexes(pool: Pool): Promise<void> {
  await execute(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_updated_at
     ON agent_sessions (user_id, updated_at, seq)`
  );
  await execute(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_agent_messages_session_id_created_at
     ON agent_messages (session_id, created_at)`
  );
  await execute(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_session_id_created_at
     ON agent_runs (session_id, created_at)`
  );
  await execute(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_session_id_started_at
     ON agent_tool_calls (session_id, started_at)`
  );
  await execute(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_message_id_tool_call_id
     ON agent_tool_calls (message_id, tool_call_id)`
  );
  await execute(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_agent_resources_message_id_created_at
     ON agent_resources (message_id, created_at)`
  );
  await execute(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_agent_resources_session_id_created_at
     ON agent_resources (session_id, created_at)`
  );
  await execute(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_agent_process_steps_message_order
     ON agent_process_steps (message_id, order_index)`
  );
  await execute(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_documents_status_updated_at
     ON knowledge_documents (status, updated_at)`
  );
  await execute(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document_id_index
     ON knowledge_chunks (document_id, chunk_index)`
  );
  await execute(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_agent_session_summaries_session_version
     ON agent_session_summaries (session_id, version)`
  );
  await execute(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_hnsw
     ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)`
  );
}

/**
 * Store 启动时的 schema 自举入口（幂等）。
 *
 * 执行顺序有严格依赖关系，不能随意调整：
 * 1) 先 CREATE EXTENSION：vector（pgvector 向量类型）、uuid-ossp（uuid 生成），
 *    后续建表/建索引依赖这些扩展存在；
 * 2) 再 CREATE TABLE IF NOT EXISTS 建立全部业务表——全部幂等，已存在则跳过；
 * 3) knowledge_chunks 的 embedding 维度取 effectiveDimension（显式参数优先，否则默认值），
 *    首次建表即按该维度创建列；
 * 4) 若外部显式传入 vectorDimension，则触发 migrateVectorDimension 做维度对齐
 *    （首次建表维度已一致，迁移会直接跳过；仅旧库需要真正迁移）；
 * 5) ensureAgentSessionUserScope 补齐多租户列；
 * 6) 最后 createIndexes——索引必须放在建表之后，否则引用的表不存在。
 *
 * 幂等性：每一步都是"检查后执行"或"IF NOT EXISTS"，因此多次调用安全，
 * 适合在 store 构造时无条件执行。
 *
 * @param pool 已建立的连接池
 * @param vectorDimension 可选的目标向量维度；不传则使用 DEFAULT_VECTOR_DIMENSION 且不触发迁移
 */
export async function initializePostgresAgentStoreSchema(pool: Pool, vectorDimension?: number): Promise<void> {
  await execute(pool, `CREATE EXTENSION IF NOT EXISTS vector`);
  await execute(pool, `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

  await execute(
    pool,
    `CREATE TABLE IF NOT EXISTS agent_sessions (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL DEFAULT '${DEFAULT_SESSION_USER_ID}',
       title TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       seq SERIAL
     )`
  );

  await execute(
    pool,
    `CREATE TABLE IF NOT EXISTS agent_messages (
       id TEXT PRIMARY KEY,
       session_id TEXT NOT NULL,
       role TEXT NOT NULL,
       status TEXT NOT NULL,
       parts_json JSONB NOT NULL DEFAULT '[]',
       max_iterations INTEGER,
       error_json JSONB,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       completed_at TEXT,
       seq SERIAL
     )`
  );

  await execute(
    pool,
    `CREATE TABLE IF NOT EXISTS agent_runs (
       id TEXT PRIMARY KEY,
       session_id TEXT NOT NULL,
       status TEXT NOT NULL,
       phase TEXT NOT NULL,
       user_message_id TEXT,
       system_message_id TEXT,
       assistant_message_id TEXT,
       error_json JSONB,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       completed_at TEXT,
       seq SERIAL
     )`
  );

  await execute(
    pool,
    `CREATE TABLE IF NOT EXISTS agent_session_summaries (
       id TEXT PRIMARY KEY,
       session_id TEXT NOT NULL,
       version INTEGER NOT NULL,
       summary_json JSONB NOT NULL,
       covered_message_id TEXT NOT NULL,
       covered_message_created_at TEXT NOT NULL,
       source_summary_id TEXT,
       schema_version INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       seq SERIAL
     )`
  );

  await execute(
    pool,
    `CREATE TABLE IF NOT EXISTS agent_tool_calls (
       id TEXT PRIMARY KEY,
       session_id TEXT NOT NULL,
       run_id TEXT,
       message_id TEXT NOT NULL,
       iteration INTEGER NOT NULL,
       tool_call_id TEXT,
       tool_name TEXT NOT NULL,
       status TEXT NOT NULL,
       arguments_json JSONB NOT NULL DEFAULT '{}',
       result_summary_json JSONB,
       error_json JSONB,
       started_at TEXT NOT NULL,
       completed_at TEXT,
       duration_ms INTEGER,
       seq SERIAL
     )`
  );

  await execute(
    pool,
    `CREATE TABLE IF NOT EXISTS agent_resources (
       id TEXT PRIMARY KEY,
       session_id TEXT NOT NULL,
       message_id TEXT NOT NULL,
       tool_call_row_id TEXT,
       tool_call_id TEXT,
       type TEXT NOT NULL,
       mime TEXT,
       url TEXT,
       name TEXT,
       status TEXT NOT NULL,
       width INTEGER,
       height INTEGER,
       metadata_json JSONB,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       seq SERIAL
     )`
  );

  await execute(
    pool,
    `CREATE TABLE IF NOT EXISTS agent_process_steps (
       id TEXT PRIMARY KEY,
       session_id TEXT NOT NULL,
       run_id TEXT,
       message_id TEXT NOT NULL,
       tool_call_row_id TEXT,
       tool_call_id TEXT,
       kind TEXT NOT NULL,
       title TEXT,
       summary TEXT,
       status TEXT NOT NULL,
       order_index INTEGER NOT NULL,
       metadata_json JSONB,
       started_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       completed_at TEXT,
       seq SERIAL
     )`
  );

  await execute(
    pool,
    `CREATE TABLE IF NOT EXISTS knowledge_documents (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       source_path TEXT NOT NULL,
       mime_type TEXT NOT NULL,
       status TEXT NOT NULL,
       error_message TEXT,
       content_hash TEXT NOT NULL,
       chunk_count INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       indexed_at TEXT,
       seq SERIAL
     )`
  );

  const effectiveDimension = vectorDimension ?? DEFAULT_VECTOR_DIMENSION;

  await execute(
    pool,
    `CREATE TABLE IF NOT EXISTS knowledge_chunks (
       id TEXT PRIMARY KEY,
       document_id TEXT NOT NULL,
       chunk_index INTEGER NOT NULL,
       content TEXT NOT NULL,
       source_label TEXT NOT NULL,
       embedding_model TEXT NOT NULL,
       embedding vector(${effectiveDimension}),
       metadata_json JSONB,
       created_at TEXT NOT NULL,
       seq SERIAL
     )`
  );

  if (vectorDimension !== undefined) {
    await migrateVectorDimension(pool, vectorDimension);
  }

  await ensureAgentSessionUserScope(pool);
  await createIndexes(pool);
}
