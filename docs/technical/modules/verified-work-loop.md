# Verified Work Loop、State Workspace 与 Eval Campaign

> 状态：v0.11.51 提供主链机制和脱敏 fixture；它不宣称任意业务 Harness 已经带来质量收益。

## 一个主入口，三个内部深模块

```text
VerifiedWorkLoop
  prepare → advance → decide → resume → get
       │
       ├─ State Workspace：预期状态 → Action/Receipt → 再观察 Snapshot
       └─ Eval Campaign：Case × Harness × N Trial → held-out comparison
```

`prepare` 将现有 Task、Task Control、初始 State Snapshot、Work Launch、Task Run 固定为一个不含 Prompt、凭据或原始业务正文的 Manifest。`advance` 重新读取 Host Receipt、环境/预算摘要和状态 Snapshot；Host 进程结束不是交付成功，只有后续 Acceptance 通过才会得到可交付状态。

`decide` 是人工操作的唯一入口：批准已准备的本地写 Launch、提交人工验收、或登记 `HumanStateEvent`。后者同时生成可查询的失效记录并使当前 Loop 停在 `needs_replan`；旧计划不会因为模型仍在上下文中就被继续使用。`resume` 在恢复前重新观察环境、预算和 Workspace，任何漂移都要求新建准备路径。

## State Workspace

首批 Adapter 是：

- `file_tree`：只观察 Workspace 已声明的相对路径；
- `file_artifact`：观察显式文件路径并关联已有 Artifact 引用。

Snapshot 保存路径、文件 SHA-256、大小、Workspace revision 和 Artifact ID，不保存文件正文。绝对路径、`..`、重叠路径、符号链接、非常规文件以及未声明 Workspace 都失败关闭。差异只给出新增、删除和修改的路径。

读任务不要求 OS 级沙箱；它仍受 Workspace 范围、只读 effect 和 Receipt 限制。`workspace-write` 继续经过既有审批/Platform Profile。外部写入仍由现有 effect/egress/compensation 机制处理，v0.11.51 不将其声称为通用事务回滚。

## Eval Campaign

Campaign 只计划并绑定已观察的 Task Run，绝不暗中启动模型、Host 或子 Agent。它固定：

- 已审核、脱敏且 `held_out` 的 Case 版本；
- baseline / candidate Harness 身份；
- 每 Case 至少两次 Trial；
- 环境、预算和验收引用。

每个 Slot 只能绑定同环境、同预算的一个 Task Run。所有 pair 都获得真实 Delivery 后才复用 Task Benchmark 聚合为 `eligible`、`rejected` 或 `inconclusive`。候选仍必须走既有最多两个设计轴、Signoff、Canary 与精确 rollback 协议；Campaign 从不直接发布、改 Prompt、改 Skill 或改默认路由。

## Serena 项目知识桥接

`ProjectKnowledgeAdapter` 只读取受信任项目根下 `.serena/memories/*.md` 的描述符和按需选中的一到三条内容。Discovery/Resolution 在 Craft 中只保存名称、相对路径、digest、大小和选择回执；内容仅在当前调用返回，默认不进入 `.craft_data`。内容漂移、疑似密钥、符号链接或超过预算均拒绝。

`proposeUpdate` 只生成带 Evidence 引用的草案，不写 `.serena`。Serena 继续拥有 LSP、符号编辑、项目 Memory 的维护和删除；Craft 只负责把必要项目知识变成有范围、可版本化的任务上下文。

## 非目标

- 默认多 Agent、通用世界模型/MCTS、任意模型脚本执行；
- 静态行业标签树、按目录复制 Workflow、远程 A2A/Hub 市场；
- 将 Serena 或 README 的叙述直接升级为 confirmed Evidence；
- 将 fixture 通过、单测覆盖率或单次 Campaign 称为业务质量提升。
