# API 源码目录结构
本 API 代码分层遵循「运行时边界优先、业务能力次之」的组织原则。

```text
src/
├── entrypoints/             # HTTP 服务、任务队列工作进程等程序入口
├── bootstrap/               # Fastify 实例初始化、依赖注入组装逻辑
├── modules/
│   ├── agent/              # 会话、任务执行、消息与智能体运行时核心
│   │   ├── http/           # 智能体相关 HTTP 接口路由
│   │   ├── providers/      # 大模型厂商对接抽象契约
│   │   └── runtime/        # LangChain / LangGraph 集成层
│   ├── auth/               # 身份校验、GitHub OAuth 登录能力
│   ├── knowledge/          # 文档向量索引、知识库检索
│   └── tools/              # 工具定义、注册中心、工具执行逻辑
├── platform/
│   ├── config/             # 环境变量、跨域 CORS 配置
│   ├── observability/      # OpenTelemetry 可观测性、链路追踪工具类
│   ├── postgres/           # Postgres 数据库适配器
│   ├── redis/              # Redis 实例与业务适配器
│   └── storage/            # 文件上传、兼容 S3 对象存储逻辑
└── shared/                  # 通用错误封装、HTTP 公共工具（跨模块复用）
```

## 核心入口文件说明
- `entrypoints/server.ts`：启动 HTTP 接口服务
- `entrypoints/worker.ts`：启动 BullMQ 队列消费工作进程，不开启 HTTP 应用
- `bootstrap/app.ts`：实例化 Fastify，统一管理 HTTP 插件、鉴权、生命周期钩子与路由挂载
- `bootstrap/runtime-container.ts`：组装智能体和知识库运行时，管控数据库、Redis、消息队列生命周期
- `modules/*/http/*-response-mappers.ts`：内部数据库实体映射为 `@agent/contracts` 标准传输对象（DTO）

## 代码存放规范
1. 业务逻辑统一归属对应业务模块，模块内路由也放置在该模块下
2. 程序启动逻辑仅放在 `entrypoints`，依赖组装逻辑仅放在 `bootstrap`
3. HTTP 服务与队列工作进程统一复用 `runtime-container.ts`；工作进程禁止调用 `buildApp()` 初始化 HTTP 应用
4. HTTP 接口层必须做数据映射，禁止直接透传数据库私有字段给前端
5. 数据库、消息队列、对象存储、配置、可观测性相关适配器统一放在 `platform`
6. 只有无归属业务模块的通用工具、常量、类型才放入 `shared`
7. 测试代码按业务能力归类至 `test/` 目录，直接导入源码对应路径下的生产代码

## 依赖引用约束
所有业务模块（`modules`）、底层平台层（`platform`）、通用工具层（`shared`）**禁止反向引入** `bootstrap`、`entrypoints` 目录代码，依赖流向统一由入口向外。
