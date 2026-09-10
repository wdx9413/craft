# Craft 与 Agent Harness 理想态差距调研

> as_of: 2026-09-08  
> 范围：只评估 Craft v0.9.4 的编排、执行控制、评测与经验演进；不把固定 BRD/PRD 等产物当作能力目标。
>
> **时效警示**：本文是 v0.9.4/v0.9.5 时期的历史基线调研，下文缺口大多已在后续版本补齐或调整，实施状态以 [技术模块文档](../technical/overview.zh-CN.md) 和 [产品路线](../product/roadmap.zh-CN.md) 为准。

## 2026-09-10 当前阅读说明（v0.11.40）

本文保留问题发现过程，不再代表当前 capability gap。短期定位已明确为跨宿主治理插件层：Codex、Claude、DeepSeek Harness 与通用 MCP 接入共享能力发现、授权、Evidence 与 Eval/Signoff；执行仍由宿主承担。长期定位是自主 Agent 平台，但 conversation loop、Host Driver、Planner 和 UI 都将作为可评测、可替换组件，而不会被单一模型 Harness 锁死。

Skill、MCP、专家服务和市场/Registry 的统一接入模型与当前实现边界见[可插拔能力源](../technical/modules/pluggable-capability-sources.md)。

## 结论

> 本文记录的是 v0.9.5 基线调研。随后 v0.9.6 已实现受信任 Host 的确定性 Workflow Driver、程序 Grader、Promotion Assessment、shadow 实验和 Agent IR 编译/Lowering；下文“缺口”应按该基线阅读，而非声称当前版本没有这些能力。

Craft 已经是“可审计的编排与评测内核”，但尚不是可自主持续运行的完整 Harness。它已具备默认路线、证据、版本化 Trial/Trace/Outcome、held-out Gate、回滚、Project Policy、Host Adapter 协议和可选混合检索；基线时缺的是把这些对象真正自动运行起来的 Driver、Eval Runner 和工具级控制面。

| 理想态维度 | 当前判断 | 已有事实 | 关键缺口 |
| --- | --- | --- | --- |
| 默认自驱编排 | 部分做到 | 默认路线优先 verified Workflow；无匹配时生成安全增量计划 | Host 仍需执行与回报下一动作；无自动 Driver、风险分级和动态任务分解 |
| 受控执行 | 部分做到 | Project Policy、回执门禁、精确 Workflow 版本、Publisher 摘要校验/备份/回滚 | 无工具级命令/路径/网络策略、沙箱、逐次审批暂停、最小权限凭据与补偿事务 |
| 可比较评测 | 基础做到 | 版本化 Suite、Trial、Grader、Signoff 和 held-out 升级 Gate | 无 Case × Subject × 多 Trial 自动 Runner、自动 Grader 执行、置信/波动分析、线上回流 |
| 证据化自进化 | 半做到 | 多条通过路线和 Evidence 才可成为 Proposal，仍需 held-out Signoff | 无自动 Trace 挖掘、候选生成、影子评测、版本比较与自动准入/回滚闭环 |

## 当前实现依据

- `src/service.ts` 已要求 Promotion 引用精确版本、通过的 held-out Evaluation；默认路线只执行 Craft 选中的 verified Workflow。
- `docs/architecture.zh-CN.md` 明确说明无匹配路线只是 Host 的可验证计划，不假装已经执行；自动 Host Driver、自动 Grader 和自适应 Harness 尚未完成。
- v0.9.4 的可选 Embeddings 仅增强 Capability 候选召回：未配置不请求网络，服务失败回退关键词；它不构成验证、审批或自进化证据。

## 业界对照与应补能力

### 1. Durable Runtime Driver（P0）

OpenAI Agents SDK 把“工具审批 → 暂停 → 序列化状态 → 继续同一 Run”作为运行时能力，而非事后记录；审批未通过时工具不执行，状态可跨进程恢复。[OpenAI Human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)

Craft 应将 Host Adapter 从“领取/上报协议”升级为受控 Driver：

- `Operation` 作为不可变执行单元，绑定 Route、工具、输入摘要、Policy、幂等键和证据要求。
- `RunState` 支持 pending approval、超时、有限重试、崩溃恢复和失败后人工接管。
- Driver 只能执行服务端决策出的下一操作；Host 不可伪造阶段完成。

### 2. 工具级受控执行（P0）

工具安全需要落在每次副作用调用，而不是只靠总路线提示。OpenAI 的 tool guardrail 支持调用前/后校验、拒绝和终止；MCP 对 HTTP transport 规定 OAuth 资源绑定、最小 scope 和安全 token 处理。[OpenAI Guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/) [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

Craft 应增加 policy-as-code：

- `read` / `write` / `execute` / `network` / `publish` 五类 Effect；命令、路径、域名、环境和预算 allowlist。
- 隔离工作区/沙箱、短期凭据 Broker、输入输出脱敏、每次高风险 Effect 的可恢复审批。
- 外部写入使用幂等键；无法幂等的操作定义补偿或明确标记为不可回放。

### 3. 自动 Eval Runner 与线上闭环（P0）

LangSmith 的成熟闭环是：离线数据集上的版本实验、代码/人工/LLM/pairwise Evaluator、多次运行与比较；线上再用采样 Evaluator、异常监测，并把失败 Trace 回灌到离线集。[LangSmith Evaluation](https://docs.langchain.com/langsmith/evaluation)

Craft 下一步不应先做“更多 Workflow”，而应实现：

- 固定 `Suite version × Subject version × Case × N trials` 的 Eval Runner，并锁定模型、工具和环境版本。
- 先自动化确定性 command/state Grader，再接 rubric LLM Grader；用人工抽检校准后者。
- 输出质量、成本、时延、失败类型、方差和与 baseline 的配对差异；Promotion 使用 held-out、阈值、回归预算和可回滚版本，而不是单次 `passed`。
- 线上 Trace 做脱敏采样、漂移/异常告警，失败样本经审核后才能进入 development 或 held-out 集。

### 4. 证据化 Experience Miner（P1）

当前 Proposal Gate 是正确的安全底座。需要补的是候选产生器：从多条 Trace 聚类成功策略与失败模式，生成项目无关的 Skill/Workflow/Prompt 候选；所有候选只进入 shadow/eval，不能直接写回生产能力源。通过独立 Eval 和 Signoff 才能发布；线上回归自动回滚到精确 verified 版本。

### 5. 自适应 Harness 与长任务（P1）

长任务 Harness 的行业实践是结构化交接、可恢复状态和独立评价器，而不是默认堆叠多 Agent。[Anthropic long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

Craft 应以任务风险驱动最小 Harness：短问答不建路线；普通研发走安全增量 Kit；高风险或高成本任务才启用独立 Planner/Executor/Evaluator、分阶段预算和可 fork/replay 的 Checkpoint。中期的 Agent IR 应编译至不同 Host，但不能先于 Driver 与 Eval Runner。

### 6. 运行级可观测性与发布门禁（P1）

把 Trace 从“可保存”提升到“可运营”：统一 trace/span schema、运行状态机、成本和 SLO、失败分类、告警、重放和关联 CI/部署。发布控制可直接复用 CI 的事实门禁：GitHub Actions environment 支持 required review、分支限制、自定义保护规则和 secrets 仅在规则通过后可用。[GitHub deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments)

## 推荐版本顺序

1. **v0.9.5：Runtime Driver + Durable RunState** —— 让默认路线真正可执行、暂停、审批和恢复。
2. **v0.9.6：Eval Runner** —— 多次 Trial、自动 Grader 执行、baseline 对比和 held-out Promotion。
3. **v0.9.7：Effect Policy 与 CI Gate** —— 沙箱、最小权限、allowlist、脱敏、幂等/补偿和发布保护。
4. **v0.9.8：Experience Miner** —— Trace → 候选 → shadow eval → Signoff → 可回滚发布。
5. **v0.9.9：Adaptive Harness / Agent IR** —— 按风险选择最小可验证 Harness，并跨 Host 编译。

## 非目标与风险

- 向量检索只解决召回；必须另建 retrieval eval（命中率、误路由率、延迟、成本），不能把相似度当质量或执行授权。
- 不应把 LLM-as-Judge 当成程序证明；保留 Grader 来源和版本，结合确定性验证与人工校准。
- 不应把“自动生成候选”称为“自进化”；没有隔离评测、对照比较、门禁和回滚的自动修改是不可控变化。
