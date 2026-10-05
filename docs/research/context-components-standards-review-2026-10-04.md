# Context 与子能力 Standards 审查

基线：`9ada1c7a92dfc3847837b063081176696ca9f463` 至当前工作树（含未跟踪实现）；以下为修复前发现，2026-10-04。标准：`CONTEXT.md:67,155` 的来源、用途和受众约束，以及 `AGENTS.md` 的安全、兼容和证据要求。

## 硬违规

1. **P1：Source 当前权限未约束派生召回。** `capability/craft-knowledge/contribution.ts:68–74`、`core/context-resolution.ts:173–178` 只检查 Source 状态/trust。登记 private Source，再写入默认 Envelope 的 reviewed Claim/Memory，无 owner 仍返回两类正文；相同记录 `componentAssetInspect` 正确拒绝。最小修复：共享 `sourceAllows` 检查当前 Source audience/tenant，保留派生记录自己的 purpose；测试 Source 权限收窄及正确 owner。
2. **P1：精确/列表 Memory 读取绕过 Envelope。** `capability/craft-memory/memory-ledger.ts:129–151` 的 daily MCP get/list 返回 private、tenant-bound、restricted Memory；无 principal 也成功。旧缺陷被新聚合/独立产品继续暴露。最小修复：当前与历史版本双重授权，检查 Source 当前受众；列表过滤相同规则，精确 ID 兼容保留。
3. **P2：用途过滤在调用链丢失。** `core/context-resolution.ts:89–90,207–210` spread 的字段为 `purpose`，贡献者读取 `cognitive_purpose`。实际 preference 查询返回 fact Claim。最小修复：统一字段适配，分别覆盖聚合与 Knowledge 搜索。
4. **P2：维护任务省略 scope 时跳过 ACL。** `core/memory-maintenance.ts:54–60` 的 `scope === null || ...` 短路受众检查；semantic/legacy 集合也未检查。无 scope 的维护回执泄露私有记录 ID 并生成候选。最小修复：所有集合先统一 scope/Envelope/Source/sensitivity 过滤；受限 Ledger 为空时不能触发 legacy 回退。

## 判断项

可能的 **Duplicated Code**：resolver、asset inspect、ledger 和 maintenance 各自拼接读取规则，已经产生上述差异；建议仅抽取共享 Source 受众谓词，不做大规模重构。未确认 asset restore 正文丢失：Store 会 hydrate `content_ref`，真实 canonical Memory 恢复已验证成功。

修复回归保存在 `tests/context-source-access.test.ts`。已运行该文件与 Knowledge contribution、component procedure graph、observability memory、industry gaps、asset revisions 共 50 项测试，全部通过。本次负责的四个模块增量覆盖为 39/39 语句、37/37 分支（相对审查前快照）；数据见 [覆盖证据](evidence/context-source-access-coverage-2026-10-04.json)。本报告不把单元测试视为真实宿主或线上验收。
