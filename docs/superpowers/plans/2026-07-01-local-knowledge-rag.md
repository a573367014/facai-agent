# Local Knowledge RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal local Word/PDF knowledge base that indexes uploaded documents in the background and exposes ready chunks to the Agent through a hidden `knowledge_search` tool.

**Architecture:** Store document-level state and chunk-level searchable content in the existing SQLite store to avoid multiple writers. Upload routes enqueue indexing work, Worker consumes the job, and `knowledge_search` only retrieves chunks belonging to `ready` documents. The web app gets a small knowledge admin surface while chat remains focused on answers and sources.

**Tech Stack:** Fastify, BullMQ, sql.js SQLite, React, MUI, Vitest, `mammoth`, `pdf-parse`, OpenAI-compatible embeddings.

---

### Task 1: Knowledge Storage and Search Primitives

**Files:**
- Create: `apps/api/src/knowledge/types.ts`
- Create: `apps/api/src/knowledge/chunker.ts`
- Create: `apps/api/src/knowledge/vector.ts`
- Modify: `apps/api/src/agent/agent-store.ts`
- Modify: `apps/api/src/agent/sqlite-agent-store.ts`
- Test: `apps/api/test/knowledge/chunker.test.ts`
- Test: `apps/api/test/agent/sqlite-agent-store.test.ts`

- [ ] Add failing tests for chunk overlap, document status, ready-only chunk search, and deleting document chunks.
- [ ] Add knowledge document/chunk types and methods to the existing store interface.
- [ ] Add two SQLite tables: `knowledge_documents` and `knowledge_chunks`.
- [ ] Implement cosine similarity in TypeScript for the first local MVP.

### Task 2: Document Upload and Background Indexing

**Files:**
- Create: `apps/api/src/knowledge/document-parser.ts`
- Create: `apps/api/src/knowledge/embedding-service.ts`
- Create: `apps/api/src/knowledge/indexing-service.ts`
- Create: `apps/api/src/knowledge/knowledge-run-queue.ts`
- Create: `apps/api/src/routes/knowledge-routes.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/worker.ts`
- Modify: `apps/api/src/config/env.ts`
- Test: `apps/api/test/routes/knowledge-routes.test.ts`

- [ ] Add failing route tests for uploading a text-like document, listing status, and searching only after indexing completes.
- [ ] Save uploaded files under `uploads/knowledge`.
- [ ] Enqueue `knowledge-index-document` jobs after upload.
- [ ] Let Worker parse, chunk, embed, store chunks, and mark documents `ready` or `failed`.

### Task 3: Agent Tool Integration

**Files:**
- Create: `apps/api/src/tools/knowledge-search.ts`
- Modify: `apps/api/src/tools/index.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/tools/registry.test.ts`

- [ ] Add failing tests that registry exposes `knowledge_search` only when knowledge dependencies are configured.
- [ ] Implement tool args `{ query, limit? }`.
- [ ] Return full structured results plus compact LLM content with sources.
- [ ] Add system guidance that answers based on knowledge results should include sources.

### Task 4: Admin UI and Hidden Tool Trace

**Files:**
- Modify: `apps/web/src/api/agent-client.ts`
- Create: `apps/web/src/components/KnowledgeAdminPanel.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/utils/tool-traces.ts`
- Test: `apps/web/src/utils/tool-traces.test.ts`
- Test: `apps/web/src/App.test.tsx`

- [ ] Add API client functions for knowledge upload/list/delete/reindex/search.
- [ ] Add a compact management panel with upload, status list, delete, and reindex.
- [ ] Hide `knowledge_search` from visible chat tool traces.
- [ ] Keep citations in final answer text instead of rendering raw search calls.

### Task 5: Verification

**Files:**
- Modify as needed from earlier tasks.

- [ ] Run focused API and web tests.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Update README environment variable notes for embedding configuration.
