# Agent-Native Workspace

## 定位

`WorkspaceState` 是 Craft 的共享状态源，而不是新的聊天记录。它把一个明确的本地根目录、允许纳入的相对路径、Checkpoint、人工改动和关联 Artifact/Evidence 放进同一条可查询谱系。

## 对外深模块

```text
WorkspaceState
  open → checkpoint → diff → humanChange → approved restore
```

调用方只能声明已有根目录和要纳入的相对路径。Craft 不自动执行 Git 命令；可选 `git_baseline_ref` 只是宿主提供的可审计引用。这样 CLI、Codex、Claude 或未来 Canvas 都能共享同一个工作状态，而不会由某个宿主私有化。

## 安全与一致性

- Snapshot 仅复制声明路径内的普通文件，拒绝绝对路径、`..` 越界和符号链接。
- 每个条目保存 SHA-256 与大小；`diff` 只比较两个不可变 Checkpoint 的摘要。
- 人工改动只记录摘要和受影响路径，不吸收原始业务文本，并递增 Workspace 状态版本。
- Restore 只恢复声明路径，必须 `approved=true`；包含工作区根 `.` 的 Snapshot 不允许直接 Restore，避免一次调用删除整个工作树。

## 当前边界

v0.9.10 已提供文件状态、Checkpoint、差异与人工打断的可验证机制。Git 真实快照、数据库快照、远端对象存储与可视化 Canvas 仍是 Adapter/Projection 的后续实现，不能把当前的文件复制机制误称为通用事务回滚。
