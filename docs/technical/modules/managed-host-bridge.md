# Managed Host Bridge

> 状态：v0.11.54 已实现本地 Codex CLI / Claude Code 的受控启动闭环。它不是远程 Agent 平台，也不会修改宿主的 MCP 配置或自动安装能力。

`HostBridgeKernel` 连接已准备的 `Execution Fabric` 与一次真实 Host Run。它只保存 Fabric、Manifest、Launch、Dispatch、Host Run 与 Activation Receipt 的精确引用和 Prompt 摘要；Prompt 正文只在启动调用期间传给 Host。

```text
Fabric prepare
  -> content-free Host Manifest
  -> Bridge invocation prepare
  -> manifest revalidation + one receipt consumption
  -> exact Host Run
  -> Host terminal receipt
  -> Workspace re-observation + Fabric advance
  -> Acceptance / Delivery / Outcome
```

## 启动规则

- 直接 `Work Launch` 保持兼容行为；由 Fabric 创建的 Launch 标记为 `deferred_start`，不能通过旧的通用启动入口绕过 Manifest。
- 只读 Launch 在 `craft_execution_fabric_execute` 中重新验证 Manifest、核对 Prompt 摘要并消费 Activation Receipt 后才启动。
- `workspace-write` 仍要求 `approved=true` 和 actor；Bridge 先消费精确 Manifest，再沿用既有一次性授权与 Host Run 路径。
- Host 终态由现有 `HostRunKernel` 回调。Craft 先归档 Host/Delivery 事实，再完成 Bridge 并重新观察 Work Loop；任何投影失败只形成可见事件，不能篡改 Host Receipt。

## Workbench 与 MCP

Core MCP 增加：

- `craft_execution_fabric_execute`：启动一个已准备 Fabric；写入另需审批；
- `craft_host_bridge_get`：只读查询 invocation；
- 已有 `craft_execution_fabric_get` 会返回相关 Bridge invocation。

本机 Workbench 的“开始工作”使用同一 Fabric endpoint；用户需要显式给出观察范围。选择知识 Bundle 时仍走已有知识绑定 Launch，因为它有独立的只读上下文边界。

## 非目标

- 不保证 Codex 插件在每一句对话中必然调用 MCP：Skill 是宿主提示策略，不是宿主级强制拦截器；
- 不启动/关闭第三方 MCP Server，也不向 Host 注入未在 Manifest 中列出的工具；
- 不将 Host 进程完成视为交付完成；
- 不提供跨平台沙箱证明、外部系统事务回滚或默认多 Agent。

关联：[Verified Execution Fabric](verified-execution-fabric.md) · [Verified Work Loop](verified-work-loop.md) · [Runtime 与宿主接入](runtime-integration.md)
