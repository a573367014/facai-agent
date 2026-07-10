/**
 * 采用 node-pg-migrate 之前的数据库基线。
 *
 * 这条迁移刻画“当前代码需要的完整 schema”，而不是伪造项目过去每一次结构变化。
 * CREATE ... IF NOT EXISTS 让已有本地数据库可以被安全纳管；迁移成功后，
 * node-pg-migrate 会把文件名写入 pgmigrations，未来只执行新增迁移。
 */

const VECTOR_DIMENSION = 768;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export async function up(pgm) {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS vector');
  pgm.sql('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS users (
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
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'user_system',
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      seq SERIAL
    )
  `);
  // 早期本地库可能已有 agent_sessions，但还没有用户隔离列。
  pgm.sql(`
    ALTER TABLE agent_sessions
    ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'user_system'
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS agent_messages (
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
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS agent_runs (
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
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS agent_session_summaries (
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
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS agent_tool_calls (
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
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS agent_resources (
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
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS agent_process_steps (
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
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS knowledge_documents (
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
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      source_label TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding vector(${VECTOR_DIMENSION}),
      metadata_json JSONB,
      created_at TEXT NOT NULL,
      seq SERIAL
    )
  `);

  // 一个 migration 版本必须对应唯一结构。空的旧测试库可以自动对齐维度；
  // 有向量数据的库则明确失败，要求先决定如何重算 embedding，避免静默丢数据。
  pgm.sql(`
    DO $migration$
    DECLARE
      current_dimension INTEGER;
    BEGIN
      SELECT atttypmod INTO current_dimension
      FROM pg_attribute
      WHERE attrelid = 'knowledge_chunks'::regclass
        AND attname = 'embedding';

      IF current_dimension IS DISTINCT FROM ${VECTOR_DIMENSION} THEN
        IF EXISTS (SELECT 1 FROM knowledge_chunks LIMIT 1) THEN
          RAISE EXCEPTION
            'knowledge_chunks.embedding 当前维度为 %，目标维度为 ${VECTOR_DIMENSION}；请先备份并创建显式的向量重建迁移',
            current_dimension;
        END IF;

        DROP INDEX IF EXISTS idx_knowledge_chunks_embedding_hnsw;
        ALTER TABLE knowledge_chunks
          ALTER COLUMN embedding TYPE vector(${VECTOR_DIMENSION});
      END IF;
    END
    $migration$;
  `);

  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_users_github_login ON users (github_login)",
    "CREATE INDEX IF NOT EXISTS idx_users_updated_at ON users (updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_updated_at ON agent_sessions (user_id, updated_at, seq)",
    "CREATE INDEX IF NOT EXISTS idx_agent_messages_session_id_created_at ON agent_messages (session_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_agent_runs_session_id_created_at ON agent_runs (session_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_session_id_started_at ON agent_tool_calls (session_id, started_at)",
    "CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_message_id_tool_call_id ON agent_tool_calls (message_id, tool_call_id)",
    "CREATE INDEX IF NOT EXISTS idx_agent_resources_message_id_created_at ON agent_resources (message_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_agent_resources_session_id_created_at ON agent_resources (session_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_agent_process_steps_message_order ON agent_process_steps (message_id, order_index)",
    "CREATE INDEX IF NOT EXISTS idx_knowledge_documents_status_updated_at ON knowledge_documents (status, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document_id_index ON knowledge_chunks (document_id, chunk_index)",
    "CREATE INDEX IF NOT EXISTS idx_agent_session_summaries_session_version ON agent_session_summaries (session_id, version)",
    "CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_hnsw ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)"
  ];

  for (const sql of indexes) {
    pgm.sql(sql);
  }
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export async function down(pgm) {
  // 基线回滚会删除全部业务数据，只适合本地验证；生产回滚前必须先做备份。
  pgm.sql(`
    DROP TABLE IF EXISTS
      knowledge_chunks,
      knowledge_documents,
      agent_process_steps,
      agent_resources,
      agent_tool_calls,
      agent_session_summaries,
      agent_runs,
      agent_messages,
      agent_sessions,
      users
    CASCADE
  `);

  // vector/uuid-ossp 可能被同库其他 schema 使用，迁移回滚不删除共享扩展。
}
