# Hub Sync：大规模能力目录的可信增量同步

## 为什么不是扫描整个 Hub

Craft 不把远程 Hub 的全部 Skill 内容放进模型上下文，也不在每次查询时遍历远程目录。Hub Adapter 分页取得签名目录后，内核将最多 1000 条一页的元数据原子写入本地索引；检索只查询本地候选，真正需要时再由后续 Materialization Adapter 拉取内容。

## 信任和一致性

- Source 固定 HTTPS Endpoint、Publisher 和 Ed25519 公钥。
- 每页包含 Source、单调 Revision、前页摘要、签发时间与元数据 Entries，并验证整体签名。
- Revision 必须逐次增加，`previous_digest` 必须匹配可信游标，拒绝丢页、乱序和目录分叉。
- 同一 Receipt 可幂等重放，但不同内容复用 Receipt 会失败。
- 一页的 Entry 更新、Source 游标和 Receipt 在同一数据库事务提交，避免半页状态。
- `withdrawn` 是版本化撤销标记；搜索只返回 active 元数据。

## 边界

当前实现的是 transport-neutral 同步内核与 MCP，不主动联网。选中候选后可进入独立的 Capability Materialization 隔离缓存、确定性扫描和人工审查流程，但 HTTP 拉取、分页重试、归档解析、恶意代码分析、组织身份和透明日志仍属于后续 Adapter。目录签名证明来源与完整性，不等于内容安全或执行授权。
