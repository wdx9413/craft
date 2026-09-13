# v0.12.8 Runtime Boundaries

v0.12.8 将自主循环从“可配置”推进到可审计的运行时边界：

- `InternalHostDriver` 支持 OpenAI/Anthropic 风格 Tool Call、会话续接、上下文压缩和受限动作白名单。
- `craft.trace` 是当前写入格式；`craft.trace.v1` 只用于兼容读取。Host Run、模型轮次和工具调用都写入同一条 Trace，并可映射 OTLP/HTTP。
- OS Security Kernel 为 Windows、macOS、Linux 生成网络、文件系统、Secret Broker 和失败关闭计划；未有验证证据时不会声称已隔离。
- MCP Registry Kernel 只保存 HTTPS 元数据、摘要、健康和撤回记录；Registry 导入不等于信任或执行授权。
- A2A Transport 发送无执行权、摘要化的 HTTPS 信封，返回有限远端回执；原始远端上下文不会进入 Craft 数据库。
- Organization Sync 先生成带摘要的清单，再按 base digest 应用；冲突和删除墓碑显式保留。

这些接口是跨 Codex、Claude、WorkBuddy、Trae 和独立 CLI 的共同底座。平台真实沙箱、Secret Broker、出站代理和加密同步仍由各平台 Adapter 提供证明。
