# Craft v0.12.5 Gap Audit

基于当前源码、适配器和 Workbench 路由复核，主要缺口已经从单个内核能力转移到产品化边界：

1. 普通用户需要一个配置与成本入口；本版加入 Settings/Usage Control Center。
2. `~/.craft_data` 需要可迁移且能被 CI/绿色包隔离；本版支持 `settings.json` 的 `dataRoot` 和 `CRAFT_DATA_DIR` 覆盖。
3. 桌面交付不能只依赖开发者命令；本版加入跨平台启动脚本、Windows 绿色 ZIP 和 macOS 原生 DMG 的 CI 产线。
4. Token 记录必须来自 receipt/Outcome/Autonomous Turn 的事实，而非模型自述；本版报表缺失字段即保持为零并保留来源边界。
5. 版本源必须单点化；package.json、服务、插件、WorkBuddy/DeepSeek adapter、README 和 CI version check 同步到 v0.12.5。

内核仍保持“能力资产动态装载、最小工具面、验证后复用、失败关闭”。因此没有为了 GUI 再引入重量级 Electron 依赖，也没有把所有 MCP 工具重新暴露到默认上下文。
