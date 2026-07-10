# 项目文档入口

这里是当前项目文档的统一入口。代码位置、运行命令或架构边界不确定时，优先从本页进入，不要把历史实施计划当成当前事实。

## 当前文档

- [仓库地图](architecture/repository-map.md)：目录职责、依赖方向，以及“某类代码应该去哪里找”。
- [数据库迁移指南](guides/database-migrations.md)：创建、执行、验证和回滚 PostgreSQL 版本化迁移。
- [共享契约说明](../packages/contracts/README.md)：Web/API DTO 的边界与放置规则。
- [界面改版方案](2026-07-10-ui-redesign-proposal.md)：工作台改版判断、实现范围和验收标准。
- [界面验收截图](assets/ui-audit/README.md)：改版前后桌面端、窄屏和移动端的视觉证据。

## 历史设计记录

- [`superpowers/specs/`](superpowers/specs/)：功能设计时的方案快照。
- [`superpowers/plans/`](superpowers/plans/)：已经执行过的实施计划。

历史记录保留当时的文件路径和命令，可能与当前仓库不同。要确认现在的代码位置，以[仓库地图](architecture/repository-map.md)和实际源码为准。

## 文档放置约定

- 描述当前架构与长期有效约定：放入 `docs/architecture/`。
- 面向开发者的操作手册：后续统一放入 `docs/guides/`。
- 一次性方案或决策背景：放入带日期的文档，稳定后把结论回写到当前架构文档。
- 截图、示意图等文档附件：放入 `docs/assets/<主题>/`，不要放在仓库根目录。
