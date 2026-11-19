# 自进化本体论与评测闭环

## 目的

本体论应让 Craft 能够把跨任务观察转成可评测、可发布、可撤销的能力改进。它不是自进化 Agent 本身，也不以图谱规模作为改进指标；它提供稳定的语义合同，让 Knowledge、Memory、Experience、Mod、检索策略与代码/工具候选可以引用同一套来源、版本、类型和评测事实。

架构决策见 [ADR-0032](../../adr/0032-versioned-evolution-ontology-and-immutable-core-policy.md)。

## 当前状态

当前共享包 `craft-common-ontology` 提供六种持久记录概念（`fact`、`rule`、`decision`、`term`、`preference`、`procedure`）、概念语句校验、旧类型映射，以及 `RELATION_KINDS`、`RELATION_TYPES`、`checkRelationConcepts` 和 `checkConceptConsistency` 等类型关系与一致性诊断 API。源码位置为 `craft-common/packages/craft-common-ontology/src/{concepts,validation,index}.ts`。这些 API 是确定性的局部结构校验，不是通用本体推理、真实性判定或本体版本迁移。ADR-0029 明确不做通用本体推理。

Craft 已有追加式演进候选、作用域阶段和评测合同。Ontology 分类查询现在按激活指针读取分类投影，并保留无激活指针时的兼容基线。Runtime 仍需配置可信评测器、全局启用授权和操作员签名信任根；模拟验收不等同于 Codex 用户任务质量评测。详见 [自进化 Mod Runtime](./self-evolution-mod.md) 和 [Codex 自进化理想态规划](../../product/craft-context-codex-self-evolution-ideal-state.zh-CN.md)。

## Runtime 信任配置

Task Effect Contract 的评测器身份不能由候选合同自行授权。Runtime 从启动环境变量 `CRAFT_TRUSTED_EVALUATORS` 读取固定 JSON 数组，每项必须包含精确的 `id`、`version`、`digest` 和 `public_key_pem`。合同定义、结果记录和结果复核都会逐字段比对；缺少或不匹配时失败关闭。

```json
[{"id":"org-evaluator","version":"1","digest":"sha256:<64位小写十六进制>","public_key_pem":"-----BEGIN PUBLIC KEY-----\\n..."}]
```

Knowledge 全局来源使用 `CRAFT_TRUSTED_KNOWLEDGE_SOURCES` 固定来源 ID 与来源身份摘要；仅配置 ID 不授予信任。格式为 `[{"id":"org-standard","identity_digest":"sha256:<64位小写十六进制>"}]`。来源范围、`verified` 标记和身份摘要必须同时匹配。

Ontology 全局发布还必须显式设置 `CRAFT_ONTOLOGY_GLOBAL_ACTIVATION=enabled`。操作员回滚/撤销使用 `CRAFT_ONTOLOGY_TRUSTED_OPERATORS` 固定 Ed25519 公钥注册表，格式为 `[ {"id":"release-operator","public_key_pem":"-----BEGIN PUBLIC KEY-----\\n..."} ]`；签名覆盖动作、目标指针、作用域、阶段、修订号、原因和请求 ID，不能复用到另一项操作。自动回滚只接受已信任评测器签署、精确绑定当前候选与作用域的越界报告，并追加指向前一有效指针的事件；没有前一指针时撤销到兼容基线。

以上变量属于 Runtime 管理配置，不能由候选或 MCP 请求更新。它们提供可部署的信任根；真实 Codex Host 身份仍须经 Host 回执验收。

## 目标模型

演进语义至少描述：

| 领域对象 | 要回答的问题 |
| --- | --- |
| Observation / Outcome | 发生了什么，来自哪个 Host、任务、会话和能力版本？ |
| Failure / Hypothesis | 观察到的失败是什么；原因是证据、推断还是待验证假设？ |
| Candidate / Artifact Version | 改了哪个可执行资产、语义规则或配置；代码、权限、数据模式的精确版本是什么？ |
| Evaluation Contract / Run | 用什么冻结样例、环境、指标阈值和安全断言对比基线与候选？ |
| Rollout / Effect | 在什么作用域和阶段生效；真实任务结果、成本、回滚和撤销是什么？ |
| Classification Revision | 某一 Ontology 版本怎样解释某条记录；旧解释、来源和迁移决定是什么？ |

不同能力仍拥有各自的数据与发布权。共享本体只定义稳定语义和跨能力关系，不接管 Knowledge、Memory、Experience、Mod 或 Runtime 的所有权。

所有持久观察、推断、候选、评测和部署结果都带来源引用、主体/作用域、发生时间、资产或 Ontology 版本、信任级别与撤销/有效状态。Host 观测、独立评测结果、人工确认和模型推断是不同证据类别；模型推断不能伪装成真实执行或独立验收。

## 演进闭环

```text
观察与结果
    ↓ 来源绑定、作用域归因
失败 / 假设 / 改进机会
    ↓ 生成候选与精确版本
冻结 Evaluation Contract
    ↓ 基线和候选配对、重复试验、留出集
安全硬门槛 + 预注册指标
    ↓ 通过才进入 rollout
影子 → 小范围 → 项目 → 全局
    ↓ 每阶段独立监控和对照
继续扩大 / 自动回滚 / 用户撤销
    └──────────────→ 新观察
```

任何候选类型（Mod、Procedure、Prompt、检索/路由策略、Ontology schema 或其它已登记的 Craft 能力资产）都必须绑定自己的 Evaluation Contract。合同在候选生成前固定评测样例、环境、基线版本、主收益指标、可容忍退化范围、成本/时延约束及安全断言。候选作者不能修改合同或验收用例。不同资产不共用一个含糊的“总分”；业务收益指标可以分层加权，但审批、权限、隐私、安全和数据治理要求是零容忍硬门槛。

评测必须能对比同一任务/环境下的基线与候选，包含重复运行与留出样例。线上反馈用于监控和触发复评，不单独证明因果收益。样本不足、来源不独立或评测器不可信时，候选不得晋级。

每阶段通过后按事先授权的资产类型和作用域自动启用；扩大范围前重新验收。越过合同中的安全断言或指标容忍线时自动退回最近已验证版本。用户可以随时撤销候选并恢复旧版本。

## 本体论自身演进

自进化可以生成概念、关系、分类规则和迁移方案的新版本，并在固定合同下验证后自动发布。Ontology 版本切换不覆盖历史解释。

对已有事实的自动重分类只追加分类版本：保留事实的稳定 ID、正文、来源、旧概念、Ontology 版本、置信度与理由。迁移回执能重现原分类与新分类。含糊、多义或未达到合同置信阈值的记录标记为 `unresolved`，不改变当前检索、冲突检测或晋级行为。错误版本回滚通过切回先前 Ontology 与分类投影实现，不删除迁移历史。

内容改写、事实拆分/合并、证据来源替换和信任级别提升都不是“重分类”；它们分别构成新候选，并必须重新评测。分类器输出即使高置信，也不能独立增加事实可信度、修改安全策略或触发未授权的跨作用域发布。

## Core Policy 边界

审批、信任授予、权限上限、隐私/保密规则、安全硬门槛以及最终授权和审计完整性属于 Core Policy。它们可以被明确引用为不可放宽的不变量，但不能由 Ontology schema、分类器、Mod 或 Evaluation Contract 提供可覆写的运行值。Runtime 在独立授权边界检查这些不变量；修改建议只能被记录为待人工设计的政策变更，不能由自进化流程自行执行。

本体分类可以改进对记录含义的解释，但不能更改记录的来源信任，也不能赋予执行权限。例如，将某条偏好重新解释为规则，不能据此改写用户授权；将某次失败重新分类，也不能因此跳过原有验收门槛。

## 当前差距与验收

| 能力 | 当前证据 | 目标验收 |
| --- | --- | --- |
| 统一概念分类 | 共享包导出版本化 Ontology schema；Runtime 可幂等注册并校验内容摘要 | 真实调用方和 Craft-Eval 对多版本兼容的完整验证 |
| 类型化关系 | 共享包已导出关系种类、端点约束和一致性诊断 API | 验证真实调用方和 Craft-Eval 对 API 行为的依赖；不把局部结构校验称为推理 |
| 来源与有效性 | 分类修订保留稳定 Claim ID、源引用、Ontology 版本、置信度、理由及追加回执；写入前绑定项目 Cycle 与可信合同 | 历史索引重建及陈旧分类的自动刷新仍需运行验收 |
| 历史重分类 | Runtime `ontologyClassificationRecord` 追加修订，来源正文不变；低置信度进入 `unresolved`；分类投影按项目/小范围/全局激活指针选择，撤销和回滚以追加事件切换 | 真实生产检索负载下的索引一致性与分阶段观测 |
| 评测与晋级 | Ontology 候选必须关联精确版本、Runtime 信任根中的评测器、签名报告和 routeable 合同；小范围绑定固定 cohort，全局要求独立授权；越界反馈自动回滚，人工撤销要求受信操作员签名 | 其他资产族合同统一、真实 Codex Host 配对留出效果及真实部署观察 |
| Core Policy | 普通 Mod 全信任也不能改变受保护审批策略；策略差异仅作为待审候选 | 真实 Host 下的端到端权限拒绝和审计证据 |

外部研究支持将技能/能力视为可复用、带经验的长期资产，并逐项评测其生命周期；但自生成技能的收益可能为负。Darwin Gödel Machine 使用编程基准验证每次代码改动；MUSE-Autoskill 把创建、记忆、管理、评测和修订结合；SkillsBench 1.1 报告自生成技能在若干 Agent/模型配置上的任务解决率下降。因此 Craft 应以候选级证据而非“自动生成”作为晋级依据，且需覆盖长期收益与代价，而不只是一次通过率。

参考：

- [Darwin Gödel Machine (ICLR 2026)](https://arxiv.org/abs/2505.22954)
- [MUSE-Autoskill (2026)](https://arxiv.org/abs/2605.27366)
- [SkillsBench 1.1](https://www.skillsbench.ai/blogs/skillsbench-1-1)
- [Agent Skill Evaluation and Evolution survey (v2, 2026-11-02)](https://arxiv.org/abs/2606.11435)
