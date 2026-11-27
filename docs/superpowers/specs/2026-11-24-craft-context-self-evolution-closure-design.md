# Craft Context 自进化闭环补齐设计

状态：Draft，等待用户审阅；本稿批准前不修改产品代码。

## 1. 目标

让 Craft Context 的运行诊断准确反映每个子能力所处阶段，保证 Experience 候选完整继承来源与评测证据，并验证新插件在 Codex Host 中真正运行。最终以 Knowledge、Memory、Experience 各自独立的真实链路证明候选能够从捕获进入治理、启用、使用和效果反馈。

目标不是增加候选数量，也不把测试通过、包发布或一次检索命中描述为自进化完成。完整效果结论仍需真实独立任务和既有匹配评测门槛支持。

## 2. 当前基线

截至 2026-11-24 的核验结果：

- Craft 源码和 Marketplace 包是 `0.21.8`，当前连接的 Craft Context MCP 报告运行版本 `0.21.6`。
- 当前 Host 项目根目录 `/Users/didi/Documents/work/my-craft` 解析出的项目 ID 与回执 `project:1a01…` 相同。此前将 `craft/` 子仓库 ID 与工作区回执比较而推断身份错位的结论撤回；本次不迁移项目数据。
- 该数据空间有 71 条 Knowledge Claim，状态全为 `candidate`；Memory ledger 为 0，Experience workflow observation 为 0。Context 回执有 457 条、emission 5 条、feedback 393 条且均未评分。Knowledge 与 Experience worker 的进程存活未验证。
- 当前用户回执 `selected: []` 与没有已启用资产的状态一致；它本身不能证明解析器对所有任务都失败。
- 最近代码评审发现：`capability-iteration-gaps` 无条件报告插件版本、项目迁移和任务效果缺口；Experience graph/composition 草稿分支没有显式传递合并后的证据 ID。

以上数据用于区分代码缺陷和现有数据缺口。实现不得通过改写这些计数、回执或候选来制造完成状态。

## 3. 目标、非目标与约束

### 目标

1. 缺口诊断使用可观察的运行版本、身份/迁移状态、owner 可用性和评测报告，候选缺失时显示待积累，证据足够时允许对应阶段转为完成。
2. Procedure 的每条创建路径都绑定请求 Observation 的 Evidence，以及通过校验且匹配同一 Observation 的受控评测 Evidence。
3. 在隔离数据根和真实 Codex Host 中验证安装版本、Hook/MCP 执行、Worker 活性、候选状态、选中资产和反馈链。
4. 保持 Knowledge、Memory、Experience 各自的数据 owner、晋级门槛和启用语义，不以共享状态机替代子能力规则。
5. 代码差异的增量可执行行覆盖率和增量分支覆盖率均达到 100%。

### 非目标

- 不迁移当前工作区的项目身份或批量处理现有业务数据；当前项目身份已匹配。
- 不直接晋级现有 71 条 Knowledge candidate，不回放历史对话或手工制造候选/反馈写入正式数据空间。用户此前已授权的正常 Host 捕获可以自然写入正式数据，且正常候选保留；本次实现不得绕过既有 Hook、scope、脱敏和 owner 门槛。
- 不自动发布候选、放宽安全门槛、修改 Codex 模型、权限、用户配置或仓库规则。
- 不新增向量库、第五个 Context 子能力、远程常驻服务或自主改写 Agent。
- 不把本地模拟、单测或安装成功表述为真实业务效果提升。

### 约束

- 复用现有 Craft Core、Capability Owner、Craft-Eval/Workbench 合同与 Marketplace 打包流程。
- 缺少可验证的预期版本、owner 或评测来源时，诊断应显示 `unknown`/`unavailable` 或具体阻塞原因，不推断通过。
- 不把全局记录数当作项目级证据；任何晋级结论绑定精确 scope、资产版本、任务/会话身份和评测合同。
- 保持现有证据阈值：至少两个独立会话验证同一资产；三组匹配任务用于筛查，至少五组才作最早的效果判断。安全硬门槛不可被收益分数抵消。

## 4. 方案比较

### 方案 A：仅修复两个已知代码缺陷

修正静态缺口和 Experience 证据继承。交付快，但不能解释运行版本、worker 和使用效果，也不能证明真实链路，因此不满足用户希望的完整自进化目标。

### 方案 B：修缺陷并接通可审计闭环（采用）

修正诊断与证据传递；补充 Host 版本/Worker/真实资产选择的验收；按 Knowledge、Memory、Experience 分别核对候选、晋级、启用和反馈。使用隔离数据验证机制，再由真实会话积累业务效果证据。该方案复用现有 owner 和门槛，能区分机制完成与效果未证明。

### 方案 C：新增统一自动发布或新存储层

扩大权限和数据面，且无法解决当前版本未加载、候选未晋级和反馈未评分的问题。不采用。

本次按方案 B 执行。用户选择的是完整闭环补齐，不是直接处理现有生产数据或自动发布候选。

## 5. 设计

### 5.1 动态且失败关闭的缺口诊断

修改 `capability-iteration-gaps`：

- 插件状态区分预期版本、观测到的运行版本及版本来源。只有拿到可信预期版本时才能判定 `runtime_pending`；版本来源不可得时显示 `unknown`，不能永久声称插件缓存过旧。
- 项目身份缺口从当前 `project_root` 的规范身份和迁移记录计算。身份已解析且无待处理迁移时不显示迁移阻塞；缺 scope、别名冲突或 owner 不可用时显示具体原因，不触发数据写入。
- Context 使用缺口区分“没有 emission”“没有 asset ref 被标记为 used”“feedback 未评分”和“评测 owner 不可用”。计数非零不代表效果成立。
- 复用关系只由精确、经过验证的任务记录计算。任务效果只有在同一 project scope、候选版本、冻结合同、独立匹配任务及可信报告均匹配时才可解除阻塞。不能只看有无 `task_effect_evaluation` 记录。
- 诊断阶段允许 `mechanism_ready`、`evidence_pending`、`runtime_pending`、`owner_unavailable`、`effect_pending` 和 `verified` 等明确结果；全局完成状态不以“创建了候选”代替。
- 保留 content-free 输出，不暴露候选正文、Prompt、路径敏感信息或会话原文。

### 5.2 Experience 证据完整性

修改 `workflowEvolutionProposalSubmit` 到 Procedure draft 的映射：

- graph/composition、prompt、workflow、幂等恢复等分支都传递同一份经校验的 `procedureEvidenceIds`。
- 所有证据仍须来自请求 Observation 或与这些 Observation 精确绑定的通过态受控评测；拒绝调用方提供无关 Evidence。
- Procedure 保存候选创建时的 Evidence ID 和版本引用；证据缺失时拒绝草稿，不生成一个看似完整但无来源的候选。

### 5.3 三条子能力各自闭环

| 子能力 | 捕获/候选 | 晋级/启用 | 使用/反馈验收 |
|---|---|---|---|
| Knowledge | 精确来源、claim、scope、候选状态 | 现有 source/evidence/review/eval owner 门槛 | 下一任务回执选择该精确 claim，记录 used ref 与终态结果 |
| Memory | 显式或经 Host 验证的捕获，scope 与脱敏证据 | 现有冲突、独立支持和层级晋级门槛 | 正确作用域注入，使用记录引用 ledger 条目；未评分反馈不算收益 |
| Experience | terminal verification 写入 Observation，来源与场景可复核 | Procedure 继承证据，经过 Shadow、Held-out、Signoff、Canary 后才可 routeable | 后续真实任务记录精确 Procedure 调用、验证结果、纠错与回滚信号 |

这三条链共享 Context receipt 和诊断格式，但候选语义、阈值和发布权归各自 owner。

### 5.4 插件和 Worker 运行验收

- 更新 Marketplace 包后在当前 Codex Host 安装并重启 MCP 会话。
- 通过真实 MCP `doctor` 核对运行版本与包版本一致；通过 worker 诊断验证 Knowledge/Experience Worker 存活，而不是只看 owner PID 记录。
- 在临时数据根执行隔离 smoke：确认捕获只写入临时数据；正式状态不被修改；阶段推进和重启恢复可观察；context resolution 选择预期的测试资产；反馈写回精确 receipt/ref。
- 合成/固定夹具只写入临时数据根；正式数据不做直写、回填或历史会话重放。用户正常任务经过已授权的 Host 捕获入口时，可以自然产生并保留候选及反馈。
- 同一任务/会话产生的候选不能被计作独立留出、匹配对照或效果证据；候选后续复用必须来自不同任务和独立会话，并符合既有门槛。

## 6. 状态和失败处理

| 条件 | 诊断结果 | 行为 |
|---|---|---|
| 未检测到可信版本来源 | `version_unknown` | 不宣称已安装新包；提示从 Host 外部核对插件缓存 |
| 插件版本不匹配 | `runtime_pending` | 不运行晋级写入；安装并重启后复查 |
| 项目身份未解析或 scope 冲突 | `identity_pending` | 失败关闭，只生成只读迁移/冲突计划；等待授权 |
| owner/worker 不可用 | `owner_unavailable` | 不把不可读计数当 0，不宣称无候选或已完成 |
| 候选缺独立评测 | `evaluation_pending` | 继续隔离，不进入检索/路由 |
| 任务有使用但无可信结果 | `effect_pending` | 只报告使用，不报告效果 |
| 安全门失败、候选退化或效果不确定 | `held`/`rollback_required` | 不推进当前版本，保留原因与可恢复状态 |

## 7. 验收

### 自动化验证

1. 缺口诊断对旧版本/匹配版本/未知版本、身份已匹配/迁移待审、owner 不可用、未评测/合格效果报告分别给出正确状态；通过与失败样例都要有行为断言。
2. 每个 Procedure 创建分支都保留同一组 Observation Evidence 与受控评测 Evidence；错 scope、错版本、失败报告及伪造 Evidence 被拒绝。
3. Knowledge、Memory、Experience 在临时数据根各自完成候选、门槛、启用/保持隔离、实际选择/调用和反馈关联；交叉 scope 的记录不能被选中。
4. 版本不匹配、worker 停止、评测缺失和 Host 重启均显示可恢复阻塞，不重复晋级或重复写入。
5. 所有本次新增/修改的可执行行覆盖率与分支覆盖率分别达到 100%；按差异基线报告覆盖数/总数。

### Host 与价值验收

- 本地隔离 Host smoke 证明安装包版本、工具面、Hook/MCP、Worker 和数据根相互匹配；它只证明机制。
- 真实 Host 必须证明正常任务可以产生候选；后续独立任务若尚未自然发生，复用/效果状态保持 `evidence_pending`，不能用临时夹具或同一会话自评替代。
- 宣称业务效果前，使用冻结合同和预算完成三组筛查、至少五组独立匹配任务的效果判定；记录失败、成本、安全和回滚结果。
- 无真实独立任务时，最终状态保留 `evidence_pending`，不得把代码实现或 synthetic smoke 标为自进化业务效果完成。

### 发布核对

- Craft、Capability、Marketplace 各仓版本、build inputs、包 digest 和远端提交分别核对。用户已明确授权 Craft/Capability 同步、Marketplace 打包、远端推送和插件升级；本次延续该范围，不做 npm 发布。
- 推送后升级本机 Marketplace 插件并在新 Host/MCP 会话核验运行版本。包构建、远端同步、安装和 Host 加载作为不同证据报告；不声称当前旧会话已热更新。

## 8. 实施边界与顺序

1. 先修 `capability-iteration-gaps` 的状态判定与覆盖测试。
2. 修复 graph/composition 证据丢失，覆盖所有 Procedure draft 分支。
3. 接通每个 owner 的只读诊断投影，校验 scope、Worker、评测报告和使用反馈；不复制 owner 状态机。
4. 在临时数据根跑三个组件闭环 smoke，修正 `selected: []` 的原因并验证预期资产能被选中。
5. 构建 Marketplace 包、安装并重启 Host，按真实版本/Worker 状态复核。
6. 最终以真实独立任务效果评测决定是否可声称闭环完成。该阶段不能由合成数据替代。

## 9. 待实施者决定

- 版本预期值从安装插件 manifest、MCP 启动参数还是 Host 提供的 readiness 信息读取；优先复用现有 manifest/launch contract，不新增第二套版本配置。
- 用户数据仍不迁移。若未来确认真实 scope 冲突，再输出备份与 dry-run 清单，等待单独的数据迁移授权。
- 如果真实 Host 环境缺少可信独立评测器，候选停在 `awaiting_adapter`/`effect_pending`，不自动回退到自评通过。
