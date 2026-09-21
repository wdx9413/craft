# Craft 领域词汇

Craft 是一个把任务、能力、执行事实和评测闭环连接起来的受控工作运行时。这里定义跨产品、MCP 和实现都使用的词；具体接口、版本和实现细节放在 `docs/`。

**Platform Ideal State v1**：Craft 第一阶段可宣告完成的平台边界：新能力无需修改核心即可受控接入，真实任务可执行、恢复、验收和比较。它以可复现工作证据判定，不以累计功能数量或追逐全部行业能力判定。
_Avoid_: 终极形态、功能全集、万能 Agent

**Reference Pilot**：用于证明 Platform Ideal State v1 的可重复真实任务纵切，固定输入基线、Host、环境、预算、验收和失败分类。首批由一个 Codex 研发 Case 和一个文件型非研发 Case 组成。
_Avoid_: 单元测试、演示、一次性成功案例

**Release Qualification**：发布前对 Reference Pilot 的机制门和价值门进行固定环境、等预算、重复配对运行后形成的准入结论。结论只能是 `eligible`、`rejected` 或 `inconclusive`，单次成功和单元覆盖率不能替代它。
_Avoid_: 测试通过、版本检查、模型自评

**Verification Plane**：开发变更的内容无关验证控制模块。它根据变更类别、effect、Candidate 与 Host 要求生成最小验证集，接收同环境、Evidence-backed Receipt，并输出 `eligible`、`rejected` 或 `inconclusive`。它不执行命令，也不替代 Release Qualification。
_Avoid_: 测试运行器、覆盖率报告、任意命令执行器

## 核心关系（Canonical Relationship）

**Agent**：模型与 Harness 的组合。模型负责理解、提议和局部推理；Harness 负责把提议放入受约束的上下文、能力、执行和验证循环。Agent 不是 Craft 的同义词，也不是一次聊天窗口。
_Avoid_: 把模型自述当作运行时事实

**Harness**：一次 Agent 工作的决策/行动策略。对外心智模型可写成 `harness = context + tool + permission + environment`：Context 提供受限输入，Tool 提供动作面，Permission 规定可做什么，Environment 负责在哪里、以什么生命周期和隔离边界执行。内部还包含 Orchestration、Verification 和 Recovery。Harness 使用 Runtime，但不等于 Runtime；它可以被评测和替换，也不能自行扩大 Policy。
_Avoid_: 把 Harness 当成模型、工具仓库或完整操作系统

**Environment**：Harness 的执行环境抽象，至少由 `Sandbox + Runtime` 组成。Sandbox 负责工作区、网络、进程和凭据的隔离边界；Runtime 负责 Run、Operation、Lease、Checkpoint、Receipt、取消、重试和恢复。某个平台可以只提供只读 Runtime 而没有可验证 Sandbox，此时高风险 effect 必须失败关闭。
_Avoid_: 把 Environment 误解成单一操作系统目录，或把 Runtime 误解成安全沙箱

**Tool**：Harness 看到的一个动作接口，例如读取文件、调用 MCP、运行受限命令、检索知识或请求 Host。Skill、MCP Server/Tool、插件和 Workflow 是 Tool 或能力的不同供给/包装形态；它们只有登记为受治理 `Capability Asset`、通过 Activation Profile 后才可能成为当前 Tool。
_Avoid_: 把 Skill 文件、MCP Server 或插件包直接等同于已授权 Tool

**Runtime**：承载可恢复执行的事实与生命周期内核，管理 Task Run、Operation、Lease、Checkpoint、Receipt、State Snapshot、取消和重试。Runtime 不负责替模型做领域推理，也不把 Host 私有执行伪装成自己的能力。
_Avoid_: 把 Runtime 与 Harness、Host 混称

**Host**：真正运行模型、原生工具或命令的外部执行环境，例如 Codex、Claude、CLI、API 或 Fixture Host。Craft 可在控制台模式复用当前 Host，也可在独立 Agent 模式选择 Host；两种模式共用同一 Control Plane 和证据模型。
_Avoid_: 误以为 Codex 插件会隐式再启动一个 Codex CLI

**Context**：面向当前模型/Host 的受限投影，不是事实存储。它可以引用 history、knowledge、memory、experience 和当前 state，但每次装载必须经过 Context Resolution 并留下 Receipt。
_Avoid_: 把 Context 当成 Memory、知识库或全局提示词

**State**：需要被观察、比较和恢复的事实，分为 Control State（Task/Run/Operation/Lease/Checkpoint）与 World State（Workspace、Artifact、外部状态的摘要）。Context 可以引用 State，但 State 不由模型上下文拥有。
_Avoid_: 把聊天历史或 State Snapshot 当成完整备份

**Goal**：用户希望得到的结果；**Task Contract** 是把 Goal 解释成有范围、effect、预算和验收条件的可执行合同；**Acceptance** 是对真实终态的判断。三者依次回答“想要什么、允许怎么做、是否真的达成”。
_Avoid_: 把 Goal、Task、Prompt 或 Outcome 混为一个对象

**Target**：对 Goal 的可执行化目标，固定对象/范围、期望终态、非目标和完成条件。模糊 Goal 先经过澄清才形成 Target；普通对话可以没有持久 Target。
_Avoid_: 把 Target 当成一句未经澄清的用户原话

**Plan**：为 Target 选择的候选实现路径，包含有序或有依赖的 Step、能力、权限、预算、前置条件和风险。Plan 是运行时计划，不自动成为可复用 Workflow；只有经过评测和发布的 Plan 才能形成 Workflow 资产。
_Avoid_: 把模型草稿、Workflow 和已批准执行计划混为一物

**Automation Job**：将一个已 `routeable` 的、确定性 Workflow Procedure 绑定到明确工作区、触发节奏、输入、允许 effect、验证 Step 和有限重试的持久执行委托。它可由 cron、CI、托盘或系统服务调用 Tick，但 Craft 不因此安装系统服务、保存凭据或把 Prompt/Graph 伪装成无人值守执行能力。每次执行都产生 Checkpoint、Receipt、Outcome；重试耗尽后转为 Handoff。
_Avoid_: 任意 Agent 对话、已安装 cron、自动化发布、Workflow 草稿

**Step**：Plan 中最小可观察工作单元，至少声明目标、前置条件、Action、预期状态变化、Receipt 和失败处置。Step 完成必须经过再观察，不能只由 Host 返回文本决定。
_Avoid_: 把模型的一次回复或一次 Tool call 自动当作已完成 Step

**Accept**：对 Target 的终态验收动作/策略；它可以由确定性断言、独立 Grader 或人工裁决组成，但必须引用 State Snapshot、Artifact 或 Evidence。`accept` 是主流程动作，不是布尔字段的别名。
_Avoid_: 把 Host completion、模型置信度或单个测试通过当成 Accept

**Interaction Mode**：同一运行时上的入口投影，而不是多套 Agent。`turn` 用于普通对话；`goal` 用于形成 Target/Task；`plan` 只生成或审查 Plan；`execute` 执行已批准 Plan；`verify` 只做 Step/Target 的证据验收；`learn` 从 Trace/Outcome 生成受限 Candidate。只有 `goal`、`execute`、`verify` 和 `learn` 涉及持久任务状态时才必须建立对应 Run；`turn` 可以在不创建任务的情况下完成。
_Avoid_: 把每种模式实现成一套独立 Store、Policy 或生命周期

**Hook**：挂在既定生命周期时点上的扩展机制，例如 `before_activation`、`before_execute`、`after_receipt`、`after_observe`、`before_accept` 和 `after_outcome`。Hook 可以观察、补充摘要或请求阻断，但不能自行成为新的事实账本、绕过 Permission、直接扩大 effect，或替代 Receipt/Acceptance。它是跨 Harness、Capability 和 Runtime 的设计范式/扩展 seam，不是 Harness 的第五个组成面。
_Avoid_: 把 Hook 当成任意 Tool、隐藏的第二条主流程或隐式副作用入口

**Knowledge / Memory / Experience / Trace**：Knowledge 是有来源和 Evidence 的可复核主张；Memory 是有作用域、有效期和撤销关系的可持续上下文；Experience 是从多个 Trial/Outcome 归纳出的学习域，包含 Observation、Pattern 与 Procedure；Trace 是过程证据链。Context 在开始时可受限装载三者：Knowledge 只读 reviewed Claim，Memory 只读当前有效条目，Experience 只读已 routeable 的 Procedure。Workflow/Graph Procedure 的权威内容是经摘要校验的 JSON 定义，Markdown 仅为审阅视图；Prompt Procedure 才以 Markdown 为权威正文。Observation、Pattern 与 Candidate 只供复盘/评测；Procedure 通过评测和晋级后才成为可路由资产。三者的 `scope` 只回答“适用于哪里”；归属、受众、用途、租期与 tenant 由 Scope Envelope 单独表达，不能从一条项目路径或模型猜测中推出。
_Avoid_: 把 Trace 直接当记忆、把未经验证记忆直接当 Skill

**Evaluation Contract**：每个可独立暴露的能力都必须声明 fixture、契约/边界、对抗与泄漏、恢复/幂等、成本/延迟和兼容性检查。`mechanism_passed`、`fixture_passed`、`host_verified`、`business_eligible`、`routeable` 是递进状态，不可用单元覆盖率或单次成功替代。
_Avoid_: 把组件的 MCP 握手当成业务效果证明

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

**Capability Kit Manifest**：Capability Kit 的声明式身份、精确版本、依赖锁、effect、数据范围、入口、可参与阶段、健康检查和评测套件。它不是可执行代码包，也不允许携带凭据。
_Avoid_: 插件包、安装脚本

**Capability Kit Activation**：将一个通过 Conformance 的 Kit 精确绑定到 Task 的可撤销记录。它只允许 Kit 提交阶段受限且无正文的提议/回执，不能给 Kit 授权、写入事实或绕过 Host。
_Avoid_: Activation Profile、工具调用

**Domain Kit**：面向某个工作领域的对象、界面、动作契约与验收组合。它可引用 Capability Kit，但不等同于外部扩展的分发和生命周期单位。
_Avoid_: Capability Kit、行业标签

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

**Knowledge Source**：带 scope、digest、trust 和外部读写边界的知识来源描述符，例如 Evidence Wiki、Serena、kefu、README。它不是知识正文、不是证据，也不因登记而自动被加载。
_Avoid_: Capability Source、Memory

**Memory Ledger**：带来源、范围、证据、有效期、敏感等级和撤销关系的工作/情景/偏好/程序记忆记录。它通过兼容绑定引用旧记忆，不强制迁移旧账本。
_Avoid_: Context Profile、Evidence Wiki

**Context Resolution Receipt**：一次向 Host 提供受限上下文的内容无关回执，固定选中的知识/记忆版本、选择理由和预算。它不保存重复正文，不授予执行权。
_Avoid_: Prompt、Activation Profile

**Scope Envelope**：认知记录的适用范围、归属（custody）、受众（audience）、用途（purpose）、留存（retention）和可选 tenant 约束。它不是简单 scope 层级，也不是 ACL 的替代实现；Context 先按明确 scope 栈选择，再按 Envelope 过滤。个人、项目、团队和组织资料不能因名称相似自动互相提升或合并。
_Avoid_: 全局默认、从模型文本推断身份、路径即团队身份

**Knowledge Support**：一条把 Candidate Knowledge Claim 与独立 Evidence/Observation 绑定的追加式支持记录。同一 Claim 上同一个 Evidence 或 Observation Key 只能计一次；它用于自动晋升阈值，不是聊天重复次数计数器。
_Avoid_: 同一段 Prompt 的重复提交、模型自评、人工审批票数

**Knowledge Promotion Policy**：本机的、可审计的自动晋升阈值。默认需要两条独立的 bounded/confirmed Evidence，且 Source、正文、有效期和冲突检查均通过；它允许操作者调整或熔断，不随跨机器数据包迁移。
_Avoid_: 默认人工审核队列、跨机器信任同步、LLM 自我认证

**Knowledge Contribution**：Context Resolution 中由 Knowledge Capability 提供的、只包含已自动晋升或例外复核且在 scope 内 Knowledge Claim 的有界投影。Candidate 可以被搜索、补证据和自动评估，但不能通过此投影进入执行 Host。
_Avoid_: 知识搜索结果、自动发布规则

**Knowledge/Memory Bundle**：在一个明确 scope 内交换可校验 Knowledge、Memory、其 Source/Evidence、追加式 Knowledge Support 和关联 Experience 引用的可移植数据对象。它以 `export → verify → import_plan → approved import_apply` 合并，只新增不覆盖冲突；本机 Promotion Policy 不迁移。它不是 SQLite 文件复制、云同步或凭据容器。
_Avoid_: 数据库备份、自动同步、跨租户复制

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

**Work Runtime Mode**：Console 或独立 Agent 的产品入口选择。它只固定模型、Host、Activation Profile 与 Context Receipt 的引用，下一步仍须进入 Verified Work Loop。
_Avoid_: Host、Execution Fabric

**Sub-agent Operation**：父 Runtime Operation 下、为一个独立只读诊断目标创建的子 Operation。历史文档中的 “Sub-agent Run” 指此概念；它不是一个独立的根 Run。
_Avoid_: 独立 Agent、子任务线程

**Harness Topology**：一个 Task 可选的 Agent 角色组合。唯一默认 Topology 是单个 `primary`；诊断、独立评估或远程只读角色必须先作为候选接受配对评测，才可被路由选择。
_Avoid_: 默认多 Agent、Agent 群

**Delegation Grant**：绑定父 Task Run、父操作、远端受众、能力/Artifact scope、effect、到期时间和撤销状态的一次性远程协作授权。它不是 A2A Card、网络 Token 或远端已执行的证明。
_Avoid_: A2A 会话、访问凭据、远程任务

**Artifact Grant**：从 Delegation Grant 派生的、对一个精确 Artifact 版本的只读引用授权。它不承载 Artifact 正文，也不能扩大父 Grant 的范围。
_Avoid_: 文件副本、共享上下文

**Runtime Readiness Assessment**：基于 Evidence、平台 Preflight、恢复能力及企业 Binding 得出的部署就绪检查。它只枚举已证实条件和阻塞项，不等同于已部署的 Host、Sandbox 或 Broker。
_Avoid_: 健康检查、上线证明

**Sealed Evaluation Case**：对独立批准的 held-out Evaluation Case 的内容无关引用，固定其版本与摘要。它不包含 Case 正文，也不授予读取正文的权限。
_Avoid_: Evaluation Case 副本、测试输入

**Sealed Evaluation Access**：绑定一个 Task Run、收件 Adapter、用途和到期时间的一次性 Sealed Evaluation Case 引用。它不是数据凭据，也不表示外部 Adapter 已读取 Case。
_Avoid_: token、Case 内容、Artifact Grant

**Recovery Drill**：通过 rehydration、Receipt 重验和状态再观察，并附确认级 Evidence 的受控恢复事实。它不等同于生产故障演练或平台隔离认证。
_Avoid_: 部署证明、备份

**Assured Pilot**：将可信 Capability Profile、已验证 Host Receipt、Runtime Readiness、Recovery Drill 与已消费 Sealed Evaluation Access 绑定的可比较运行样本。它不是业务 Outcome、生产发布或 Agent 成功声明。
_Avoid_: 上线实例、业务结果、已发布 Candidate

**Effect**：动作可能造成的状态影响等级，如 `read_only`、`local_write`、`external_write` 或 `destructive`。Effect 是权限输入，不是风险已被消除的证明。
_Avoid_: Sandbox、Approval

**Execution Decision**：对特定 effect、环境和审批条件的可审计准入结论，例如允许只读 Host 执行、要求隔离本地写入、要求人工审批或明确阻止。它不是 Host 已经执行的 Receipt。
_Avoid_: Policy、Receipt

**Workspace Transaction**：围绕已声明本地 Workspace 的可恢复协调记录；它以精确 Checkpoint 为基线和提交对象，不能承诺回滚外部 API、数据库或网络写入。
_Avoid_: 通用事务、外部回滚

**Acceptance**：对交付是否满足明确业务或技术条件的独立判断。它补充 Host Receipt，不能由模型声明替代。
_Avoid_: Host completion、Outcome

**Uncertainty Policy**：当验收或评测证据不足、接近阈值或相互冲突时，决定继续采证、请求人工、弃权、保持旧状态、拒绝或阻塞的版本化规则。它可以按 Global、Project、Task 或 Case 收窄行为，但不能低于 Core Safety Floor，也不能自动扩大 effect、权限或数据范围。
_Avoid_: 模型自报置信度、人工兜底、自动提权

**Adjudication**：人工针对普通质量分歧形成的追加式裁决，记录理由、范围、有效期和所依据的证据版本。它不删除原证据，不能绕过 Core Safety Floor，并会在相关状态或证据变化后失效或待复核。
_Avoid_: 覆盖证据、安全例外、人工通过

**Work Delivery**：对终态 Host Receipt 与 Acceptance 的只读交付观察，明确区分待验收、接受、拒绝、阻塞和 Host 失败。
_Avoid_: Host Run、Artifact

**Runtime Execution Attempt**：绑定 Task、Verified Work Loop、Run、Host、Environment、Effect 和幂等键的一次外部执行尝试。它只记录运行事实与引用，不保存 Prompt、Cookie、Token 或业务正文；Host 完成不是 Outcome。
_Avoid_: Host 进程、Outcome、自动重放

**Runtime Observation**：对 Attempt 当前外部状态的独立、追加式观察。`effect_unknown` 必须先进入 reconcile，不得自动重放原动作。
_Avoid_: Host 自述、Outcome

**Context Working Set**：一次工作实际允许进入 Host Context 的固定成员、引用、排除原因、预算和检索回执。`history` 由 Host 提供，`state` 来自当前任务；二者不是可插拔知识源。
_Avoid_: 全量历史、未筛选知识库

**Capability Intake**：Skill、MCP、Workflow、Adapter、Evaluator 等能力从发现、扫描、Conformance、审批到激活/撤销的统一供应链入口。可发现不等于可执行，扫描通过也不等于可路由。
_Avoid_: 自动安装、自动信任

**Graph Compilation**：将 Graph 静态校验、循环/重试/补偿分析后降低为 Verified Work Loop 的 Plan。Graph 不拥有 Runtime、权限或 Host 调用权。
_Avoid_: 第二套 Graph 执行器

**Workbench Command**：带 `command_id`、`task_id`、`expected_version`、`actor`、`decision` 和 `reason_digest` 的人机协作命令。Workbench 只调用 Craft Service，不直接写 Store。
_Avoid_: UI 私写状态、无版本覆盖

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
