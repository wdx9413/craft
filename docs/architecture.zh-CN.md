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

- Capability 以 Source 内逻辑相对路径作为身份，以真实路径作为当前位置。目录链接改指向后更新位置，不把同一能力先更新再误删；并发扫描使用递增 generation，较早扫描不能覆盖较新快照。复扫先比较 mtime_ns 与文件大小，未变化 Skill 不重读正文或重算摘要。
- 路径大小写遵循宿主文件系统语义：Windows 归一化大小写，大小写敏感平台保留区别。
- Workflow 在执行任何步骤前验证全部跳转目标、结构字段和权限声明。带路由的流程只能进入可审计的 Session Runtime；线性 `workflow_run` 不会静默忽略 `on_result`。
- `needs_repair` Run 在再次执行命令前原子标记为 running，防止两个客户端同时重复领取同一次修复。
- Eval Result 的运行状态、Case 身份和重复提交检查在同一个写事务内完成；权重与分数必须是有限数，拒绝 NaN 和 Infinity。

## 本地存储

默认数据目录是 `~/.craft_data`，核心状态保存在 SQLite。`CRAFT_DATA_DIR` 仅用于测试和受管部署。业务项目不会被写入 Craft 数据。

## 后续演进

下一阶段包括 Codex/Claude/API Host Adapter、token/时间/成本预算、编排结果接入 Eval、自动 Eval Runner 与 Grader 适配器、Artifact/Evidence 一等实体和 lineage、Workspace 快照、幂等外部操作与补偿、远程 Hub 同步和可选向量检索。这些能力不应绑定某一家模型。
