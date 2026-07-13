# PostgreSQL 数据库迁移指南

数据库 schema 是应用代码依赖的一份持久化契约。代码可以随发布直接替换，数据库里却保留着历史数据，因此结构变化不能靠应用启动时反复执行 `CREATE TABLE IF NOT EXISTS` 猜测完成，必须留下有顺序、可审计的变更记录。

本项目使用 `node-pg-migrate`。迁移文件位于 `apps/api/migrations/`，执行记录保存在目标数据库的 `pgmigrations` 表中。

## 基本模型

每个迁移文件包含两个方向：

- `up`：从旧版本升级到新版本，例如加列、回填数据、创建索引。
- `down`：撤销该版本。它主要服务本地开发和刚发布后的紧急回退，不等于数据备份。

`node-pg-migrate` 按文件名前缀排序。执行成功后把文件名写入 `pgmigrations`；下次运行时只执行尚未登记的新文件。迁移默认放在事务中，并使用 PostgreSQL advisory lock，避免 API 和 Worker 同时迁移造成竞争。

## 日常命令

执行全部待运行迁移：

```bash
pnpm db:migrate
```

创建下一条迁移：

```bash
pnpm db:migration:create add-resource-owner
```

该命令只生成文件。编辑其中的 `up` 和 `down` 后，再执行 `pnpm db:migrate`。

回滚最近一条迁移：

```bash
pnpm db:rollback
```

基线迁移的 `down` 会删除全部业务表，只能用于一次性的空测试库验证。任何包含真实数据的数据库，回滚前都必须先备份并阅读对应迁移的 `down`。

## 一次结构变更的工作流

以给 `agent_resources` 增加 `owner_id` 为例：

1. 创建迁移文件，不要直接修改已经执行过的旧迁移。
2. 在 `up` 中先增加允许为空的新列。
3. 用 SQL 回填存量数据，并验证没有空值。
4. 再增加 `NOT NULL`、索引或外键约束。
5. 更新 Store 和领域代码，让新代码使用新结构。
6. 执行 `pnpm db:migrate`、API 测试和类型检查。
7. 将迁移文件与依赖它的代码放在同一个提交或同一次发布中。

生产发布顺序固定为：

```text
备份/快照 -> 执行迁移 -> 启动新 API/Worker -> 健康检查
```

多实例部署时只运行一个迁移 Job。应用进程本身不拥有修改 schema 的职责；全新数据库漏跑基线迁移时，Store 会在启动阶段提示运行 `pnpm db:migrate`。后续版本是否存在待执行迁移，应由部署流水线中的迁移步骤负责保证。

## 不可修改已执行迁移

迁移一旦进入共享环境，就视为不可变历史。修改旧文件会产生一种危险状态：数据库账本显示该版本已经执行，但真实结构与修改后的文件不一致。

发现旧迁移有问题时，始终创建一条新的修复迁移：

```bash
pnpm db:migration:create repair-resource-owner-index
```

## 破坏性变更

删除列、改类型和重命名不适合与应用代码一步完成。生产环境采用 expand / migrate / contract：

1. Expand：先新增结构，让新旧代码都能运行。
2. Migrate：回填数据，必要时双写并观察。
3. Contract：确认旧代码已下线后，再删除旧列或旧表。

`down` 也无法恢复已经被删除或覆盖的数据，所以“支持回滚”只代表能执行反向结构操作，不代表天然安全。

## 向量维度

当前 `knowledge_chunks.embedding` 固定为 `vector(768)`，与默认的 Ollama `embeddinggemma` 输出一致。向量维度属于数据库结构，不再由环境变量在 Store 启动时动态修改。

更换 Embedding 模型时需要单独迁移：先停止索引写入、备份或清空旧向量、删除 HNSW 索引、修改列维度、重新生成全部 embedding，最后重建索引。不能只改环境变量，否则同一迁移版本会在不同环境产生不同 schema。

## 测试

Vitest 的 global setup 会先对测试数据库执行所有迁移，因此测试不依赖 Store 自动建表。迁移本身还会验证：

- 基线版本已记录在 `pgmigrations`。
- 十张业务表全部存在。
- pgvector 列维度是 768。

测试库默认连接为 `postgres://postgres:postgres@localhost:5432/agent_test`，可以通过 `TEST_DATABASE_URL` 覆盖。目标数据库不存在时，测试初始化会通过同一连接账号自动创建；该账号需要拥有 `CREATEDB` 权限。
