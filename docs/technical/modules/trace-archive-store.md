# Trace Archive Store

`TraceArchiveStore` 是 Trace Kernel 的一个深模块：它只负责把一个已经终态的 Trace Bundle 写入或读取，并返回不暴露真实文件系统或对象存储地址的 Archive Pointer。`TraceArchiveStorageKernel` 在其上增加持久的存储插件选择：它把用户配置与部署 Runtime Backend 分开，不让配置本身变成可执行代码或密钥仓库。

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

## 用户配置存储插件

默认无需配置：`local` 由 Craft 内置，后台依据 `default` 保留策略（初始为 7 天）归档终态 Trace。管理员可以通过 Full MCP：

1. `craft_trace_archive_storage_register` 登记一个外部 `storage_id`，只提交 `backend_id`、`credential_ref` 和 `configuration_ref`；引用中禁止包含密钥正文。
2. 部署方在启动 Craft 时装载同名、受信任的 Archive Backend。Craft 不会按用户输入安装依赖、执行插件脚本或发起未授权网络请求。
3. `craft_trace_archive_storage_activate` 只在该 Backend 已可用时切换。归档 Pointer 会锁定本次使用的 `storage_id`，以后切换默认存储不会影响旧 Trace 的读取。
4. `craft_trace_retention_plan` 用 `replace: true` 更新 `default.max_days`；Maintenance 的下一次 Tick 自动采用新周期。单次 Sweep 传 `max_days` 只覆盖该次执行。

外部 Backend 写入失败时，Craft 不删除对应 SQLite 热记录；Maintenance 会留下失败回执并退避重试。外部归档能力因此是一个可替换的部署插件，而不是数据丢失的降级路径。

该模块不承担用户原始业务数据的长期保存承诺。上游 Trace 仍应遵守既有脱敏与 Evidence 边界。
