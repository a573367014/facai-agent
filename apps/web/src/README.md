# Web 源码地图

```text
src/
├── app/          # 页面装配、主题与有序的全局样式层
├── features/     # 身份验证、会话、聊天、资源、检查器与知识库
├── shared/       # 与业务无关的浏览器和 API 基础工具
├── test/         # 跨功能测试辅助工具
└── main.tsx      # React 入口
```

依赖方向为 `main → app → features → shared`。共享传输类型来自 `@agent/contracts`；各功能目录不应重复定义 HTTP 或 SSE 载荷。

组件、模型、API 函数及其测试应放入拥有对应行为的功能目录。跨功能代码应通过职责单一的模型或 API 暴露能力，不要在源码根目录重新创建 `components`、`utils` 或 `types` 目录。

`app/styles.css` 是稳定的样式导入入口。其导入顺序经过明确约定：先加载 `styles/legacy.css`，再加载 `styles/workspace-refresh.css`。后续应逐步把选择器迁移到所属功能目录，不要新增第三层全局覆盖样式。
