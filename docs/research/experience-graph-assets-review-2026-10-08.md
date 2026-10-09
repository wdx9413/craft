# Experience Graph：场景资产、存储与持续迭代

2026-10-08。用户确认对外统一称 Graph，Workflow 是其中一种流程形式。已实现统一资产目录及编辑闭环，版本保持 0.12.39；本机用户数据及安装缓存未迁移。

## 当前事实

- [Runtime 的互联网产研模板](../../capability/craft-experience/procedure-templates.ts)是候选模板，不是用户当前生效的场景定义。模板已经移出 Skill，由 `craft_experience_graph_inspect(action: template)` 提供；更新插件不能覆盖用户资产，模板也不能授权运行。
- [配置保存](../../capability/craft-experience/procedure-configuration.ts)通过 `craft_procedure_configuration_save` 校验定义、作用域和 `expected_version`，产生新内容版本，清除旧晋级门禁，保留为候选。
- [定义存储](../../capability/craft-experience/procedure-definition.ts)已有不可变 JSON、内容摘要和数据库引用。新定义统一位于 `~/.craft_data/experience/graph/<graph-id>/versions/`；历史 `procedures/workflows/` 和 `procedures/graphs/` 引用保持兼容。新建目录直接使用可移植的英文 graph_id（例如 product-development），不附加摘要，改显示标题不换身份；旧摘要目录保持兼容；数据根可以由 `CRAFT_DATA_DIR` 或设置覆盖。它没有把持续演化的定义写回插件 Skill。
- [Skill 导出](../../capability/craft-experience/procedure-projection.ts)可导出一个已晋级资产的 `SKILL.md` 与相邻 `PROCEDURE.json`，默认禁用；导出是固定版本的分发快照，持续迭代仍属于受管理资产。
- 当前同一场景可声明子场景、命名入口/出口、合法路径、有界返工和固定版本子 Workflow。配置版本漂移需要重新规划；不自动迁移活动 Invocation。

## 目标组织

对外的场景资产统一叫 Experience Graph。Workflow 是线性或受限组合的流程形式；Prompt Procedure 继续是短指引，不强行转换成图。运行中的 Invocation、Trace、验收和资产定义分别保留。

采用用户提出的单数目录 `experience/graph/`，按稳定资产 ID 组织，而不是以标题作为身份：

```text
$CRAFT_DATA_DIR/experience/
  experience.db
  graph/
    <graph-id>/
      graph.yml
      draft.json
      versions/
        000001.json
        000002.json
```

默认数据根是 `~/.craft_data`。`graph.yml` 只记录 `current_version` 和 `test_version` 两个 JSON 内容版本，缺省为 null；提交、晋级、恢复、导入和读取时按账本重建。它是可恢复的状态视图，手改不能启用版本；已有手工 README 保留，新资产不再自动生成说明文件。`draft.json` 是可编辑工作稿，不是生效定义；版本 JSON 是内容权威，数据库保存范围、引用、摘要、当前候选/生效版本、门禁和历史账本。工作稿不能直接被执行，插件升级也不能覆盖它。读取当前版本通过受治理接口，不增加一个独立的可编辑 `current.json` 事实源。

已落地此布局。`migrate` 分页复制受范围及当前 ACL 保护的历史内容版本，保留旧文件、摘要和引用；重试幂等。活动运行不换定义，不直接移动已被引用的文件。目录变化不要求把现有 `craft.procedure.v1` 和 `procedure_kind: workflow` 全部立即改名：先由适配层兼容现有协议，再逐步统一对外术语。

## 本轮能力与后续扩展

| 优先级 | 能力 | 实现与验收条件 |
| --- | --- | --- |
| P0 | 场景资产发现与编辑闭环 | 已支持按 scope + scenario 找到 graph ID、当前候选/可用版本及来源；门禁原因通过既有 asset inspect/explain 查看；同一 ID 提交修改生成新版本，明确 CAS 冲突；已有保存/历史接口复用。 |
| P0 | 工作稿导入与检查 | 已提供 JSON Schema 和 Runtime 合同错误，关系校验包含字段索引；导入先预览差异，再校验保存；直接修改版本文件明确报摘要漂移，不能静默成为新版本。已实现配置对象/JSON 字符串导入、工作稿读取、Schema 与合同校验、差异及摘要提交。 |
| P0 | 安全目录迁移 | 已实现新建资产进入 `experience/graph/`；旧文件继续可读；迁移绑定 ID、scope、digest，保留活动/历史运行；中断、并发修改、符号链接和跨根路径拒绝都有验证。 |
| P1 | 区分关系语义 | 已实现可执行转换与 `depends_on`、`supports`、`contradicts` 的类型区分；只有执行边参与 Invocation。现有控制图不能被描述成任意经验关系图已经可用。 |
| P1 | 变化影响与再验收 | 已显示变动节点/边、受影响子场景及待重验门禁；固定版本子调用变动作为节点变化处理。当前修改后清除旧门禁是保守保护，应保留；增量复用验收必须先证明依赖未变。 |
| P1 | 持续迭代收益证据 | 每个场景绑定基线/候选 graph 内容版本、Host/模型、输入快照和预算，记录成功率、返工、成本、延迟及回归；真实配对 Trial 缺测保留 unknown。已有评测合同和日志能力不等于已有真实收益。 |
| P2 | 可视编辑和复用 | 由同一份 JSON 渲染图，支持定位错误、路径预览和固定版本子图引用。当前子 Graph 被拒绝；先证明重复场景确实需要它，再扩展组合，避免第二套执行器。 |

用户所说的“方向”需要进一步细分为执行方向、产物依赖和经验关联。仅有 `from/to` 不足以解释权限、条件和失败处理。已增加非执行 `relations` 层，当前关系限定为同一定义中的节点；关系层不能自行调用 Host 或绕过验收。

## Skill 的职责

Skill 说明如何发现场景、读取定义、选择入口/出口、提交修改和查看证据。默认模板在 Runtime 中只读提供；Skill 通过 MCP 取得模板和 Schema。用户实际 graph 始终在选定数据根；多工具接入共享同一运行时合同。模板升级由显式差异审阅产生新候选，不自动覆盖用户修改。

## 验证边界

已实现发现/读取/模板/验证/差异、受版本和摘要保护的工作稿保存/提交、旧版本复制迁移及有类型的非执行关系；复用既有配置、门禁、Invocation 和 Trace 链路。相关代码、模板和 SDK 导出见 [Graph 资产模块](../../capability/craft-experience/graph-assets.ts)，验收见 [新增测试](../../tests/experience-graph-assets.test.ts)。

五个实现模块的行、分支、函数覆盖率均为 100%，已登记 coverage-gates.json；相关回归、类型检查、层级/工具/文档/版本检查及打包 MCP 验证通过。Codex、Claude、DSH、本地 Skill+MCP 产物及两个分发仓库的本地内容保持 0.12.39。

用户已有数据没有自动迁移，生产远程部署与真实模型收益没有验收。可视编辑器、嵌套 Graph 和自动复用未受影响门禁仍需另行实现；当前关系层不承诺跨资产知识图谱。draft.json 是正文权威，数据库中的工作稿记录是发现索引；若文件发布后数据库写入失败，可以凭 graph_id 读取文件及摘要并重试保存，不能将发现索引当作提交证据。

现有策略提交新候选即暂停旧正式版，因此新候选阶段通常为 current_version: null / test_version: N；完成四道门禁后为 current_version: N / test_version: null。该文件不改变执行策略，也不代表当前有 Host 正在运行该版本。文件更新失败通过 manifest_status: unavailable 返回，业务资产仍以已提交账本为准，后续读取可重建视图。
