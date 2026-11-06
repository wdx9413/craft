# Agent-Native Workspace

## 定位

`WorkspaceState` 是 Craft 的共享状态源，而不是新的聊天记录。它把一个明确的本地根目录、允许纳入的相对路径、Checkpoint、人工改动和关联 Artifact/Evidence 放进同一条可查询谱系。v0.11.52 在其上增加只保存摘要的 State Workspace Observation；v0.11.53 的 Execution Fabric 将“预期状态 → Action/Receipt → 再观察 Snapshot”与精确 Host Manifest 相连，不以模型自述收口。

## 对外深模块

```text
WorkspaceState
  open → checkpoint → diff → humanChange → approved restore
```

调用方只能声明已有根目录和要纳入的相对路径。Craft 不自动执行 Git 命令；可选 `git_baseline_ref` 只是宿主提供的可审计引用。这样 CLI、Codex、Claude 或未来 Canvas 都能共享同一个工作状态，而不会由某个宿主私有化。

## 安全与一致性

- Snapshot 仅复制声明路径内的普通文件，拒绝绝对路径、`..` 越界和符号链接。
- 每个条目保存 SHA-256 与大小；`diff` 只比较两个不可变 Checkpoint 的摘要。
- 人工改动只记录摘要和受影响路径，不吸收原始业务文本，并递增 Workspace 状态版本。被 Verified Work Loop 登记时会形成 `HumanStateEvent`，依赖旧 Snapshot 的路径进入 `needs_replan`。
- Restore 只恢复声明路径，必须 `approved=true`；包含工作区根 `.` 的 Snapshot 不允许直接 Restore，避免一次调用删除整个工作树。

## 当前边界

v0.9.10 已提供文件状态、Checkpoint、差异与人工改动登记。v0.10.0 增加版本化工作对象、来源路径、显式依赖、传递影响预览、`needs_review` 失效标记和状态修订并发保护。v0.10.1 进一步提供字段级 ChangeSet：未并发改动的字段可合并，同路径冲突拒绝提交。登记仍不会自动感知外部编辑或推断隐式依赖；富文本/列表协同也尚无专用合并器。Git 真实快照、数据库快照、远端对象存储与可视化 Canvas 仍是 Adapter/Projection 的后续实现，不能把当前的文件复制机制误称为通用事务回滚。

## Generative & Dual-Mode UI（目标）

- 人类使用文档、表格、分镜板、时间线、临时表单或看板；AI 使用类型化状态、文件/素材引用和按需上下文，两者共享同一状态源。
- 保留稳定的导航、项目、运行状态与恢复入口；模型先生成声明式组件描述，受控 Renderer 绑定已有对象和动作，不直接注入任意脚本。
- 组件和布局可随业务目标演进；无法生成或加载时退回通用对象/文件视图。界面失败不能丢失任务状态。
- 原生领域编辑器优先通过 Adapter 接入；不要求所有素材变成纯文本或复制到 Craft 数据库。

## 版本、依赖与人机修改（目标）

1. 对象与操作使用稳定 ID、Schema、revision、输入版本和来源；当前文件路径级快照是起点，不代表已实现语义对象图。
2. UI/文件编辑先产生变更，校验权限与 Schema 后提交；并发写携带预期 revision，旧执行结果触发冲突处理而非静默覆盖。
3. 记录产物的明确输入依赖和验收版本。依赖变化标记 `stale`/待复核，局部重做；推断的语义关联只触发检查。
4. 用户接受的部分可锁定为基线。支持方案分支、产物比较与显式合并；合并重新验证相关约束。
5. 归档与删除分离，项目搜索连接任务/成果/决策。跨设备同步、远程引用和冲突解决独立设计，不将“同一协议”称为已同步。

## 成果与交付（目标）

验收包含可编辑性、指定格式、来源与实际可打开性，例如 PPTX 不能用 HTML 冒充。重要动作显示改动对象与差异，完整日志按需展开。用户可局部修改并继续执行，不要求通过新 Prompt 重生成整份成果。

关联：[产品架构](../../product/architecture.zh-CN.md) · [事务与编译](transactional-runtime.md) · [上下文与记忆](context-memory.md)
