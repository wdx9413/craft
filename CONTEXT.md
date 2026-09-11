# Craft 领域词汇

Craft 是一个把任务、能力、执行事实和评测闭环连接起来的受控工作运行时。这里定义跨产品、MCP 和实现都使用的词；具体接口、版本和实现细节放在 `docs/`。

## 任务与状态

**Task**：用户希望完成的、可跨会话延续的工作目标。它不是一次模型调用或一次命令执行。
_Avoid_: 会话、请求、运行

**Task Contract**：一次任务执行所接受的工作范围、允许 effect、验收要求、能力和预算引用的精确约束。它不包含实现 Prompt。
_Avoid_: 提示词、执行计划

**Workspace**：人和 Host 共同处理的、显式声明范围的工作状态。它不是整个磁盘，也不是聊天历史。
_Avoid_: 项目目录、上下文

**State Snapshot**：对已声明 Workspace 状态的内容最小化观察，用于比较变化和判断是否需要重新规划。它不是可恢复的文件备份。
_Avoid_: Checkpoint、备份

**Workspace Checkpoint**：可恢复的已声明工作区文件基线。它不承诺恢复外部系统状态。
_Avoid_: 事务、全局回滚

**Artifact**：由工作引用或产生的外部对象，例如文件、报告或日志的受控引用。Artifact 自身不证明任何结论。
_Avoid_: 证据、结果

**Evidence**：支持、限制或否定一个明确 Claim 的可追溯依据。它不等同于模型判断，也不等同于 Artifact。
_Avoid_: 输出、观点

**Receipt**：某个 Host、Adapter 或控制协议观察到的动作事实记录。Receipt 证明动作或协议状态，不自动证明业务交付质量。
_Avoid_: Outcome、验收

**Outcome**：一个 Trial 的终态结论，基于已经记录的事实形成。Host 完成、领域验收通过和 Outcome 是不同层次的事实。
_Avoid_: 模型自述、Receipt

## 能力与上下文

**Capability Source**：被用户挂载、扫描或登记的能力来源。它回答内容从哪里来，不代表内容已经可用或可信。
_Avoid_: Capability Asset、Connector

**Capability Kit**：把 Capability、Policy、Validator 和 Eval Suite 打包在一起的可版本化供给单元。它不因为被安装就自动获得执行权。
_Avoid_: Capability Source、Activation Profile

**Logical Capability**：由多个同内容 Source 实例归并出的可发现能力身份。它用于检索和去重，不授予执行权。
_Avoid_: Capability Asset

**Capability Connector**：用户明确批准的外部能力元数据接入点，例如 MCP 或远程 Skill 来源。Connector 不保存凭据，也不替 Host 安装、启动或调用外部服务。
_Avoid_: Host、Capability Source

**Capability Asset**：带精确来源、版本、trust、health 和 effect 的受治理能力。它可以是 Skill、Tool、Workflow、Adapter 或验证器，但尚未被任务启用。
_Avoid_: 搜索结果、工具调用

**Activation Profile**：某个 Task 获准使用的最小 Capability Asset 集合及其精确版本和 effect 范围。它是启用约束，不是上下文正文。
_Avoid_: Context Profile、Activation Plan

**Logical Activation Plan**：把搜索选中的 Logical Capability、来源摘要和可选 Context Profile 固定为只读上下文候选的计划。它不替代 Activation Profile 的 trust 或 effect 门禁。
_Avoid_: Activation Profile、执行计划

**Context Profile**：为 Task 选择和限制上下文材料的规则，包括范围、必选材料和预算。它不授予能力或写入权限。
_Avoid_: Activation Profile、Memory

**Context Capsule**：给一次受限诊断子操作的最小引用包，包含任务边界和必要 Artifact/Evidence 引用，而非完整对话或原始敏感内容。
_Avoid_: Prompt、完整上下文

**Project Knowledge**：项目说明、经验或记忆等可按需读取的背景材料。它最多提供受限上下文，不能自动扩大权限或充当已验证事实。
_Avoid_: Evidence、Policy

## 执行与交付

**Host**：实际请求模型、调用原生工具或运行命令的外部执行环境，例如 Codex、Claude 或其他 MCP Host。Craft 对未经过其协议的 Host 行为不作保证。
_Avoid_: Craft Runtime、Agent

**Adapter**：位于一个明确 Seam 的 Host、Sandbox、Evaluator 或外部系统适配实现。Adapter 把外部差异收进实现，不改变上层事实语义。
_Avoid_: 模块、策略

**Work Launch**：把 Task Contract 交给一个 Host 前的受控启动请求。它需要的审批、范围和验收在启动前固定。
_Avoid_: Task、Task Run

**Task Run**：围绕一个 Work Launch 的可恢复运行清单，固定环境、预算和关键输入摘要，并投影当前安全下一动作。
_Avoid_: Host Run、Trial

**Verified Work Loop**：围绕一个 Task 的主控制循环：预期状态、受控启动、Receipt、重新观察、验收、交付或重新规划。它不执行 Host，只确保 Host 的自述不能跳过观察和验收。
_Avoid_: Workflow、Agent

**Sub-agent Operation**：父 Runtime Operation 下、为一个独立只读诊断目标创建的子 Operation。历史文档中的 “Sub-agent Run” 指此概念；它不是一个独立的根 Run。
_Avoid_: 独立 Agent、子任务线程

**Effect**：动作可能造成的状态影响等级，如 `read_only`、`local_write`、`external_write` 或 `destructive`。Effect 是权限输入，不是风险已被消除的证明。
_Avoid_: Sandbox、Approval

**Execution Decision**：对特定 effect、环境和审批条件的可审计准入结论，例如允许只读 Host 执行、要求隔离本地写入、要求人工审批或明确阻止。它不是 Host 已经执行的 Receipt。
_Avoid_: Policy、Receipt

**Workspace Transaction**：围绕已声明本地 Workspace 的可恢复协调记录；它以精确 Checkpoint 为基线和提交对象，不能承诺回滚外部 API、数据库或网络写入。
_Avoid_: 通用事务、外部回滚

**Acceptance**：对交付是否满足明确业务或技术条件的独立判断。它补充 Host Receipt，不能由模型声明替代。
_Avoid_: Host completion、Outcome

**Work Delivery**：对终态 Host Receipt 与 Acceptance 的只读交付观察，明确区分待验收、接受、拒绝、阻塞和 Host 失败。
_Avoid_: Host Run、Artifact

## 评测与演进

**Trial**：以精确 Subject、Harness、输入、环境和预算执行或观察的一次可比较尝试。它是评测的最小实验单位。
_Avoid_: Task Run、会话

**Trace**：追加式记录 Trial 中影响判断的路径事实。它不是完整思维链或原始对话存档。
_Avoid_: Prompt history、日志全文

**Evaluation Case**：带分区和验收标准的脱敏比较样本。`held_out` Case 不得被候选设计直接使用。
_Avoid_: 普通任务、生产数据

**Evaluation Run**：对一组可比较 Trial 或交付对照的聚合判断。它不是单次模型打分。
_Avoid_: Trial、Signoff

**Signoff**：基于精确 Evaluation 和 Grader 证据作出的晋级许可。它不等于发布、默认路由或实际执行授权。
_Avoid_: 评测分数、部署

**Candidate**：对 Workflow、Skill、Harness 或策略的受限改动提案。Candidate 必须先在隔离评测或 Canary 中证明价值，不能直接覆盖生产默认值。
_Avoid_: 已验证能力、发布版本

**Trajectory Script Proposal**：由已通过 Trial 引用的、受限且版本锁定的自动化脚本候选。它不接受任意源码，也不从原始 Trace 直接推导为可执行程序。
_Avoid_: 动态代码、已发布脚本

**Verified Script Run**：把已验证的 Trajectory Script Proposal 与同一 Workspace 的已准备 Transaction 绑定后的精确 Host 操作单。逐项回执只能结束该运行，不能绕过 Policy、评测 Gate 或把任意 TypeScript 变成可执行代码。
_Avoid_: 直接脚本执行、Task Run

**Canary**：向有限、可观察范围暴露已签发 Candidate 的验证阶段。回归会停止候选流量并指向精确回滚目标。
_Avoid_: 自动发布、A/B 结论
