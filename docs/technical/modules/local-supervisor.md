# Local Supervisor：单实例 Runner 与认证 IPC

v0.11.5 把 Host Run 的生命周期从单个调用进程提升为本机常驻控制面。用户先运行 `craft supervisor run`，随后其他 CLI、桌面壳或受信本地组件可通过 `~/.craft_data/runtime/supervisor.json` 中的私有连接信息访问回环端点。

Supervisor 只监听 `127.0.0.1`，每个请求使用恒定时间比较校验 Owner Token；连接信息和锁文件使用用户私有文件权限。它提供健康检查，以及 Host Run 的启动、查询和取消，不暴露通用命令执行接口。

每个 Run 保存 `owner_id`。启动时若发现旧锁，只在主机一致且旧 PID 已死亡时接管，并只把旧 Owner 的未完成记录标记为 `interrupted`。其他 MCP 进程或 Runner 的记录不受影响。这是状态恢复而非进程重附着：Prompt 不被保存或自动重放，外部副作用仍由原有幂等、对账和补偿协议处理。

当前 Supervisor 由前台 CLI 承载，不是 Windows Service、launchd 或 systemd 服务。v0.11.6 的 `craft serve` 会在同一进程托管 Workbench 与 Supervisor，网页和其他 CLI 因而操作同一个 Runner。事件界面按序号增量读取脱敏投影，不读取原始 Host 输出。后续桌面版应负责自动启动、状态托盘和升级迁移；远程接入必须使用独立认证与传输方案，不能直接开放本地端点。
