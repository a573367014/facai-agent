/**
 * PostgreSQL 实现层共享常量。
 *
 * 模块职责：集中维护 Postgres schema 与 store 在初始化、迁移、写入过程中需要引用的
 * "全局默认值"。把这些魔法值收敛到一处，是为了保证 schema 建表、数据迁移与默认值兜底
 * 三处口径完全一致——任何一处硬编码都可能在升级时造成数据不一致。
 *
 * 边界：这里只放与数据库存储相关的常量；业务侧（如 session 标题默认值）不在此处定义。
 */

/**
 * 未显式指定用户时的兜底 user_id。
 *
 * 早期 schema 的 agent_sessions 表没有 user_id 列；在引入多租户隔离时，存量数据需要被
 * 归并到一个"系统用户"下，避免 NULL 破坏 NOT NULL 约束。这里取一个固定字符串而非
 * NULL，是为了让历史会话仍能被统一查询，同时后续可按需迁移到真实用户。
 */
export const DEFAULT_SESSION_USER_ID = "user_system";
