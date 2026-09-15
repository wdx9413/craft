# Trace Archive Store

`TraceArchiveStore` 是 Trace Kernel 的一个深模块：它只负责把一个已经终态的 Trace Bundle 写入或读取，并返回不暴露真实文件系统或对象存储地址的 Archive Pointer。

## 为什么不是只用 SQLite 或只用文件

- SQLite 是热事实索引：适合当前状态、关联查询、幂等记录和小范围审计查询。
- 压缩分区 JSONL 是冷明细：适合大体积、低频读取、完整导出和对象存储生命周期策略。
- 两者的公开入口仍是 Craft API/MCP。客户端不依赖数据库路径或文件目录，服务器部署时才可以按权限读取本地盘或对象存储。

这避免了两种极端：把所有长期过程明细无限堆进单一 SQLite 文件，或让调用方绕过策略直接访问散落的日志文件。

## 格式与安全边界

每个 `.jsonl.gz` 段首行是 manifest，随后依次是唯一 Trace、零到多个 Event、零到多个 Feedback。manifest 与 Pointer 都携带 SHA-256 内容摘要；读取时必须同时验证格式、Locator、压缩数据、摘要和记录顺序。

本地适配器写入 `logs/trace-archive/YYYY/MM/DD/`，文件权限为 owner-only（Windows 由宿主 ACL 负责）。对象存储适配器不管理 endpoint、凭据或网络；这些由部署方以 `TraceObjectBackend` 注入。因此未配置受信任后端时，Craft 不会把 Trace 明细上传或退化为无保护的远程访问。

## 运维策略

1. 为 Trace 设置保留期，只归档终态 Trace。
2. 通过 Craft 读取 Archive Pointer，不把归档目录暴露给普通用户。
3. 需要服务端长期留存时，部署受信任对象存储 Backend，并在该 Backend 施加加密、保留期和身份授权。
4. 定期演练已归档 Trace 的读取与摘要校验；损坏归档必须报告错误，不能伪造为空结果。

该模块不承担用户原始业务数据的长期保存承诺。上游 Trace 仍应遵守既有脱敏与 Evidence 边界。
