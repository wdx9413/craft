# Local Maintenance Worker：持续运行的本地控制面

## 目的

Craft 的等待、恢复、投机候选和供应链治理不能只依赖用户偶尔调用 MCP。v0.10.6 提供跨平台本地 Worker，把不需要模型判断的维护动作周期化，同时保持“维护”和“代替用户执行任务”的权限边界。

## 每次 Tick 做什么

1. 回收过期的 Recovery 与 Hydration Lease；
2. 过期清理仍未决策的 Speculative Candidate；
3. 对本地已登记 Hub Source 执行供应链 reconcile；
4. 从最新事实状态重新投影 Recovery Queue；
5. 写入 `maintenance_status` 和 `~/.craft_data/runtime/maintenance-worker.json` 心跳。

Worker 不自动恢复 Durable Wait、不执行外部副作用、不运行补偿、不下载 Hub 内容、不重新认证能力。它只产生或刷新可审查工作，后续仍由具有匹配能力、预算和授权的 Host 领取。

## 生命周期与跨平台

- `craft worker tick` 运行一次确定性维护，适合 cron、systemd timer、Windows Task Scheduler 或 CI。
- `craft worker run --interval-ms 30000` 以前台常驻方式运行，SIGINT/SIGTERM 会触发释放锁和最终状态写入。
- `craft worker status` 同时核对状态、锁 Token、主机和本地 PID，旧心跳不会被误报为在线。
- `runtime/maintenance.lock.json` 使用独占创建确保同一数据根只有一个 Worker；锁 Token 防止进程误删他人的锁。
- 异常退出后的接管必须同时满足同一主机、旧 PID 明确不存在、心跳超过安全期限；旧锁会改名保留为恢复审计记录。
- 每次 Tick 生成不可变 `maintenance_tick` 回执，最新状态只保存其引用与聚合计数。
- 各维护组件独立记录健康状态、连续失败数、错误类型与不可逆错误指纹；原始异常正文不落库。
- 失败组件采用有上限的指数退避，连续三次失败进入 open 状态；到达探测时间后自动重试，成功即关闭熔断。其他组件继续运行。

当前没有把 Worker 自动注册为系统服务，也没有提供远程健康端点。跨主机共享同一数据目录时，Craft 不会接管其他主机的锁，需要部署层协调或人工审查。
