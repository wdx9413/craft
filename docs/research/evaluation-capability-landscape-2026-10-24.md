# Agent 与软件评测：分层、通用抽象和开源实现

调研日期：2026-10-24。范围是可核对的一手资料：标准组织、产品官方文档、项目官方仓库及原始论文。此文把来源陈述与对 Craft 的推论分开；不把项目 README 的能力声明当作独立效果验证。

## 先给结论

**评测可以做成 Craft 子能力，但应提供通用的“评测运行与证据”内核，不应把所有模块压成同一种分数。** 业界实现反复出现的组成是：带版本的数据集、被测对象/环境、执行器、评分器、运行记录、跨版本比较。英国 AI Safety Institute 的 Inspect 把一个 Task 明确组合为 dataset、solver、scorer；OpenAI Evals 将评测名称、数据切分和版本注册在一起；LangSmith 区分部署前离线评测与生产轨迹上的在线评测。[Inspect Tasks](https://inspect.aisi.org.uk/tasks.html)、[OpenAI Evals build guide](https://github.com/openai/evals/blob/main/docs/build-eval.md)、[LangSmith evaluation types](https://docs.langchain.com/langsmith/evaluation-types)

**评测点至少分四层。** 纯代码/接口合同用确定性测试；模块输出用有标签样本或不变量；Agent 执行用完整轨迹及工具决策；整体产品用隔离环境中的端到端任务和线上观察。DeepEval 官方文档区分最终输出、整条轨迹、单个步骤；Google 的测试实践区分 small、medium、large，表明系统级验证不能替代小范围测试。[DeepEval Agent guide](https://github.com/confident-ai/deepeval/blob/main/docs/content/guides/guides-ai-agent-evaluation.mdx)、[Google Testing Blog: Test Sizes](https://testing.googleblog.com/2010/12/test-sizes.html)

**真实任务的成功应尽量由环境状态或可执行断言判断。** SWE-bench 在隔离的软件环境中对补丁运行任务测试，WebArena/BrowserGym 提供可重置的网页任务环境。对于无法确定性判断的语义质量，再使用有明确量表的模型评分和人工复核。[SWE-bench harness](https://github.com/SWE-bench/SWE-bench/blob/main/README.md)、[WebArena](https://github.com/web-arena-x/webarena)、[BrowserGym](https://github.com/ServiceNow/BrowserGym)、[LangSmith evaluator types](https://docs.langchain.com/langsmith/evaluation-types)

## 业界把什么当作“评测”

| 层次 | 被测边界与典型问题 | 首选证据 | 一手依据 |
|---|---|---|---|
| 代码与协议 | 解析、数据边界、API 合同、并发、回归 | 单元/集成测试、明确断言、失败日志 | [Google Test Sizes](https://testing.googleblog.com/2010/12/test-sizes.html)、[ISO/IEC 25010:2023](https://www.iso.org/standard/78176.html) |
| 模块能力 | 检索、记忆、规划、工具选择等单个能力是否满足输入合同 | 固定样本、参考答案或不变量，必要时逐项人工标签 | [DeepEval metrics](https://github.com/confident-ai/deepeval/blob/main/docs/content/docs/metrics-introduction.mdx)、[Ragas RAG evaluation](https://github.com/vibrantlabsai/ragas/blob/main/docs/howtos/applications/evaluate-and-improve-rag.md) |
| Agent 轨迹 | 目标是否完成；工具、参数、顺序、步数有无问题 | Trace、工具调用与结果、步骤级归因 | [OpenAI trace grading](https://developers.openai.com/api/docs/guides/trace-grading)、[AgentEvals](https://github.com/langchain-ai/agentevals/blob/main/README.md)、[DeepEval Agent guide](https://github.com/confident-ai/deepeval/blob/main/docs/content/guides/guides-ai-agent-evaluation.mdx) |
| 整体任务与运行 | 用户任务在真实约束下是否完成；变更后性能、稳定性是否退化 | 可重置环境、最终状态断言、线上指标与回放样本 | [SWE-bench](https://github.com/SWE-bench/SWE-bench/blob/main/README.md)、[WebArena](https://github.com/web-arena-x/webarena)、[Google SRE canary](https://sre.google/workbook/canarying-releases/) |

ISO/IEC 25010:2023 是软件产品质量的九特性参考模型，供质量需求、测量与验收使用；它没有提供一个通吃 Agent 行为、软件正确性、可靠性的单一分数。[ISO/IEC 25010:2023](https://www.iso.org/standard/78176.html) 因此 Craft 应保留不同维度和证据，不以均值掩盖失败类别（此句为架构推论）。

### 离线、线上与发布门槛

LangSmith 官方将离线评测用于基准、单元与回归，将在线评测用于生产监测，并支持代码评分器、模型评分器、复合与两两比较。OpenAI 的 Trace grading 用结构化分数/标签评价 Agent Trace，并在多样本上比较改动。Google SRE 的发布实践把测试、金丝雀和 SLO 作为不同阶段的证据。[LangSmith evaluation types](https://docs.langchain.com/langsmith/evaluation-types)、[OpenAI trace grading](https://developers.openai.com/api/docs/guides/trace-grading)、[Google SRE canary](https://sre.google/workbook/canarying-releases/)

推论：Craft 应区分 **离线回归通过、候选版本放行、线上效果观察** 三种结论。它们共享任务定义和指标，但各自有不同数据来源与证据强度；线上无人工参考标签时，不应把自动分数直接宣称为业务正确性。

## 值得借鉴的 GitHub 项目

| 项目 | 可核对的设计 | 可借鉴处 | 不宜直接照搬处 |
|---|---|---|---|
| [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai) | `Task = dataset + solver + scorer`；任务可复用不同执行和评分配置。[官方任务文档](https://inspect.aisi.org.uk/tasks.html) | 统一运行契约及评分器插件 | 其任务/评分器是 Python 代码，加载不受信任评测代码有执行风险；项目自身有[安全说明](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/SECURITY.md) |
| [OpenAI Evals](https://github.com/openai/evals) | 数据集 JSONL、注册表、`name.split.version` 命名。[构建指南](https://github.com/openai/evals/blob/main/docs/build-eval.md) | 样本与评测版本分离、可比性显式化 | 其示例偏模型输入输出评测；Craft 还需环境状态和 Agent 轨迹 |
| [AgentEvals](https://github.com/langchain-ai/agentevals) | 轨迹严格、有序/无序、子集/超集匹配，并提供模型评分。[README](https://github.com/langchain-ai/agentevals/blob/main/README.md) | 同一轨迹可配不同宽严程度的规则 | 把单一“金标准路径”强加给可接受的多条路径会误判；需按任务选匹配策略（推论） |
| [DeepEval](https://github.com/confident-ai/deepeval) | 最终输出、整轨迹、步骤三个范围；工具正确性、参数正确性、任务完成、步数效率等指标。[Agent 指南](https://github.com/confident-ai/deepeval/blob/main/docs/content/guides/guides-ai-agent-evaluation.mdx) | 评分范围与故障归因绑定 | 模型裁判结果需要校准，不能代替确定性环境断言（推论） |
| [Phoenix](https://github.com/Arize-ai/phoenix) | OpenTelemetry Trace、版本化数据集、实验与评分器，支持 Python/TypeScript。[README](https://github.com/Arize-ai/phoenix) | Trace、样本、实验关联；开放遥测格式 | 它是完整观测平台；Craft 若仅需本地子能力，整套服务和存储成本较高（推论） |
| [promptfoo](https://github.com/promptfoo/promptfoo) | 声明式配置、CLI/CI 与红队用例。[README](https://github.com/promptfoo/promptfoo)、[红队配置](https://github.com/promptfoo/promptfoo/blob/main/site/docs/red-team/configuration.md) | 把安全/越权场景纳入版本化评测套件 | 红队覆盖不能推导正常任务成功率（推论） |
| [SWE-bench](https://github.com/SWE-bench/SWE-bench) / [BrowserGym](https://github.com/ServiceNow/BrowserGym) | 前者以任务环境与测试评估代码补丁；后者统一网页任务环境与多种 benchmark。[SWE-bench README](https://github.com/SWE-bench/SWE-bench/blob/main/README.md)、[BrowserGym README](https://github.com/ServiceNow/BrowserGym) | 任务级隔离环境、可执行成功判据 | 公共 benchmark 分数不等于 Craft 的真实任务质量（推论） |

## 测量风险：需要设计进平台，而非留给报告解释

1. **数据污染与任务失效。** OpenAI 先推出人工验证的 SWE-bench Verified，后来公开说明其中仍存在问题描述/测试缺陷及训练污染，并停止用它报告能力。基准集必须有来源、冻结版本、泄漏风险、可解性复核及失效流程。[Verified 发布说明](https://openai.com/index/introducing-swe-bench-verified/)、[后续复核](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
2. **模型裁判偏差。** MT-Bench 原始研究报告位置、篇幅和自我偏好等风险。需要固定裁判版本/提示词、保存逐项理由、抽样人工校准；可确定性断言的问题先不用模型裁判。[MT-Bench 原始论文](https://arxiv.org/abs/2306.05685)、[LangSmith 代码与模型评分器](https://docs.langchain.com/langsmith/evaluation-types)
3. **观察不等于真值。** OpenTelemetry GenAI 语义约定覆盖 Agent、模型、检索、工具等操作，但输入消息、指令、工具参数/结果可含敏感信息，需截断、过滤与授权。[OpenTelemetry GenAI 属性](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)、[OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-js/guides/tracing/)
4. **性能与成本是独立维度。** Google SRE 用服务目标和金丝雀观察发布风险；Agent 轨迹评测也区分任务完成与步骤效率。应同时报告成功率、延迟/预算/工具成本、失败类别及未判定比例，不能只报一个总分。[Google SRE canary](https://sre.google/workbook/canarying-releases/)、[DeepEval Agent metrics](https://github.com/confident-ai/deepeval/blob/main/docs/content/guides/guides-ai-agent-evaluation-metrics.mdx)

## 从业界经验推导的通用接口

建议把子能力的稳定接口限定为：`EvalCase`（版本化样本及预期/不变量）→ `SubjectAdapter`（模块、Agent 或产品入口）→ `Run`（固定被测版本、环境、随机性与预算）→ `Evidence`（输出、Trace、状态、日志与外部回执）→ `Scorer`（确定性/人工/模型）→ `Verdict`（逐项、含未判定）→ `Comparison`（同一数据集上的候选与基线）。这是从 Inspect、OpenAI Evals、LangSmith、AgentEvals 的共性作的归纳，不是任何单个项目的原样 API。[Inspect Tasks](https://inspect.aisi.org.uk/tasks.html)、[OpenAI Evals](https://github.com/openai/evals/blob/main/docs/build-eval.md)、[LangSmith](https://docs.langchain.com/langsmith/evaluation-types)、[AgentEvals](https://github.com/langchain-ai/agentevals/blob/main/README.md)

模块接入时只提供 **被测对象适配器、任务样本、专属判据**；整体评测编排多模块及环境判据。Trace/Telemetry 是证据来源，不能兼任评分真值。判分器应带版本、适用范围、输入证据需求、失败/未判定语义。比较结果要固定任务集、被测构建、配置、模型/工具版本与环境快照；否则变化无法归因。这些是架构建议，下一节用当前 Craft 源码核对。

## 与当前 Craft 源码核对

以下结论来自 2026-10-24 当前 `main` 工作树，含尚未发布的改动；它们说明源码结构，不证明已安装 Host 的运行效果。

| 已有实现 | 现有作用 | 对统一评测的含义 |
|---|---|---|
| [`core/evaluation-contract.ts`](../../core/evaluation-contract.ts)、[`core/eval-suite.ts`](../../core/eval-suite.ts) | 前者分机制、夹具、协议、集成、Host、业务、可路由阶段；后者固定 suite 摘要，区分能力、安全、价值，保留未运行和未判定 | 可以沿用证据层级与分账原则；单个通过率不能代替整体验收 |
| [`core/application/coordinators/evaluation-runs.ts`](../../core/application/coordinators/evaluation-runs.ts)、[`core/eval-campaign.ts`](../../core/eval-campaign.ts) | 已有版本化 Suite、Trial、Outcome、聚合、配对比较、候选/基线 Slot；自动 Runner 目前只执行 Workflow，Agent 由 Host 绑定真实 TaskRun | 优先抽出共用的运行与比较内核，不再造第二套 Campaign |
| [`core/retrieval-evaluation.ts`](../../core/retrieval-evaluation.ts)、[`core/context-host-evaluation.ts`](../../core/context-host-evaluation.ts) | 前者跑带标签的检索语料，报告 recall、precision、漏检和成本；后者绑定真实 Host 发出的 Context 引用并评估检索/引用，明确不证明模型实际使用 | 同一“检索”需要区分模块效果、Host 交付和任务价值，不能只看一层 |
| [`core/delivery-evaluation.ts`](../../core/delivery-evaluation.ts)、[`core/task-benchmark.ts`](../../core/task-benchmark.ts)、[`core/agent-eval-lab.ts`](../../core/agent-eval-lab.ts) | 将真实 TaskRun、Delivery、终态再观察与可比环境连接；缺交付或环境不一致返回待定 | 整体任务应消费这些事实链，而不根据 Agent 的完成宣告造真值 |
| [`capability/craft-experience/scenario-evaluation.ts`](../../capability/craft-experience/scenario-evaluation.ts)、[`core/application/engineering-evaluation-runner.ts`](../../core/application/engineering-evaluation-runner.ts) | Experience 有影子/留出/金丝雀数据集合同；工程 Profile 有隔离执行和程序验收 | 领域判据与环境执行仍应留在拥有它们的模块或 Host Adapter |

[`core/capability-catalog.ts`](../../core/capability-catalog.ts) 仅登记 Knowledge、Memory、Experience、Codebase；`capability/craft-eval/` 是评测脚本目录。前述判断是源码推论，不能当作安装态或真实 Host 效果证明。

### 推荐的 Module 与 Seam

建议建立不对外默认执行的 `craft-evaluation` **评测运行 Module**，依赖现有 Trace、Store、TaskRun/Outcome/Evidence；各能力提供自身的 Subject Adapter 和评分判据。它位于能力输出之后、Signoff/Canary 之前，不让 Knowledge、Experience 等反向依赖它，以免形成循环。已有 `evaluation_suite`、`trial`、`outcome`、`evaluation_run`、Campaign 优先保留并收敛，不批量改名或搬数据。

```text
模块或 Host 的真实执行 → Observation/Evidence → 评测运行 Module → Assessment/Comparison
        ↑                         ↑                    ↓
  各能力的 Subject Adapter     版本化 Case/Scorer      原有 Signoff/Canary 读取结果
```

外部 Interface 先保持五项：`defineSuite`、`planRun`、`recordObservation`、`assessRun`、`compareRuns`。这些动作隐藏样本版本锁定、证据校验、缺失处理、可比性检查和聚合。只有 `Workflow`、`Host TaskRun`、`Retrieval` 这些已有实际执行路径才需要 Subject Adapter；不预先定义任意脚本执行器。评分器可先只接程序断言与已登记的人审 Evidence；模型裁判作为需校准的可选 Adapter。发布决策继续由现有 Signoff/Canary 持有，评测结果本身不授予发布权。

### 层次与阶段是两条轴

| 评测层 | 合适的判据 | Craft 首个接入点 |
|---|---|---|
| L0 代码/协议 | 确定性断言、属性/兼容性/并发/安全测试 | 现有测试与 Evaluation Contract |
| L1 能力输出 | 固定 Case、范围不变量、检索/路由/证据质量 | Retrieval、Knowledge、Memory、Codebase、Experience 各自的 Adapter |
| L2 Agent 轨迹 | 工具选择、顺序、越权、恢复、成本及失败归因 | Trace + Host TaskRun + Context emission；不把 Trace 当成功判据 |
| L3 整体任务 | 外部环境最终状态、验收程序、人工接受与任务价值 | Delivery、TaskBenchmark、Engineering Runner |

每一层可在开发、冻结留出、金丝雀/线上观察阶段运行。线上未标注轨迹只作异常与回归线索；不能因为命中监测规则就提升为业务正确性。能力、安全、价值各自报告。所有报告显式列计划数、实际运行数、有有效判分数、通过数、失败数、未判定数和缺失数；通过率必须携带分母。候选与基线只在 Case 版本、被测版本、模型/工具、环境和预算条件可比时比较。

### 最小落地次序

1. 对现有 `evaluation_suite`、`trial`、`outcome`、`delivery_evaluation_case` 和各能力专用 Case 做映射清单；标出同义字段、真正冲突的语义与历史数据。先定一份可核对的运行身份与证据契约。
2. 选 Retrieval 和 Host TaskRun 两条差异明显的路径接入同一运行/结果 Interface。以现有定向测试和真实 Host 观察分别验收，证明接口既可评模块也可评整体。
3. 把缺失/未判定、Case 泄漏、Scorer 校准、基线可比性和成本预算做成明确拒绝条件，再让既有 Signoff/Canary 消费统一评测回执。
4. 最后接线上采样与金丝雀，不把线上自评回灌冻结留出集。新增 Case 先脱敏、独立复核、版本化，记录失效和撤销。

非目标：第一版不承载任意动态代码执行、不替换现有单元测试框架、不把每个模块的领域判据迁入通用内核、不生成一个跨质量维度的总分，也不自动发布候选。

## 进一步：软件改动怎么评测

**先确定被测对象。** 软件评测的 Subject 是一个固定构建或补丁及其部署配置；Coding Agent 评测的 Subject 才是能产生这个补丁的模型、提示词和 Harness。前者的成功判据应尽量取自运行后的软件行为与环境状态；Agent Trace 只用于归因。SWE-bench 的隔离 Harness 用 `FAIL_TO_PASS` 和 `PASS_TO_PASS` 检查修复与回归，并专门区分测试未真正运行的基础设施故障；这提供了一个可借鉴的任务级骨架。[SWE-bench Harness](https://github.com/SWE-bench/SWE-bench/blob/main/docs/reference/harness.md)、[SWE-bench grading.py](https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/grading.py)

一次 `SoftwareCase` 至少固定：需求/缺陷、起始版本、目标接口或环境、验收判据、原有回归判据、允许的改动范围、依赖与数据快照、运行预算、判据版本及审核者。`SoftwareRun` 固定候选构建、运行环境、实际执行命令、退出码、日志摘要、前后状态和每个判据的证据引用。`SoftwareVerdict` 分 `resolved`、`regressed`、`failed`、`inconclusive`、`invalid_case`；测试未启动、依赖安装失败、超时、日志不可解析不算通过。每个 Run 报告计划、实际执行、有效判分、通过、失败及缺失数。

| 变更类型 | 关键验收 | 需要避免的误判 |
|---|---|---|
| 缺陷修复 | 旧版在冻结条件下以**预期错误**复现；新版验收通过；原有行为仍通过 | 旧版因网络/依赖坏掉而失败，也被算作复现 |
| 新功能 | 需求例子、反例、接口合同和跨模块调用通过 | 只测试新函数，遗漏实际调用链 |
| 重构/迁移 | 行为等价、历史数据/版本可读、崩溃与回滚路径、跨版本兼容 | 只验证新数据，不验证旧数据和恢复 |
| 性能/可靠性 | 同负载与环境下的延迟分布、吞吐、错误率和资源预算 | 单次快跑就宣称变快；把基础设施抖动当回归 |
| 安全变更 | 越权、输入边界、日志泄露和失败关闭的负例 | 正常路径通过就宣称安全 |

工程上分四道门：① **Case 质量门**，先验证起始版本与判据本身，区分无效/失效 Case；② **隔离执行门**，用固定快照、依赖与命令运行候选；③ **任务判分门**，验收、相邻回归和不变量逐项判定；④ **发布观察门**，小流量看真实错误率、时延和回滚触发。ISO/IEC 25010 给出质量特性的参考模型，但每项软件改动应按风险选择具体质量维度与判据，而不是逐项平均打分。[ISO/IEC 25010:2023](https://www.iso.org/standard/78176.html)、[Google SRE Canary](https://sre.google/workbook/canarying-releases/)

**用 Craft 最近的数据库拆分举例：** 临时库测试“新 Trace 进分片、主库写锁不阻塞、旧记录仍可读”属于机制证据；从正式库副本做迁移演练，核对迁移前后版本/摘要/备份/恢复与文件大小，才是数据迁移验收；加载新插件后的真实 Host 调用与锁等待分布是运行证据。三者应分别出报告，不能用一个绿色测试替代后两者。当前 [`EngineeringEvaluationRunner`](../../core/application/engineering-evaluation-runner.ts) 已有冻结缺陷复现、程序验收、两个相邻调用检查、改动范围和原始夹具不变检查，但限制在声明的 Node 命令、一类夹具和固定五次配对。通用化应抽出 Case/Run/Evidence/Verdict 契约，由项目注册可信命令与隔离环境 Adapter；原 Runner 保留为具体 Adapter，不直接放宽任意命令执行。
