# 自进化本体论与评测闭环

## 目的

本体论应让 Craft 能够把跨任务观察转成可评测、可发布、可撤销的能力改进。它不是自进化 Agent 本身，也不以图谱规模作为改进指标；它提供稳定的语义合同，让 Knowledge、Memory、Experience、Mod、检索策略与代码/工具候选可以引用同一套来源、版本、类型和评测事实。

架构决策见 [ADR-0032](../../adr/0032-versioned-evolution-ontology-and-immutable-core-policy.md)。

## 当前状态

当前共享包 `craft-common-ontology` 提供六种持久记录概念（`fact`、`rule`、`decision`、`term`、`preference`、`procedure`）、概念语句校验及旧类型映射。ADR-0029 明确不做通用本体推理。ADR-0030 描述关系类型约束、关系端点检查和跨记录一致性诊断，但当前 `craft-common-ontology/src/index.ts` 与 `src/validation.ts` 没有导出这些关系 API；Craft 测试引用了 `RELATION_KINDS`、`RELATION_TYPES`、`checkRelationConcepts` 和 `checkConceptConsistency`。因此这些关系能力目前是文档/调用方期望，不应称为共享包已实现能力。

Craft 已有演进候选、任务/项目/全局阶段、回归、运行记录和回滚相关组件；但当前 `core/evolution-cycle.ts` 未将共享本体论绑定到候选生命周期，也未把类型化语义作为统一的候选评测合同。现有 Mod Runtime 的固定输入向量验证事件合同，不等同于用户任务质量评测。详见 [自进化 Mod Runtime](./self-evolution-mod.md)。

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
| 统一概念分类 | 共享包有六类概念和写入校验 | 增加版本化 Ontology schema；兼容读取旧版本 |
| 类型化关系 | ADR-0030 描述，但共享包源码缺少对应导出 | 关系类型、端点约束、一致性诊断与 Craft-Eval 行为一致，并有真实调用方验证 |
| 来源与有效性 | 各能力保留部分来源/版本字段 | Observation 到 Candidate、Evaluation、Rollout、Rollback 可追溯；撤销和过期传播可验证 |
| 重分类 | 当前共享包只映射旧类型 | 追加分类版本、歧义隔离、历史回放和语义版本回滚通过数据迁移验收 |
| 评测与晋级 | 候选生命周期存在，但通用 Ontology/Evaluation Contract 联结未证实 | 每种候选绑定不可变合同；配对留出评测和分阶段门禁能拒绝收益不足/安全失败候选 |
| Core Policy | ADR-0003 表述为 Core Policy 永不自改 | 明确定义 Core Policy 集合；Runtime 在本体之外独立实施，越权变更失败关闭 |

外部研究支持将技能/能力视为可复用、带经验的长期资产，并逐项评测其生命周期；但自生成技能的收益可能为负。Darwin Gödel Machine 使用编程基准验证每次代码改动；MUSE-Autoskill 把创建、记忆、管理、评测和修订结合；SkillsBench 1.1 报告自生成技能在若干 Agent/模型配置上的任务解决率下降。因此 Craft 应以候选级证据而非“自动生成”作为晋级依据，且需覆盖长期收益与代价，而不只是一次通过率。

参考：

- [Darwin Gödel Machine (ICLR 2026)](https://arxiv.org/abs/2505.22954)
- [MUSE-Autoskill (2026)](https://arxiv.org/abs/2605.27366)
- [SkillsBench 1.1](https://www.skillsbench.ai/blogs/skillsbench-1-1)
- [Agent Skill Evaluation and Evolution survey (v2, 2026-11-02)](https://arxiv.org/abs/2606.11435)
