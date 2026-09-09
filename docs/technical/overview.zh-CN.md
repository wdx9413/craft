# Craft 技术方案总览

## 目录

- 分层
- 核心对象关系
- 设计约束
- 模块文档

## 分层

产品对应 [三大支柱与十个模块](../product/architecture.zh-CN.md)。下图是目标架构，含尚未实现的 UI、同步、自动 Driver、状态依赖与后台学习；当前对象关系和实现参考单独列出。

```text
Canvas / 文档与领域视图 / CLI / Plugin / MCP
                     │ 同一状态与动作协议
┌ 工作与协作 ─────────────────────────────────┐
│ Goal/Constraints · Workspace/Artifacts · Capability/Context │
└────────────────────────────────────────────┘
                     │ 版本化输入与计划
┌ 执行与保障 ─────────────────────────────────┐
│ Planner/Agent IR · Runtime/Adapters · Sandbox · Verification │
└────────────────────────────────────────────┘
                     │ 实际结果与来源
┌ 学习与改进 ─────────────────────────────────┐
│ Eval/Experiments · Memory · Adaptation · Compiler/Reuse      │
└────────────────────────────────────────────┘
 权限与归属 · 事件与通知 · 成本与资源 · 领域扩展与接入
                     │
 追加事件 + 版本记录 + 可重建投影 + 外部产物引用
        SQLite / ~/.craft_data（当前存储实现）
```

Provider 模式由宿主负责模型请求、原生工具和审批，Craft 只能对经过自身协议的操作作出保证。独立 Agent/Supervisor 形态通过可替换 Driver 使用模型与执行环境，不把推理、会话记录和沙箱绑在一个产品中。当前已有 Codex CLI 与 Claude Code Driver、进程内受管运行，以及用认证回环 IPC 提供跨进程控制的本地 Supervisor；尚未提供系统服务安装、远程控制或崩溃后子进程重附着。

同机入口使用同一配置与数据目录；跨设备使用相同协议不代表已实现同步。业务文件保留于用户选择的位置，Craft 管理数据仍默认写入 `~/.craft_data`。远程权威数据以标识、来源版本和受控查询连接，不复制成无来源的第二份真相。

### 优先稳定的三类契约（目标）

- **工作对象与变更**：对象 ID、版本、目标与验收、输入依赖、已接受产物、证据有效性；提交携带预期基线，冲突不静默覆盖。明确依赖驱动局部失效，推断关联只触发复核。
- **动作**：类型化输入/输出、读写范围、前后置条件、effect、权限、预算、模拟能力、幂等/补偿和验证器。生成 UI、脚本和 Host 都调用同一动作入口。
- **反馈与复用**：结果来源、适用范围、用户修正与理由、候选 diff、评测版本、采用与撤回。当前任务临时调整不能直接修改全局默认策略。

v0.11.20 固定第一条能力平面边界：**Source Mount 是 provenance，逻辑 Capability 是可发现实体**。不同目录、软链接或镜像可以共存；同内容由摘要归并为一个逻辑能力，搜索按 Source 优先级选择一个实例并保留全部来源。同一声明身份的不同内容形成 Conflict，不允许静默覆盖。v0.11.21 补上版本化 Context Profile 和不派发执行的协作 Task Graph：前者把上下文范围、选择器、必选材料和预算固定下来，后者将这些 Profile 精确绑定到通用工作节点。v0.11.22 将任务选中的逻辑能力、内容摘要、来源选择和可选 Context Profile 版本固定为只读 Activation Plan；审计会区分镜像重选、内容变化和来源缺失。v0.11.23 在交付实际内容前再次读取文件、校验摘要、脱敏检查和字符预算，并把无正文的 Resolution 作为本地回执。它们都不授予执行权限，也不替代 Capability Asset 的信任、健康和副作用控制。显式 Workflow scope、语义路由与跨能力完整性审计仍是下一阶段目标，不能作为当前能力宣称。

这些契约扩展已有 Task/Artifact/Operation/Evidence，不为每个产品名建立一份相互不同步的状态。共享状态、实际执行与证据是自研重点；沙箱引擎、模型服务、浏览器及通用编辑组件优先通过适配复用。

## 核心对象关系

```text
Capability Kit ──contains──> Capability / Validator / Policy / Eval Suite
Capability Source(s) ──mirror──> Logical Capability ──pins──> Activation Profile ──issues──> Capability Call / Receipt
Task ──compiled to──> Agent IR ──lowered to──> Workflow / Orchestration Plan
Task ──has sourced, correctable──> Context Profile
Task + Subject Version + Harness Configuration ──creates──> Trial
Runtime Policy + Environment Fingerprint ──controls──> Runtime Run / Operation DAG
Autonomy Policy + exact Request Digest ──authorizes once──> Host Action
Schema Observations ──infer/review/probe──> Verified non-executable Contract
Orchestration Plan + pinned Agent Profile Versions ──auto-captures──> Trial / Trace / Outcome
Trial ──appends──> Trace ──produces──> Artifact / Evidence
Source Versions + Transform + Evidence ──derive──> Output Version (Lineage)
Trial ──closes with──> Outcome ──aggregated by──> Evaluation Run
Comparable Evaluation Runs ──produce──> Evaluation Comparison
Trial + Grader Version ──produces──> Grade
Evaluation Run + Grades + Signoff Policy ──produces──> Signoff
Signoff ──authorizes──> Workflow or Configuration Promotion
```

## 设计约束

- 版本引用必须精确，不用“当前最新版本”替代历史执行事实。
- Trial、Outcome 和 Evaluation Run 创建后不可覆盖；Trace 只能追加。
- Comparison 只接受相同 Suite 精确版本、分区、Subject 类型和 Case 集合；原始 delta 不冒充统计显著性。
- 程序、模型、人工和业务结果分别记录 provenance。
- Search/Development Case 不得作为 `verified` 晋级证据。
- 副作用、预算和宿主 Sandbox 是不同边界，不能互相替代。
- 自动优化只操作明确声明的设计空间，并保留回滚点。
- 运行中路由使用 Plan 创建时锁定的 Agent Profile 版本，不随“最新版本”漂移。
- 确定性指可复算的状态转换、权限和回执规则，不保证模型输出或外部系统结果确定；读取历史记录与重新执行分别标记。
- 生成 UI 是受控组件投影，不能绕过动作授权；文件树只是可选访问面，不暴露全部内存、密钥或内部推理。
- Context Window 由模型服务限制；CVMM 是应用侧检索/压缩/外存的类比，缓存身份必须包含范围和版本。
- 后台整理只在授权范围与预算内运行；候选生成、评测与正式采用分离，原始审计事实不被经验摘要覆盖。
- 学习收益计入离线编译与评测成本，迁移和历史保持另行验收，不能只看单次通过率或代码覆盖率。
- 外部内容始终携带不可信来源标签；解析器、规划器和执行器以权限分离形成边界，不能把“双模型”本身当作安全证明。
- UI 只展示计划、假设、动作、证据和资源状态，不要求模型泄露私有思维链；用户干预形成新的可审计 ChangeSet。
- 存储接口优先保证追加事实、版本引用和投影重建，不因“AI OS”叙事提前绑定某一种时序图数据库。

## 模块文档

- [Attention Inbox：统一注意力收件箱](modules/attention-inbox.md)
- [Workbench Home：工作台首页投影](modules/workbench-home.md)
- [Local Workbench Web：本地可见工作台](modules/local-workbench-web.md)

- [Capability 与领域 Kit](modules/capability-kit.md)
- [Agent IR](modules/agent-ir.md)
- [Experience / Eval Kernel](modules/experience-eval.md)
- [Workflow / Verification / Signoff](modules/workflow-signoff.md)
- [Runtime 与宿主接入](modules/runtime-integration.md)
- [Codex CLI Host Driver](modules/codex-host-driver.md)
- [Claude Code Host Driver](modules/claude-host-driver.md)
- [Managed Host Runs：后台运行、进度与取消](modules/managed-host-runs.md)
- [Local Supervisor：单实例 Runner 与认证 IPC](modules/local-supervisor.md)
- [Work Launch：从目标到受控运行](modules/work-launch.md)
- [领域验收计划：执行成功与业务正确分层](modules/acceptance-plan.md)
- [领域验收执行器：版本化 Evaluator 与租约 Job](modules/acceptance-execution.md)
- [Closed-loop Runtime](modules/closed-loop-runtime.md)
- [Agent-Native Workspace 与生成界面](modules/agent-native-workspace.md)
- [沙箱与风险分级执行](modules/execution-policy.md)
- [Transactional Runtime 与 Trajectory Compiler](modules/transactional-runtime.md)
- [上下文与记忆管理](modules/context-memory.md)
- [控制面安全、资源与长任务护栏](modules/control-plane-guardrails.md)
- [Provenance 与对象级 Lineage](modules/provenance-lineage.md)
- [长任务 Dehydration / Hydration](modules/long-task-hydration.md)
- [分级自主权与审批控制面](modules/tiered-autonomy.md)
- [Contract Inference：动态契约推导](modules/contract-inference.md)
- [Capability Canary：能力灰度与运行证据](modules/capability-canary.md)
- [Capability Federation：可审查的团队与组织能力共享](modules/capability-federation.md)
- [Hub Sync：大规模能力目录的可信增量同步](modules/hub-sync.md)
- [Capability Materialization：能力内容按需落地](modules/capability-materialization.md)
- [Capability Certification：候选能力认证与晋级](modules/capability-certification.md)
- [Supply-chain Governance：可信能力的持续治理](modules/supply-chain-governance.md)
- [Local Maintenance Worker：持续运行的本地控制面](modules/local-maintenance-worker.md)
