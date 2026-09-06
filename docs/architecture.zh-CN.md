# Craft 架构与可信控制面

[简体中文](architecture.zh-CN.md) | [English](architecture.en.md)

## 设计原则

Craft 是独立的 Agent Harness，不是 Codex、Claude 或某个模型产品的下层组件。它自身不绑定 Agent Loop；任何 Agent 应用或自定义程序都可以作为客户端，通过 MCP、插件或 CLI 使用 Craft。接入方可以负责理解、规划与探索，Craft 独立保持能力目录、状态、权限、副作用边界、证据来源、失败限制和恢复记录。

```text
Goal + Invariants + Permission Policy
                  ↓
             Host Agent
                  ↓
        Artifact / Evidence
                  ↓
 Program verifier / Model judge / Human
                  ↓
 pass / repair / fail fast / restore
```

## 核心对象

- `Capability`：Craft 对可发现能力资产的统一抽象；当前落地类型是 Skill，未来可以扩展插件和 MCP 服务元数据。
- `Task`：跨会话持续的用户目标。
- `Checkpoint`：任务或 Workflow 的可信接续位置。
- `Workflow`：有版本的目标、步骤、不变量与策略。
- `Session / Run`：一次具体执行及其不可变事件。
- `Artifact / Evidence`：当前先以引用和事件字段存在，后续升级为一等实体。
- `Evaluation`：当前以有版本的 Case Suite、Eval Run 和不可变 Case Result 作为一等实体，可评测 Capability、Skill、Workflow、工具、MCP、插件、Agent、模型、系统或组合。
- `Agent Profile`：有版本的角色、宿主、供应商、模型、推理强度、能力标签和副作用上限。
- `Orchestration Plan / Node / Lease`：任务依赖图、节点路由候选、并发领取和不可重复提交的执行凭据。

## Skill、MCP、插件与 Workflow

这些概念属于不同层次，不能全部叫插件：

- `Skill` 是方法与指令，告诉 Agent 怎样完成一类任务。
- `MCP` 是连接协议，Server 向 Client 暴露工具、资源或提示模板。
- `Plugin` 是面向某个平台的安装和分发包，可以组合 Skill、MCP Server 及其他组件。
- `Workflow` 是任务编排与验收定义，可以引用多种能力。
- `Capability` 是 Craft 内部用于检索和关联这些能力资产的上位概念。

当前 Catalog 只扫描并索引 `SKILL.md`。Craft 自身虽然以插件形式接入 Codex/Claude，并通过 MCP 暴露工具，但这不代表 v0.1 已经能够发现和索引任意插件或 MCP 服务。

## Workflow 节点

- `command`、`assertion`、`coverage_gate`：程序执行或确定性验证。
- `agent`：当前宿主自由探索并提交结果。
- `judge`：模型根据 rubric 和 Evidence 返回 `passed`、`failed` 或 `unknown`。
- `human`：等待人工批准或拒绝。

`invariants` 允许用户只声明“结果必须满足什么”。`program` 不变量必须包含 validator；`model` 和 `human` 不变量分别编译为 Judge 与 Human 节点。

## 权限与副作用

节点分为 `read_only`、`local_write`、`external_write`、`destructive`。Workflow 的 `permission_policy` 决定能力上限，运行调用中的 `approved_side_effects` 决定本次授权。两者都允许时才会继续。

兼容参数 `allow_execution=true` 只授予 `local_write`，不能扩大为外部写入或破坏性操作。宿主自身的 Sandbox 和审批仍然有效，Craft 不绕过它们。

## 证据与可信等级

事件通过 provenance 区分 `agent_reported`、`model_judged`、`program_verified` 和 `human_approved`。来源标签不能互相冒充。需要 Evidence 的节点在没有引用时拒绝接受提交。

程序检查通过或人工批准后自动形成内容摘要 checkpoint。Agent 或模型单独声称成功不会生成可信恢复点。`craft_workflow_restore` 从 checkpoint 创建新 Session，原始 Session 和失败证据保持不变。

## Fail Fast 与长任务恢复

`max_transitions` 限制修复循环；确定性 Run 还使用 `max_attempts` 和 `no_progress_limit`。恢复优先从最近可信边界派生，而不是把旧错误上下文无限重试。

## 多 Agent 与模型路由

Craft 保存宿主无关的 Agent Profile。每个 Plan Node 声明角色、目标、依赖、副作用和按顺序排列的 Profile 候选。`dispatch` 只领取依赖已经通过且未被其他宿主领取的节点，并受 `max_concurrency` 限制；失败提交会在仍有候选时回到 pending，下一次派发选择后续 Profile。前置节点最终失败或 blocked 时，下游节点级联 blocked。

Lease 具有 TTL 和所有者，可通过 heartbeat 续租。宿主中断后的 expired Lease 会被回收，节点仍从同一 Profile 重试；旧 Lease 不能再次提交。Plan 支持 pause、resume、cancel，失败节点支持显式 retry。控制与执行变化写入单调递增的不可变事件流，使新会话可以重建发生过什么，而不依赖旧对话上下文。

MCP Server 无权直接调用 Codex 的 `spawn_agent` 或 Claude 的内部 Task API。当前由 Codex/Claude Skill 或其他宿主读取 Lease Request，调用其原生执行能力，再提交带 provenance 的结果。后续宿主 Adapter 可以自动完成这段翻译，但不得绕过宿主自己的 Sandbox、审批和并发限制。

## 评测分层

- `Run validation`：判断一次执行是否满足程序、模型或人工验收条件，当前已实现。
- `Capability evaluation`：已能用同一版本 Case Suite 保存并比较 Skill、Workflow、Agent 和模型组合的人工、模型或程序结果；自动执行与 Grader 适配器待建设。
- `System evaluation`：同一套 Eval 实体可记录检索选择、长任务恢复、跨客户端一致性和安全边界结果；系统化 Case 集与自动回归任务待建设。

评测结果未来应为资产从 `candidate` 晋级到 `tested` 或 `reusable` 提供依据，但不得仅凭一次成功自动认定为长期可靠。

## 日志

MCP stdout 只输出 JSON-RPC。运行日志写到 stderr，默认 INFO；逐节点 transition 只在 DEBUG 显示。日志只选择安全元数据，不隐式序列化请求、结果或凭据。

使用 `CRAFT_LOG_LEVEL=DEBUG|INFO|WARNING|ERROR` 调整日志级别。

## 核心一致性约束

- Capability 以 Source 内逻辑相对路径作为身份，以真实路径作为当前位置。Source 根目录或嵌套目录链接改指向后都会刷新真实位置，不把同一能力先更新再误删；新目标已被其他 Source 注册时明确拒绝冲突。并发扫描使用递增 generation，较早扫描不能覆盖较新快照。复扫先比较 mtime_ns 与文件大小，未变化 Skill 不重读正文或重算摘要。
- 路径大小写遵循宿主文件系统语义：Windows 归一化大小写，大小写敏感平台保留区别。
- Workflow 在执行任何步骤前验证全部跳转目标、结构字段和权限声明。带路由的流程只能进入可审计的 Session Runtime；线性 `workflow_run` 不会静默忽略 `on_result`。
- `needs_repair` Run 在再次执行命令前原子标记为 running，防止两个客户端同时重复领取同一次修复。
- Eval Result 的运行状态、Case 身份和重复提交检查在同一个写事务内完成；权重与分数必须是有限数，拒绝 NaN 和 Infinity。

## 本地存储

默认数据目录是 `~/.craft_data`，核心状态保存在 SQLite。`CRAFT_DATA_DIR` 仅用于测试和受管部署。业务项目不会被写入 Craft 数据。

## 后续演进

下一阶段包括真实宿主兼容认证、预算自动接入 Workflow/编排派发、编排结果接入 Eval、自动 Eval Runner 与 Grader 适配器、Workspace 快照、外部操作补偿、远程 Hub 同步和可选向量检索。这些能力不应绑定某一家模型。

## 可靠执行与宿主适配（v0.1）

混合 Workflow 的确定性节点在执行前会原子创建 `workflow_execution` Lease，
Session 同时进入 `executing`。命令会获得稳定的 `CRAFT_IDEMPOTENCY_KEY`，下游
支持幂等时应使用该值去重。若宿主在命令开始后、回执落库前退出，Lease 过期后
进入 `result_unknown`，而不是被武断标记为失败或自动重跑。人工或宿主必须根据
外部证据确认成功、确认失败，或者明确批准重试有副作用的步骤。

SQLite 存储现在支持在线 backup、带确认开关的 restore，以及恢复前自动保留的
recovery backup。`store-doctor` 检查 SQLite 完整性、外键、Workflow 执行引用和
能力 FTS 索引漂移。

Codex 与 Claude Code 使用各自的原生插件清单并共享 Craft MCP；Claude 仓库同时
提供 Marketplace 清单。DeepSeek Harness 使用独立的 Cordis bundle，位于
`adapters/deepseek-harness`，它把 DSH 工具调用翻译为 Craft MCP 调用，不把
Python Core 重写成 TypeScript。`host-adapter-probe` 会区分“已声明支持”与“本机
可执行程序实际存在”。

当前仍需在安装了 Claude Code、Node.js 和 DeepSeek Harness 的环境做真实端到端
认证；没有完成的宿主实测不能只凭静态清单宣称通过。

## Artifact、Evidence、Lineage 与预算（Schema v12-v13）

Artifact 是产物引用，不等同于把文件复制进 Craft。它记录 `kind`、名称、URI、
媒体类型、摘要、大小、生产者和扩展元数据。URI 可以指向本地文件、对象存储、网页
或领域系统，因此代码报告、视频镜头、销售材料和学生作业不需要不同的核心表。

Evidence 保存一个明确 claim、来源类型、`confirmed / bounded / unverified /
rejected` 置信状态、可选 Artifact 和精确 locator。Lineage Edge 用有类型的实体端点
连接 task、workflow、execution、evaluation、artifact、evidence 或外部对象，并支持
有界深度的上游、下游与双向遍历。核心只保存关系，不假设某个平台的 Session ID
格式或本地路径分隔符。

Budget 由 owner 和一组自定义指标组成。每个指标声明 unit、soft limit 和 hard limit；
Usage Event 带来源及可选幂等键，多个宿主重复上报同一次计量时不会重复累计。Schema
v13 增加 Reservation：宿主执行前原子预留多指标容量，执行后按实际用量 settle，取消时
release，宿主崩溃后按 TTL reclaim。检查结果是确定性的 `continue / warn / stop`。预算仍
需宿主显式调用，下一阶段再把它自动嵌入每一种 Workflow 与 Orchestration 状态转换。

## 三种产品部署形态

Craft Core 不等于某一种 UI，也不等于必须依赖 Codex/Claude：

1. `standalone`（Craft Agent）：Craft 拥有会话和 Agent Loop。交互式 CLI、版本化 Provider Profile、持久 Turn/Event、结构化生命周期事件和受控 Tool Loop 已进入预览；API Key 仅在请求时从 Profile 指定的环境变量读取。桌面端与逐 Token 流尚未实现。
2. `supervisor`（Craft Supervisor）：Craft 拥有任务体验，把具体执行委派给 Codex、Claude、DSH 或自建 Host。编排、Lease、证据和预算协议已可用；原生 Host Driver 尚需兼容认证。
3. `capability-provider`（Craft Provider）：外部 Agent 拥有 Loop，Craft 通过插件、MCP、Skill、CLI 或 DSH Adapter 提供能力与状态。该形态当前可用。

`usage_mode_list/get` 提供机器可读的 Surface、所有权和成熟度边界。未来 CLI、桌面端、
Web 或 IDE 只调用同一 Application Service，不复制 SQLite Schema 或业务状态机。
