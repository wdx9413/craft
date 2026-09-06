# Craft 架构与可信控制面

[简体中文](architecture.zh-CN.md) | [English](architecture.en.md)

## 设计原则

Craft 采用“薄 Agent Loop，厚 Control Plane”。Codex、Claude、DeepSeek 等宿主负责理解、规划与探索；Craft 负责跨宿主保持稳定的状态、权限、副作用边界、证据来源、失败限制和恢复记录。

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

- `Capability`：索引后的 Skill 或未来的其他能力资产。
- `Task`：跨会话持续的用户目标。
- `Checkpoint`：任务或 Workflow 的可信接续位置。
- `Workflow`：有版本的目标、步骤、不变量与策略。
- `Session / Run`：一次具体执行及其不可变事件。
- `Artifact / Evidence`：当前先以引用和事件字段存在，后续升级为一等实体。

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

## 日志

MCP stdout 只输出 JSON-RPC。运行日志写到 stderr，默认 INFO；逐节点 transition 只在 DEBUG 显示。日志只选择安全元数据，不隐式序列化请求、结果或凭据。

## 本地存储

默认数据目录是 `~/.craft_data`，核心状态保存在 SQLite。`CRAFT_DATA_DIR` 仅用于测试和受管部署。业务项目不会被写入 Craft 数据。

## 后续演进

下一阶段包括 Artifact/Evidence 一等实体和 lineage、Workspace 快照、幂等外部操作与补偿、并行候选评测、远程 Hub 同步和可选向量检索。这些能力通过适配器扩展，不应绑定某一家模型。
