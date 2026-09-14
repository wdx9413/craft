# Craft v0.12.20 距离理想态的决策树

> as_of: 2026-09-14
> 状态：调研事实与决策树；不是实施计划。

## 结论摘要

Craft 已经具备较完整的控制协议，但尚未证明它是一个可持续使用的产品。下一阶段的主要矛盾不是“缺少更多 Agent 能力”，而是：内部协议数量远多于稳定主链、真实纵向闭环证据不足、产品价值尚未通过长期 Case 证明。

理想态应从无限能力清单改成一个可证伪目标：

> 对一个真实任务，Craft 能用很小的稳定接口连接任意合规 Host，在明确范围内行动；中断、人工修改或环境漂移后可恢复；最终以环境真实状态验收；只有可比较证据才能改变后续 Harness。

## 当前事实

| 维度 | v0.12.20 事实 | 判断 |
| --- | --- | --- |
| 默认工具面 | 默认 `craft-mcp` 使用 syscall surface，仅暴露 8 个通用动词；`core` 有 105 个工具，内部 Registry 有 711 个操作。 | 默认上下文膨胀已被控制，但内部概念复杂度仍高。 |
| 主工作循环 | `VerifiedWorkLoopKernel` 已给出 define / prepare / act / deliver / learn 五阶段；Service 还能直接进入 Work Launch、Execution Fabric、Verified Autonomous Work 等多套相邻入口。 | 有主循环，但尚未成为内部唯一编排路径。 |
| 真实执行 | Codex/Claude/Internal Host Driver、Host Run、Workspace 观察和验收协议存在。 | 已有可执行部件；尚缺稳定的真实 Case 纵切和跨版本回归证据。 |
| 演进 | Continual Harness 支持小差异、Session TTL、Shadow、Signoff、Canary 和回滚。 | 安全边界合理；尚未证明候选能从真实失败中持续产生净收益。 |
| 产品结构 | `src/` 约 20,866 行；`service.ts` 约 3,870 行；MCP 定义约 1,575 行。 | 下一阶段需要收敛 Facade、状态所有权和模块边界，而不是继续横向扩展。 |
| 业务证据 | 单元测试和机制 Fixture 丰富，文档仍多次明确“不宣称业务效果”。 | 测试证明协议行为，不证明产品完成真实工作的价值。 |

## 一手行业信号

- [OpenAI Agents API](https://openai.com/index/introducing-the-agents-api/) 将 Harness、长会话、子 Agent 和计算环境分离，说明 Host 能力会快速商品化；应用层应拥有任务、权限、状态和 Outcome。
- [Anthropic Managed Agents](https://www.anthropic.com/engineering/managed-agents) 把 Session、Harness、Sandbox 虚拟为稳定接口，并指出 Harness 对模型弱点的假设会随模型进步而过期。
- [Anthropic 长程 Harness 设计](https://www.anthropic.com/engineering/harness-design-long-running-apps) 说明独立 Evaluator 或更多 Agent 只应在实测收益抵消成本时启用。
- [Anthropic Agent Evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) 将 Outcome 定义为环境终态，并要求维护长期有效的 Evaluation Suite。
- [MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) 提供持久任务互操作，但明确要求授权上下文绑定、TTL、并发限制和审计；协议 Task 不能替代 Craft 的业务验收与权限事实。
- [A2A Specification](https://a2a-protocol.org/dev/specification/) 标准化远程 Task、Message、Artifact 和生命周期，不证明远端 Agent 的可信度或交付质量。

## 决策树

```text
理想态如何判定？
├─ A. 产品成功由能力数量判定
│  └─ 会持续产生新缺口，无法完成
└─ B. 产品成功由可复现真实工作判定（推荐）
   ├─ 首要形态是什么？
   │  ├─ 控制台优先
   │  ├─ 独立 Agent 优先
   │  └─ 同一内核，控制台先完成真实证明（推荐）
   ├─ 下一阶段做什么？
   │  ├─ 继续增加 Adapter / 多 Agent / GUI
   │  └─ 收敛唯一主链并做真实 Pilot（推荐）
   ├─ 演进自主权到哪里？
   │  ├─ 自动修改全局资产
   │  └─ Session 可撤销试验；项目/全局必须评测与批准（推荐）
   └─ 何时增加复杂 Harness？
      ├─ 按功能完整性预装
      └─ 仅在同 Case、同环境、等预算评测证明净收益后启用（推荐）
```

## 尚缺的核心能力（按证据优先）

### P0：真实纵向闭环与产品完成定义

1. 将 `Verified Work Loop` 变为唯一公共编排 Facade；其他 Kernel 只能作为阶段服务被调用，不能形成平行主流程。
2. 选定一个真实 Codex 研发 Case 和一个文件型非研发 Case，长期保存输入、环境、预算、人工介入、终态 Artifact、验收器和失败分类。
3. 建立跨版本 Release Qualification：每次发布自动跑 baseline/candidate，结果只能是 eligible、rejected 或 inconclusive。
4. 给用户一个最小工作面：目标、当前真实状态、下一动作、审批、成本、交付差异与恢复入口；不要求先建设大型 Canvas。

### P1：架构收敛与运行运营

1. 拆分过大的 Service/MCP 组合层，明确 Task、Capability、Execution、Evaluation、Knowledge 五个边界的唯一状态所有者。
2. 建立 Adapter Contract Test Kit，真实验证 Codex、文件 Workspace、Sandbox/MCP 的取消、恢复、权限、状态再观察与错误语义。
3. 为长期运行增加 SLO：完成率、人工干预率、恢复成功率、平均恢复时间、未知副作用率、成本和评测漂移。
4. 对历史对象和入口建立弃用、迁移与删除策略，防止每次版本只增不减。

### P2：由评测触发的扩展

- 多 Agent、独立 Evaluator、A2A、GUI/Computer Use、远程 Sandbox、企业 Broker、向量检索和脚本编译都保留为 Adapter/Harness Candidate。
- 只有固定 Case 证明它相对最小单 Agent 基线有净收益时，才进入默认 Profile。

## 当前不应新增

- 新的平行任务状态机或又一套“统一入口”；
- 静态行业树、全局知识图谱、默认多 Agent；
- 根据模型复盘直接修改全局 Prompt、Skill 或 Workflow；
- 仅为了覆盖功能清单而接入远程 Host、市场或通用 GUI。

## 待用户确认

已确认：Platform Ideal State v1 必须可验收；先以 Codex 控制台模式证明价值；允许旧入口进入兼容与弃用周期，并将 Verified Work Loop 收敛为唯一公共编排 Facade。对应术语和 ADR 已落库。

继续确认：首批采用 Codex 研发与文件型非研发两个 Reference Pilot，分阶段完成；Session 级低风险 Refinement 可带 TTL 自动试用，Project/User/Global 变更必须经过评测门禁；旧公共旁路不保留兼容期。

继续确认：公共旁路和重复状态机直接删除；仍有独立职责的 Work Launch 等能力只能作为 Verified Work Loop 的内部阶段服务。研发 Reference Pilot 同时使用固定仓库 Fixture 作为 Release Gate、使用 Craft 自身改造作为 Dogfooding 运营证据。文件型 Reference Pilot 先交付可编辑的 AI 视频项目包，包括创意说明、分镜、镜头清单、生成提示和验收表，不在第一阶段绑定具体视频生成供应商。

继续确认：Platform v1 同时要求机制证据与相对普通 Codex 的价值证据；每个固定 Case 的 baseline/candidate 各运行五次，结论严格为 `eligible`、`rejected` 或 `inconclusive`。AI 视频项目包先做结构与引用的确定性检查，再做隐藏版本身份的人工 Rubric 盲评；未经校准的模型 Judge 只有诊断权。Craft 只保存摘要、digest、版本、指标、Receipt、Evidence 与 Artifact 引用，正文和真实素材由调用方持有。

继续确认：研发 Pilot 的主要指标是相同验收质量下的人工介入时间，并以质量、安全、成本、时延和恢复指标作为非劣化护栏；文件型 Pilot 的主要指标是盲评下可直接进入下一生产阶段的比例，并补充人工修改时间和引用正确性。`rejected` 必须停止并回滚，连续两轮 `inconclusive` 先修复 Case、环境或指标，连续三个版本没有净收益则先删除非承重 Harness。两个 Pilot 都必须通过机制门；研发 Pilot 必须 `eligible`，文件型 Pilot 可以暂时 `inconclusive` 但不能 `rejected`。

用户进一步纠正：确定性检查加盲评不能成为 AI 视频专用 Core 逻辑。Craft 已有通用 `program / model / human / business_signal` Acceptance Plan 和人工 handoff，但目前主要依赖静态方法声明；理想态应由通用 Acceptance Resolution Policy 根据证据完整性、校准置信边界、评审冲突和 effect 风险决定是否升级人工。AI 视频项目包只是该机制的一个 Reference Pilot 配置。

用户补充：不应把人工升级设为唯一处理方式。需要通用、可配置的 Uncertainty Policy：在证据不足、指标接近阈值或评审不一致时，可选择继续采证、请求人工、弃权、保持旧状态或拒绝变更；并允许配置一致性与置信边界阈值。

最终确认：配置顺序为 Core Safety Floor → Global Default → Project → Task/Case，具体配置不能降低安全下限。“自动升级”只允许在预算和已有授权内增加确定性检查、已批准模型、独立 Evaluator、只读 Expert/Sub-agent、资料读取或 Trial，即升级求证强度；不得自动扩大 effect、数据范围、凭据、自治等级或发布 Candidate。不确定性终态区分 `collecting`、`human_required`、`abstained`、`unchanged`、`rejected` 与 `blocked`。人工 Adjudication 只能追加理由、范围、有效期和证据版本，不能删除分歧证据或绕过 Core Safety Floor。

设计树 frontier 已为空。下一阶段可以据此形成一次性实施版本，不再把新增行业能力视为 Platform Ideal State v1 的核心缺口。
