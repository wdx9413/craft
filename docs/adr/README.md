# 决策记录（ADR）

这里放**已经决定、不应被重新争论**的架构决策。每条只写决定和它的后果，不写选项对比；需要背景时在文末关联到技术文档。

**为什么要有这个索引**：这些决策此前**没有任何地方引用**——`docs/README.md` 没列，技术文档没链接。写进目录但没人索引的决策，和没写下来的决策一样会被忘掉。新增 ADR 时同时在这里加一行。

格式约定：文件名 `NNNN-短横线小写标题.md`，正文第一行是 `# 标题`，随后是**一段**密集的散文——决定是什么、为什么不可协商、以及由此产生的可检查后果。ADR 不描述实现细节，实现看 `docs/technical/modules/`。

## 目录

| # | 决策 |
| --- | --- |
| [0001](0001-codex-console-first-proof.md) | 先以 Codex 控制台模式证明平台价值 |
| [0002](0002-verified-work-loop-is-the-single-orchestration-facade.md) | Verified Work Loop 是唯一公共编排 Facade |
| [0003](0003-harness-evolution-is-bounded-by-scope.md) | Harness 演进按作用域限制自主权：只有 Session 级低风险提示可自动试用，Project/User/Global 变更必须经 Shadow、重复评测、Signoff 与 Canary，Core Policy 永不自改 |
| [0004](0004-platform-v1-requires-mechanism-and-value-evidence.md) | Platform v1 同时要求机制证据与用户价值证据 |
| [0005](0005-callers-own-work-content.md) | 调用方拥有工作正文：Craft 只持有摘要、digest、版本、Receipt、Evidence 与 Artifact 引用 |
| [0006](0006-uncertainty-policy-only-escalates-evidence.md) | Uncertainty Policy 只升级求证强度 |
| [0007](0007-markdown-content-store-source-of-truth.md) | 知识与记忆正文使用可迁移 Markdown 存储 |
| [0014](0014-context-members-have-fixed-natures.md) | 上下文五个成员的来源性质固定：`history` 宿主提供、三者累积、`state` 当前；自托管不改变这一点 |
| [0015](0015-goal-and-acceptance-are-built-in.md) | 目标与验收内置、评测方式可插拔；Host 自报完成不构成 verdict |
| [0016](0016-ownership-is-not-projection.md) | 能力的归属不是它的产品投影；产品必须暴露其能力所装配的东西 |
| [0017](0017-a-hook-belongs-to-the-flow.md) | hook 属于流程而非某次写入；只有 gating 阶段可拒绝；hook 必须带能力归属以便单点埋点 |
| [0018](0018-merge-shared-helpers-only-where-behaviour-agrees.md) | 共享助手只在行为一致处合并；摘要按语义命名；身份类合并需要金标值 |
| [0019](0019-transcript-is-not-an-external-capability.md) | transcript 不对外成为能力：自托管时 Craft 即宿主，`history` 保持 `host_provided` |
| [0020](0020-one-compaction-policy.md) | 压缩只有一套策略：`compact()` 先保留连续近期后缀再按权重竞争，保护是减法 |
| [0021](0021-agent-harness-runtime-context-boundaries.md) | Agent、Harness、Runtime、Context 与 State 分层；完整流程与单点能力共享一套事实账本 |
| [0022](0022-graph-lowers-to-verified-work-loop.md) | Graph 只编译为 Verified Work Loop Plan，不拥有第二套 Runtime 或权限 |
| [0023](0023-effect-unknown-requires-reconciliation.md) | 外部 Effect 未知时必须先对账，禁止自动重放 |
| [0024](0024-capability-supply-chain-governance.md) | 能力必须经过来源、扫描、Conformance、审批和可回滚的供应链治理 |
| [0025](0025-context-working-set-is-the-retrieval-seam.md) | Context Working Set 是可解释、可复现、可评测的检索边界 |

## 与技术文档的关系

| 决策 | 展开在 |
| --- | --- |
| 0005、0014、0015、0019、0020 | [上下文的五个成员](../technical/modules/context-members.md) |
| 0007 | [上下文、记忆与后台整理](../technical/modules/context-memory.md) |
| 0016、0017、0018 | [Capability 扩展协议](../technical/modules/capability-protocol.md) |
| 0003、0004 | [Experience / Eval](../technical/modules/experience-eval.md)、[Workflow / Signoff](../technical/modules/workflow-signoff.md) |
| 0001、0002 | [产品路线](../product/roadmap.zh-CN.md) |
| 0006 | [Uncertainty Policy](../technical/modules/platform-ideal-state-v1.md) |
| 0021 | [架构与分层地图](../architecture/layer-map.md)、[Craft 架构](../architecture.zh-CN.md) |
| 0022、0023、0024、0025 | [v0.12.35 控制面收口](../technical/modules/v01235-control-plane.md) |
