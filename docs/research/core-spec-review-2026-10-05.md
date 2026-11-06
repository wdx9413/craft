# 核心与四子能力 Spec 审查

日期：2026-10-05。范围为当前工作树全貌，加相对 `9ada1c7a92dfc3847837b063081176696ca9f463` 的未提交改动及未跟踪源码；排除 Workbench、Desktop 和其他 UI。未修改实现。此为独立 Spec 轴，不能将 Standards 发现或未来设想混作违反规格的缺陷。

## 主报告

**3 项确定缺陷，最严重 P1；均为基线已有缺陷，在本次全貌审查中发现。未发现有充分证据要求删除的 scope creep。**

1. **SPEC-1 / P1：遗漏预声明护栏仍可发布合格。** ADR0004 要求“其他关键指标无越界退化”。`release-qualification.ts:20` 保存 `guardrail_names`，但 `:38,48` 仅验证实际传入值；声明 `cost/safety` 后提交 `{}`，十个 Slot 仍得到 `eligible`。应核对完整护栏键及证据，缺测保持 `inconclusive`。[规范](../adr/0004-platform-v1-requires-mechanism-and-value-evidence.md)；[代码](../../core/release-qualification.ts#L38)。
2. **SPEC-2 / P1：候选验证可借用另一环境的资格结论。** Verification Plane 规范要求“引用同环境、同预算、重复配对后的 ReleaseQualification”。`verification-plane.ts:91–98` 只读取引用对象的 `conclusion`，未绑定环境、预算、Candidate。临时 Store 中以 `different-environment` 的 Plan 引用 `env` 的资格，仍得 `eligible`。应在同一 Interface 固定并校验资格身份。[规范](../technical/modules/verification-plane.md#L36)；[代码](../../core/verification-plane.ts#L91)。
3. **SPEC-3 / P1：配对资格的证据没有绑定 Trial。** ADR0004 要求“同输入、同模型、同环境和等预算”。`release-qualification.ts:28,39–41` 没有固定输入/模型/验收指纹，Evidence 只验 confidence，机制结果和指标仍由参数提供。同一条无 Trial、执行来源或测量关联的 bounded Evidence 可覆盖十次 Slot 并得 `eligible`。需接入已存在的执行/测量事实，不能把标签升级当可信验证。[规范](../adr/0004-platform-v1-requires-mechanism-and-value-evidence.md)；[代码](../../core/release-qualification.ts#L28)。

## 最小复现实证

本轮直接调用当前源码，在独立临时 SQLite 中运行；没有访问用户业务数据、启动真实 Host、修改实现或发布。

脚本：`/private/tmp/craft-spec-qualification-repro.ts`，执行 `node --experimental-strip-types /private/tmp/craft-spec-qualification-repro.ts`。2026-10-05 本地执行成功，关键结果为：

```json
{
  "declared_guardrails": ["cost", "safety"],
  "submitted_guardrails": {},
  "evidence": {"confidence": "bounded"},
  "conclusion": "eligible",
  "guardrails_passed": true,
  "mechanism_passed": true,
  "verification_environment": "different-environment",
  "qualification_environment": "env",
  "mismatched_qualification_verdict": "eligible"
}
```

SPEC-1 与 SPEC-3 共享同一复现，但根因不同：一个是声明的测量被遗漏，一个是测量来源没有被约束。SPEC-2 即使改用真实合格的 Qualification 也成立，因为消费侧没有比较身份。

现有 `tests/platform-ideal-state.test.ts:140–147` 恰好用 `{}` 护栏和统一 `confirmed` Evidence 得到平台合格；这类测试证明分支可运行，不证明 ADR 所定义的真实资格。新增公共包测试 `tests/common-packages.test.ts:122–132` 直接插入 eligible Assessment/Plan，能验证引用规则，却无法揭示本次发现的上游 Qualification 绑定缺陷。

建议验收：遗漏护栏、无关联 Evidence、复用其他 Trial 证据、不同模型/输入/验收/环境/预算、错 Candidate 的资格全部拒绝或保持 inconclusive；真实同环境同合同的证据链才可到 eligible。通过代码修复后，还须独立做真实 Reference Pilot，不能把负例通过当业务改善。

## 功能与验证矩阵

“源码已具备”表示本轮读到实际调用链，不表示重新运行了全部既有测试；既有报告中的通过数字属于当时快照。

| Module / 能力 | 当前源码已具备 | 未实现、部分实现或验证缺口 | 后续验收方向 |
|---|---|---|---|
| Runtime / Work Loop | Task、Policy、Snapshot、Host、Receipt、Acceptance、Durable Action、恢复均有实现；Procedure Invocation 复用账本 | 资格链存在 SPEC-1/2/3；真实 Host 与真实业务效果不能由 fixture 代替 | 先修身份与证据绑定，再跑 Codex 研发和文件交付两条 Reference Pilot |
| Context | 默认入口、四成员预算、来源引用、去重、partial 原因；当前 Source 权限传播 | K/M/E 先消费预算、Codebase 余量；没有统一 receipt 只读重检；字符预算不是完整 JSON token 预算 | 对需求开发、CR、纯知识三类任务固定输入比较遗漏/准确率，再决定配额策略 |
| Knowledge | Source/导入/Claim/支持与晋级、Context 投影、历史/比较/候选恢复 | 查询入口 ACL 一致性由 Standards 轴单列；数据库与内容文件恢复一致性需故障验证；规模收益未证明 | 对聚合/精确读取/列表/历史统一访问负例；撤销/内容漂移/故障注入回放 |
| Memory | Ledger、候选与冲突治理、作用域/有效期、当前权限读取、更正/撤销、版本恢复候选 | Ledger、semantic consolidation、legacy memory 三条路径仍并存；治理与读取尚未完全归属能力包；自动捕获真实误记率未证明 | 做跨三条路径的撤销/隐私/更正一致性矩阵；设可测的误召回与更正生效指标 |
| Experience 资产 | 用户配置候选、内容版本、checked JSON、四阶段 Gate、多子场景 Entry/Exit、Skill 导出 | Route Evidence 校验绑定摘要和场景，但可信执行来源仍需真实链路；不能靠自行设置 program/confirmed 建立独立性 | 每条声明 Route 的独立证据与失败回滚；将 Host-attested 与 verified 分开验收 |
| Experience Graph | `validateGraphControl`、子场景限定、路径选择、条件/人工恢复、有界返工、材料失效、单一 Durable 账本 | Graph 子调用仅展开固定版本 Workflow；不含嵌套 Graph/并行写；补偿明确交给 Host，不自动还原文件或外部动作 | 当前承诺先用真实需求/Bug/CR 重启与迟到回执回放；其余列为按需求扩展，不冒充缺陷 |
| Codebase | 自动基础索引、checkpoint/策略版本固定、TS/JS checker、Python/Jedi 与 LSP import、候选影响关系 | 自动入口 500 文件等有界限制；没有大仓分片索引；Java/Go 尚无真实语言服务器验收；import 是 adapter_reported | 分语言真实项目精度/召回/漂移基准；先测大仓瓶颈再决定分片与增量依赖图 |
| 公共包 / Evaluation Contract | base/store-local/log 与四能力包无反向宿主依赖；reported/verified 两种状态、绑定 Assessment | verified 依赖上游 Assessment，继承 SPEC-2/3；report 领先 verified 后补交早期证明的行为未定义完整 | 端到端验证从真实 Receipt 到 routeable；增加乱序/迟到/撤销证明的恢复合同 |
| Skill + MCP 分发 | 五产品、多个 Host 产物、无 Hook 接入路径、本地 stdio 验收脚本 | npm 可信发布、真实 Host Skill 遵循、真实 IdP/容器/目标租户尚需各自验收 | 保持 package load、协议可调用、Host 会话、业务效果四类报告独立 |
| 远程数据空间 | TLS、introspection、认证身份绑定、租户路由、隔离数据目录 | 共同信任租户模型；没有完整逐用户写入/管理员授权；Codebase 文件系统依赖部署隔离 | 不互信多人场景出现前定义身份/操作授权；真 IdP/容器/挂载矩阵后才宣称团队隔离 |

矩阵主要源码：`core/application/use-cases/repository-context.ts`、`core/context-resolution.ts`、`capability/craft-knowledge/contribution.ts`、`core/memory-governance.ts`、`capability/craft-memory/memory-ledger.ts`、`capability/craft-experience/procedure-configuration.ts`、`procedure-graph.ts`、`procedure-composition.ts`、`procedure-projection.ts`、`core/application/procedure-invocation.ts`、`procedure-graph-progress.ts`、`capability/craft-codebase/codebase-index.ts`、`common/craft-common-log/src/evaluation-contract.ts`。边界以 [Craft Context](../technical/modules/craft-context.md)、[Codebase](../technical/modules/craft-codebase.md)、[公共包](../technical/modules/common-packages.md)、[远程部署](../../deploy/components/README.md) 为依据。

## 非缺陷但应补明确的合同

1. **报告先于证明如何追补。** 当前 `EvaluationContractKernel.record` 用 `reported_stage` 限制不回退，同时要求 `verified_stage` 逐级增长（`:42–60`）。先报告 mechanism，再报告 fixture，之后补交 mechanism 证明会报 `stages cannot move backwards`。本轮临时 Store 已复现，见 `/private/tmp/craft-spec-contract-repro.ts`。当前文档未明确禁止先报告后验证，建议明确分离报告游标与验证游标，或禁止未验证时继续报告后续阶段；这属于需补齐的恢复合同，不强行判为已有规格违规。
2. **Effect 与证据等级的区别。** Graph 的 `host_execution_authority:false`、Invocation 的 `verification_provenance:host_attested` 是正确的限制。Graph 回退表示新尝试与旧验收失效；文件 checkpoint 恢复、外部补偿和业务回滚需要分别建模。不要为追求“完整 workflow”把它们合并成自动副作用。
3. **包独立与产品独立的区别。** 当前能力包可注册，独立 MCP 产品仍由共享 Runtime 装配；`CraftService` 仍负责部分跨能力治理。需要进一步减少宿主耦合，但不能据此抹掉已存在的独立 Skill + MCP 能力，也不宜立刻要求每个子能力复制 Task/Policy 生命周期。
4. **文档需统一到当前时点。** `experience-composition.md` 的“当前不含持久子流程调度”属于早期实现记录，已被 Invocation/Graph 实现扩展；`capability-protocol.md` 顶部“Memory 尚未成为能力包”与文末及源码矛盾。旧报告应标为历史快照，活跃技术合同应只描述当前语义，避免把已经实现的能力继续列入缺口。

本轮未重新做全仓测试、真实 Host 运行、远程部署或模型收益评估；也未发现足以支持无限 Graph、通用分布式编排或新数据库为必要下一步的证据。它们不进入缺陷清单。
