# Execution Safety Preflight：已验证边界与资源契约

> 状态：v0.11.38 已实现。它不是操作系统沙箱，也不会把宿主声明误写为隔离保证。

在允许受控 Work Launch 前，Preflight 将精确版本的已验证 Sandbox Profile、工作目录、Host、读/写模式及 Host 资源上限固定为一个可审计记录。它复用 Sandbox Profile 的 Evidence 和验证结果，并要求 Host Dispatch 使用同一 `timeout_ms`、`output_limit`；Claude Code 额外固定 `max_turns` 和可选的预算上限。

```text
Verified Sandbox Profile + Evidence
                 │ compatibility dry-run
                 ▼
       Safety Preflight (exact profile/version/digest)
                 │ binds exact Host resource contract
                 ▼
       Safety-bound Work Launch ──> human approval ──> Host Run
                 │                         ▲
                 └──── revalidate profile + dispatch contract ────┘
```

`craft_safety_work_launch_prepare` 不改变 Host 的工具权限；它只创建普通 Work Launch，并写入 Preflight 血缘。对 `workspace-write`，`craft_safety_work_launch_decide` 会在人工批准前再次检查 Profile 仍为 `verified`、能力摘要未变，并核对实际 Dispatch 的资源值。变化即失败关闭。

`os_sandbox_guaranteed` 始终是 `false`：本模块证明的是 Profile/Evidence 与 Craft 向 Host 传递的资源限制，不证明内核级文件、进程、网络或凭据隔离。Docker 或未来平台 Adapter 的独立黑盒证据才可支撑更强的环境结论。
