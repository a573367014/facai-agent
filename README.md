# facai-agent

一个基于 Node.js Fastify 和 React 的工具调用型 Agent Demo。

## 结构

- `apps/api`：Fastify Agent API
- `apps/web`：React Demo 工作台

## 环境变量

复制 `.env.example` 为 `.env`，并填写：

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `AGENT_STORE`：`memory` 或 `sqlite`
- `AGENT_SQLITE_PATH`：SQLite 文件路径，默认 `./data/agent.sqlite`

## 安装

```bash
npm install
```

## 开发

同时启动 API 和 Web：

```bash
npm run dev
```

也可以单独启动 API：

```bash
npm run dev:api
```

单独启动 Web：

```bash
npm run dev:web
```

访问：

- API: `http://localhost:4001`
- Web: `http://localhost:4000`

## 测试

```bash
npm run test
npm run typecheck
npm run build
```
