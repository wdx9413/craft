# Runtime Truth Layer（v0.12.8）

v0.12.8 把运行时事实从“某个宿主的日志”提升为跨入口协议：

- `craft.trace.v1` 仍可读取；新写入使用无版本名的 `craft.trace` envelope，并通过 `schema_revision` 演进字段。
- Internal Host 的模型请求、Tool Call、工具结果、最终回合和失败都会自动关联到同一条 Trace；Trace 只保存摘要、Digest、引用和用量，不保存 Prompt 或业务正文。
- OpenAI-compatible 与 Anthropic Tool Call 被归一为同一组 `{id,name,arguments}`；SSE 帧只接受 JSON `data:`，`[DONE]` 结束帧不会进入记录。
- 会话超过窗口时保留系统约束和最近工作，旧回合被替换成带 Digest 的压缩笔记；恢复只读取同一会话的检查点。
- `craft.trace` 可映射到 OTLP/HTTP `resourceSpans`，外部导出器必须由宿主提供 endpoint 和网络权限。

Runtime Truth 不扩大默认 MCP 工具面。路由 Skill 仍先决定是否需要 Craft；只有选中的 Runtime/Trace 能力才通过 Full MCP 或显式 syscall 调用。
