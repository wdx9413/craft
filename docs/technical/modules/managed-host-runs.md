# Managed Host Runs：后台运行、进度与取消

v0.11.4 在统一 Host Driver 之上增加进程内运行管理。目标是让常驻的 MCP 或 Workbench 进程可以启动一个已准备的 Codex/Claude Dispatch，同时继续响应状态查询和取消请求。

## 当前协议

- `craft_host_run_start` 只接受已准备、摘要绑定的 Dispatch；Prompt 只转交给 Driver，不写入 Host Run 记录。
- 进度事件只保存 `stdout/stderr` 流向、字节数和内容摘要，不保存输出正文，最终受限内容仍由 Driver 回执处理。
- `craft_host_run_get` 返回持久状态、事件时间线以及当前进程是否仍持有控制器。
- `craft_host_run_cancel` 只允许拥有真实 `AbortController` 的进程取消，避免把数据库状态变化误当成子进程已经停止。
- 每个 Run 持久绑定 `owner_id`；`craft_host_run_recover` 必须指定该 Owner 并显式确认原 Runner 已停止，才把它的 `running/cancel_requested` 记录转为 `interrupted`。

## 承诺边界

进程内管理器仍可由 MCP 使用；v0.11.5 另外提供本地 Supervisor，使一次性 CLI 能通过认证 IPC 启动、查询和取消由 Supervisor 持有的任务。CLI 退出不会释放任务，但 Supervisor 退出会失去对子进程的可靠控制。进程崩溃后当前版本不会重新附着旧进程、重放 Prompt 或声称任务仍受控。

下一步是把同一事件协议接入 Workbench 流式界面，并增加由桌面壳托管的自动启动与升级生命周期。远程 Supervisor、系统级服务和崩溃后进程重附着仍不在当前承诺范围。
