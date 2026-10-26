# XERJ 与 Harness-of-Harness 对 Craft 的启发

> 调研日期：2026-10-26。结论来自 XERJ 官方仓库/案例和 Harness-of-Harness 论文/官方实现。项目方报告的基准结果不是 Craft 的实测收益，也不构成独立复现。

## 结论

这两项工作补的是不同层：XERJ 让代码检索少读无关正文；Harness-of-Harness（HoH）把长任务拆成可验收增量，并把独立验收证据交给下一轮规划。两者和 Craft 的方向一致，但不应据此替换现有能力或直接增加一套平行控制面。

## XERJ：检索收益有明确适用条件

XERJ 的官方案例把 2.7 倍说得较窄：在 8 个模型训练中未见过的代码任务、4 种语言、每个方案 16 次运行的对照里，XERJ 与 grep 基线均为 16/16 通过；作者报告总输出 token 为 9,982 对 26,477，费用为 1.58 美元对 3.27 美元。这个数字指特定任务的**输出 token**，不是总 token，也不是所有编码任务的预期降幅。案例使用 purpose-built 的陌生 API 和隐藏行为测试来隔离检索价值；作者也指出，模型已经熟悉的常见代码上检索可能只增加开销。[XERJ 官方实验摘要](https://github.com/xerj-org/xerj)；[案例设计、结果与限制](https://github.com/xerj-org/xerj/blob/main/docs/case-studies/reference-coding/CASE_STUDY.md)

**对 Craft 的建议：**把 XERJ 当作可替换的检索适配器候选，优先测模型不熟悉的内部代码和非 Markdown 资料。与现有 Context/Codebase 在同一冻结任务、模型和预算上对照，记录通过率、输入与输出 token、费用、延迟、误召回、漏召回和索引快照。未显示净收益前，不引入为它单独维护的必需服务；也不让其替代 Craft 的项目范围权限、来源治理或 Codebase 提交/工作区绑定。

## HoH：最值得借鉴的是候选冻结和证据回流

HoH 的每轮由 Planner、Developer、QA Tester 三次角色调用组成；论文说明三者使用同一 harness-model 配置，角色边界由各自的输入、权限和输出约束形成。Planner 读取固定规格、上一轮证据和只读工件，产出有界开发文档；Developer 是工件唯一写者，并从上版工件继续修改；QA 对冻结、只读候选执行与需求对应的检查，逐条绑定证据、记录 `verified` 或 `gap`，再把证据交回下一轮 Planner。验收不会依据 Developer 自述或源码中“看起来已实现”来推定成功。[HoH 论文：方法与独立 QA](https://arxiv.org/abs/2609.01481)；[官方实现](https://github.com/Flesymeb/HarnessOfHarness)

作者在三个基准、三组 harness-model 配置的三轮主实验中报告相对独立 harness 的提升；论文摘要报告平均相对增益 52.25%。另有一个多日 FPS 开发展示超过 70 轮。后者是案例展示，不等同于 70 轮独立任务的成功率，也不能证明通用稳定性或自动发布安全性。论文当前是预印本，以上都应标为作者报告的证据，而非行业定律。

**Craft 现状边界：**仓库已有 `VerifiedWorkLoop` 固定 Task/Contract/Run/初始快照，`ManagedRun` 绑定运行观察、Receipt、交接和重规划，`EvalCampaign` 固定 held-out Case、baseline/candidate Harness、重复 Trial、环境与预算，并要求绑定真实 Task Run。它们目前也明确不暗中启动 Host 或直接发布候选。[Verified Work Loop 与 Eval Campaign](../technical/modules/verified-work-loop.md)；[Managed Run 与 Evaluation Lab](../technical/modules/managed-run-evaluation-lab.md)

因此，HoH 不是“Craft 还缺一条全新工作流”。**真正待验证的是这些现有对象之间是否已经以同一个候选快照和 Evidence 连起来**，以及是否具备 Developer 独占写入、QA 对冻结快照只读、证据不能跨版本混用的执行边界。新记录只在现有 Work Loop/Managed Run/Campaign 无法表达候选摘要、独立 QA 结果或证据版本绑定时才新增。

**对 Craft 的建议：**

1. 先把迭代控制关联到现有 Task/Work Loop、候选版本、Checkpoint、Trace/Evidence 与评测记录；只有现有对象无法表达的状态再补字段或接口，避免重复造第二套工作流和日志。
2. 将候选工作区冻结为明确的提交与脏文件摘要；QA 只读该快照，输出带候选哈希、验收条件、证据引用、缺口和 verdict 的记录。
3. Planner 只消费冻结候选的独立 QA 证据，决定接受、拒绝、阻塞或重规划。模型可以复用；关键是 QA 的数据和写入权限与 Developer 分开，且不得在验收时修补候选。
4. 一次迭代只承诺可验证的增量。若 QA 期间候选快照改变，验收结果作废并重跑；若回归，重新打开对应结论并指向上个通过版本。

## 判断

侧会话的结论方向正确。需要收紧两处表述：XERJ 的 2.7 倍是一个小规模、特定陌生代码任务上的输出 token 结果；HoH 的 70+ 轮是单个多日开发案例。Craft 应吸收“按需检索”和“冻结候选—独立验收—证据回流”这两个机制，先用真实 Craft 项目测收益，再决定是否增加新服务或控制面。
