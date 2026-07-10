# 仓库地图

本仓库是由 pnpm 工作区管理的模块化单体，包含 Web 工作台、API、工作进程，以及只在开发阶段使用的工具。目录首先按“产品与业务职责”划分，再在业务内部按技术角色细分。

## 顶层目录

```text
.
├── apps/
│   ├── api/                 # Fastify API、BullMQ 工作进程、智能体运行时
│   └── web/                 # React 工作台
├── packages/
│   └── contracts/           # Web 和 API 共享的 HTTP 与 SSE DTO
├── docs/                    # 当前架构、历史方案和文档资产
├── observability/           # Grafana / OTel 本地配置
├── tools/
│   ├── dev/                 # 启动前的本地依赖检查
│   ├── confluence-import/   # Confluence 知识库导入
│   └── loadtest/            # k6 与模拟大语言模型压测工具
├── docker-compose.yml
├── package.json             # 根编排命令，不承载应用运行时依赖
├── pnpm-lock.yaml           # 唯一依赖锁文件
└── pnpm-workspace.yaml
```

`node_modules/`、`dist/`、`data/`、根目录 `var/` 和 `.pnpm-store/` 都是本地依赖、构建或运行产物，不是源码入口。

`packages/contracts` 只描述跨进程传输边界。数据库记录、业务服务和运行时实现必须留在所属应用；API 通过显式映射器将内部模型转换为 DTO，避免把 `userId`、`sourcePath` 等内部字段透传给浏览器。

## Web：按功能找代码

```text
apps/web/src/
├── main.tsx                 # Vite/React 启动入口
├── app/                     # 页面装配、全局主题和全局样式
│   ├── App.tsx
│   ├── theme/
│   └── styles/              # 旧版基线与工作区刷新样式分层
├── features/
│   ├── auth/                # 登录态与鉴权 API
│   ├── sessions/            # 会话列表
│   ├── chat/                # 消息、对话、编辑器和流式交互
│   ├── resources/           # 附件、资源画廊与预览
│   ├── inspector/           # 事件面板、工具轨迹与结果
│   └── knowledge/           # 知识库管理
├── shared/
│   └── api/                 # API 基础地址、追踪与通用错误类型
└── test/                    # 跨功能测试基础设施
```

依赖方向是 `main → app → features → shared`。`app` 负责组合页面，业务实现放在相应功能目录；`shared` 只能承载真正跨业务且不理解产品语义的基础能力。不要重新创建平铺的 `components/`、`utils/` 或 `types/` 大目录。

Web 测试尽量和被测文件放在一起。源码导入优先使用 `@/` 别名，避免目录移动时维护多层 `../../`。新增接口时，DTO 来自 `@agent/contracts`，调用函数进入 `features/<功能>/api`；令牌刷新与鉴权请求放在 `features/auth/api`，智能体 SSE 放在 `features/chat/api`，只有无业务语义的 URL、追踪和错误工具进入 `shared/api`。

## API：按边界找代码

```text
apps/api/src/
├── entrypoints/
│   ├── server.ts            # HTTP 进程入口
│   └── worker.ts            # BullMQ 工作进程入口
├── bootstrap/
│   ├── app.ts               # Fastify、鉴权与 HTTP 路由装配
│   └── runtime-container.ts # API 与工作进程共用的智能体执行运行时
├── modules/
│   ├── agent/               # 运行任务、消息、投影、上下文与智能体运行时
│   │   ├── http/            # 智能体 HTTP 路由
│   │   ├── providers/       # 模型提供方端口
│   │   └── runtime/         # LangChain/LangGraph 适配
│   ├── auth/                # OAuth、令牌、用户端口与鉴权路由
│   ├── knowledge/           # 文档解析、切块、嵌入向量与检索
│   └── tools/               # 工具注册、策略与具体工具
├── platform/
│   ├── config/              # 环境变量与 CORS
│   ├── observability/       # OpenTelemetry
│   ├── postgres/            # PostgreSQL 适配器
│   ├── redis/               # Redis/BullMQ 运行时适配器
│   └── storage/             # 上传与 S3 兼容对象存储
└── shared/
    ├── errors/              # 跨模块错误模型
    └── http/                # 不属于业务模块的基础路由
```

依赖方向是 `entrypoints → bootstrap → modules → platform/shared`。业务规则和端口放在 `modules`，PostgreSQL、Redis、S3、OTel 等实现细节放在 `platform`；入口文件只启动进程，跨模块实例的创建集中在 `bootstrap`。HTTP 入口使用 `buildApp`，工作进程直接使用 `createWorkerRuntimeContainer`，不会加载 Fastify、鉴权、多部分表单或静态文件插件。

API 测试位于 `apps/api/test/`，按 `agent`、`auth`、`knowledge`、`routes`、`tools` 等业务边界查找。

## 常见需求定位

| 想修改的内容 | Web | API |
| --- | --- | --- |
| 登录、令牌刷新 | `features/auth` | `modules/auth` |
| 会话列表、选择会话 | `features/sessions` | `modules/agent/http`、智能体存储端口 |
| 对话消息、输入框、流式状态 | `features/chat` | `modules/agent` |
| 附件上传、资源预览 | `features/resources` | `platform/storage`、`modules/agent` |
| 事件检查器、工具轨迹 | `features/inspector` | `modules/agent`、`platform/observability` |
| 知识库上传、索引、检索 | `features/knowledge` | `modules/knowledge` |
| HTTP/SSE 基础传输 | `shared/api` | 各模块 `http/` 与 `modules/agent/agent-event-bus.ts` |
| 前后端共享 DTO | `packages/contracts` | `packages/contracts` |
| 模型与 LangGraph 执行 | — | `modules/agent/runtime` |
| 工具注册或新增工具 | — | `modules/tools` |
| 数据库、Redis、对象存储 | — | `platform/postgres`、`platform/redis`、`platform/storage` |
| 启动、依赖装配、环境配置 | `main.tsx`、`app` | `entrypoints`、`bootstrap`、`platform/config` |

## 开发工具

- `pnpm dev`：检查 Redis、Ollama、观测服务，随后启动 API、Web 和工作进程。
- `pnpm test`：先运行 `tools` 测试，再运行两个应用的测试。
- `pnpm typecheck`：检查共享契约和两个应用；`pnpm build` 构建两个可运行应用。
- `pnpm confluence:ingest --help`：查看 Confluence 导入参数。
- `pnpm mock:llm`、`pnpm loadtest`：运行压测辅助服务和 k6 场景。

根 `package.json` 只保留工作区编排依赖。某个包只被 API 或 Web 使用时，依赖必须声明在对应应用的 `package.json` 中。

## 新代码放置检查

1. 先判断它属于哪个业务功能或模块，再决定技术子目录。
2. 只有至少两个业务域都需要、且不包含业务语义时，才放入 `shared`。
3. 外部系统的实现细节进入 API `platform`，接口或业务规则留在 `modules`。
4. 跨进程 DTO 进入 `packages/contracts`；数据库结构不得进入契约包。
5. 保持测试靠近对应业务边界；移动源码时同步移动或修正测试引用。
6. 目录变化后更新本地图，不让 README、文档与实际代码再次分叉。
