# 本地知识库 RAG 实施计划

> **面向智能体执行者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐项实施本计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 新增一个最小化的本地 Word/PDF 知识库，在后台为上传文档建立索引，并通过隐藏的 `knowledge_search` 工具向 Agent 提供已就绪的文本块。

**架构：** 在现有 SQLite 存储中保存文档级状态和文本块级可搜索内容，以避免多个写入方。上传路由将索引工作加入队列，Worker 消费任务，而 `knowledge_search` 只检索属于 `ready` 文档的文本块。Web 应用增加一个精简的知识库管理界面，同时让聊天继续聚焦于回答和来源。

**技术栈：** Fastify、BullMQ、sql.js SQLite、React、MUI、Vitest、`mammoth`、`pdf-parse`、OpenAI 兼容的嵌入模型接口。

---

### 任务 1：知识存储与搜索基础能力

**文件：**
- 创建：`apps/api/src/knowledge/types.ts`
- 创建：`apps/api/src/knowledge/chunker.ts`
- 创建：`apps/api/src/knowledge/vector.ts`
- 修改：`apps/api/src/agent/agent-store.ts`
- 修改：`apps/api/src/agent/sqlite-agent-store.ts`
- 测试：`apps/api/test/knowledge/chunker.test.ts`
- 测试：`apps/api/test/agent/sqlite-agent-store.test.ts`

- [ ] 为文本块重叠、文档状态、仅搜索就绪文本块和删除文档文本块编写失败测试。
- [ ] 向现有存储接口添加知识文档、文本块类型及方法。
- [ ] 添加两个 SQLite 表：`knowledge_documents` 和 `knowledge_chunks`。
- [ ] 使用 TypeScript 为首个本地最小可行版本实现余弦相似度。

### 任务 2：文档上传与后台索引

**文件：**
- 创建：`apps/api/src/knowledge/document-parser.ts`
- 创建：`apps/api/src/knowledge/embedding-service.ts`
- 创建：`apps/api/src/knowledge/indexing-service.ts`
- 创建：`apps/api/src/knowledge/knowledge-run-queue.ts`
- 创建：`apps/api/src/routes/knowledge-routes.ts`
- 修改：`apps/api/src/app.ts`
- 修改：`apps/api/src/worker.ts`
- 修改：`apps/api/src/config/env.ts`
- 测试：`apps/api/test/routes/knowledge-routes.test.ts`

- [ ] 为上传文本类文档、列出状态，以及仅在索引完成后搜索编写失败的路由测试。
- [ ] 将上传文件保存到 `uploads/knowledge` 下。
- [ ] 上传后将 `knowledge-index-document` 任务加入队列。
- [ ] 让 Worker 解析、切块、生成嵌入并存储文本块，再把文档标记为 `ready` 或 `failed`。

### 任务 3：Agent 工具集成

**文件：**
- 创建：`apps/api/src/tools/knowledge-search.ts`
- 修改：`apps/api/src/tools/index.ts`
- 修改：`apps/api/src/app.ts`
- 测试：`apps/api/test/tools/registry.test.ts`

- [ ] 添加失败测试，验证只有配置了知识库依赖时，注册表才会公开 `knowledge_search`。
- [ ] 实现工具参数 `{ query, limit? }`。
- [ ] 返回完整的结构化结果，以及带来源的精简 LLM 内容。
- [ ] 添加系统指引，要求基于知识库结果的回答包含来源。

### 任务 4：管理界面与隐藏工具轨迹

**文件：**
- 修改：`apps/web/src/api/agent-client.ts`
- 创建：`apps/web/src/components/KnowledgeAdminPanel.tsx`
- 修改：`apps/web/src/App.tsx`
- 修改：`apps/web/src/utils/tool-traces.ts`
- 测试：`apps/web/src/utils/tool-traces.test.ts`
- 测试：`apps/web/src/App.test.tsx`

- [ ] 添加知识库上传、列表、删除、重建索引和搜索的 API 客户端函数。
- [ ] 添加包含上传、状态列表、删除和重建索引的紧凑管理面板。
- [ ] 在可见的聊天工具轨迹中隐藏 `knowledge_search`。
- [ ] 在最终回答文本中保留引用，而不渲染原始搜索调用。

### 任务 5：验证

**文件：**
- 根据前面任务的需要进行修改。

- [ ] 运行聚焦的 API 和 Web 测试。
- [ ] 运行 `npm run typecheck`。
- [ ] 运行 `npm run build`。
- [ ] 更新 README 中有关嵌入配置的环境变量说明。
