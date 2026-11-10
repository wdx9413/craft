# 项目身份与业务数据迁移

此流程只调整路径与项目身份的登记，不重写 Memory、Knowledge、Experience、Codebase 的业务内容、证据或摘要。旧 scope 会作为明确排除项保留，后续业务数据导入须另行验证归属。

前半部分说明登记与只读清点。后半部分提供基础资产的显式复制迁移；它不覆盖所有历史类型，也不继承旧评审、任务效果或执行许可。

使用 `craft_scope_identity_resolve_project`：

1. `action: diagnose`、`project_root`：只读诊断；有多个旧 scope 或截断时拒绝应用。
2. `action: plan_registry_migration`：返回只读诊断和 `plan_digest`。
3. `action: apply_registry_migration`：提供相同 `project_root`、预检中的唯一 `legacy_scope_id` 和 `expected_digest: plan_digest`。应用前在写事务中重读并验证计划。登记快照、变更和迁移回执在同一事务提交。
4. 相同计划重复调用返回已有 applied 回执；登记发生漂移则拒绝重用。
5. `action: restore_registry`：提供迁移返回的 `migration.id`。仅当受影响登记版本未变、且规范身份尚未被业务记录引用时恢复；跨项目、漂移或已使用都会拒绝。恢复只处理本次创建/调整的登记。

旧 project_identity 的路径归档至 archived_local_path_alias，旧 path alias 变为 inactive；历史版本和迁移回执中的 before 快照保留。新规范身份可解析，旧业务 scope 不自动进入 Context。

登记快照保存在同一数据空间的 project_registry_migration 记录中，不能替代对整个数据目录、分库和文件的离线备份。完整灾备、全部历史类型及真实用户数据迁移仍属于整体交付验收的未完成部分。当前实现不会自动修改本机已安装插件的数据。

## 只读业务清点

登记应用后，仍使用 `craft_scope_identity_resolve_project`：

```json
{
  "project_root": "/absolute/project/root",
  "action": "inventory_project_data",
  "migration_id": "project_registry_migration_...",
  "limit": 50
}
```

`migration_id` 必须属于这个项目且状态为 applied。`limit` 默认 50，允许整数 1～100；后续页传入上一页的 `next_cursor`，直到 `has_more=false`。游标绑定登记迁移的版本与摘要，跨项目或登记变更后不能复用。

清点只读取主库最新版本的已发布记录与分库指针，按 kind/id 排序。明确声明的 scope 优先，缺失字段不能借用较宽松的 project_id 来拼出归属；其他项目、global、session 和已迁出的旧版本不进入结果。它不打开分库，不输出正文、内容文件路径或评审材料，也不初始化分库或获取写锁。

每项包含 kind、id、version、metadata_bytes、domain、pointer_digest、binding 和 disposition。pointer_digest 只绑定中央记录或中央指针，不证明分库正文完整。元数据超过 1 MiB 时不将完整 JSON 加载到 JavaScript，返回 `metadata_exceeds_inventory_budget`，摘要为 null。元数据逐条处理，避免一页在内存同时保留 100 份大正文。分页约束输出与 JavaScript 内存，不构成数据库扫描耗时上限。

| disposition | 后续要求 |
| --- | --- |
| requires_business_provenance_review | 核验分库正文、来源和类型化引用，按该能力的治理流程导入 |
| requires_typed_recipe | 未知类型或多个能力指针，先补充明确导入规则 |
| reindex_required | Codebase 应在新 scope 重建，不复用旧索引的有效资格 |
| metadata_exceeds_inventory_budget | 单独审核大记录，不能当作已绑定内容直接应用 |

返回明确标记 `coverage=published_central_records_only`、`snapshot_scope=page_only`、`partition_content_verified=false` 和 `automatic_apply_allowed=false`。每页在只读快照内一致，多页之间没有冻结整个数据集；新增或修改记录需要重新清点。未发布分库记录、历史版本和仅存在于分库中的孤立数据不在这份清单中。分页完成不代表业务迁移、信任资格或灾备验收完成。

## 基础资产复制迁移

登记处于 applied 状态后，从清点结果明确选择最新记录，以 `record_refs` 固定 kind、id、version。迁移递归核验下表列出的父引用，绑定实际分库记录、正文和内容清单摘要；原始正文不出现在预检或迁移回执里。多页清点结果不能直接当作这个预检摘要。

```json
{
  "project_root": "/absolute/project/root",
  "action": "plan_data_migration",
  "migration_id": "project_registry_migration_...",
  "record_refs": [{ "kind": "memory_ledger", "id": "old-memory", "version": 1 }]
}
```

预检返回 `plan_digest`、按依赖顺序排列的 source/target 映射、各记录和正文摘要、外部固定引用与预算。根记录最多 50 个，含依赖最多 100 个；单条记录和内容文件各最多 1 MiB，总输入计数最多 8 MiB。总量包含记录与单独正文读取，同一正文被不同记录引用时分别计数。这些是数据量限制，不承诺磁盘扫描耗时或进程内存的硬上限。

| 原记录 | 新记录与边界 |
| --- | --- |
| knowledge_source | 新项目内的描述符；改为只读。原本有效、可信且当前路径位于同一项目根内的来源最多保留 bounded；缺失、外部或原本不可信的来源为 untrusted，撤销/禁用状态继续保留。全局或用户来源只固定原引用和版本，不复制或改动。 |
| knowledge_source_revision、knowledge_document、knowledge_fragment | 新 ID 和重绑后的类型化引用；标记 revalidation_required，正文写入新的候选文件。旧来源修订的有效资格不继承。 |
| evidence | 新 ID，confidence 为 unverified；保留已发布的能力存储归属，不复制原 Host、评审或程序核验元数据。 |
| knowledge_claim | 新候选或保留原负向治理状态；清除旧 review、模型评审与发布许可，必须重新经过正式治理。 |
| memory_ledger、memory_candidate | 新 memory_candidate，不创建有效 Ledger。原撤销/拒绝变为 rejected，争议或未解决冲突变为 conflict_pending，过期、过时和被替代状态继续阻止普通准入。原冲突记录可经迁移来源查看，旧冲突与晋级引用不作为新 scope 的有效引用。 |
| experience_observation | 仅保留诊断材料，状态为 revalidation_required；不复制旧执行来源回执，不成为可编译或可路由的观察。 |

普通检索仍排除旧 scope。只有迁移专用的只读内容读取器，会在已核验的同一项目根内解析旧 Knowledge 内容；它不修改服务的普通目录解析器。其他项目或会话的依赖、混合能力指针、内容身份/来源不符、敏感级别未知、缺失正文和不支持的类型都会拒绝整批执行。敏感级别取记录与已核验文件中较严格者；文件已撤销或过期时不会恢复成普通候选。

引用字段有明确类型，例如本配方中的 source_id 指向 Knowledge Source。使用其他来源模型的 Evidence 需要额外配方，不能把同名字段猜成可重绑引用。只有白名单内字段会复制；任意业务扩展、旧缓存和历史评审签名不自动带入新记录。

应用时把 action 改为 `apply_data_migration`，保留相同 project_root、migration_id、record_refs，并传入 `expected_digest: plan_digest`。目标 ID 绑定原始快照及重绑后的依赖；父级变化不会误用旧暂存文件。内容文件在主库写事务前暂存，发布前在写事务中重做预检。所有中央指针与迁移回执原子发布，普通存储的“记录不能修改 scope”限制保持不变。完全相同的已发布请求可幂等核对；目标、登记或回执漂移会拒绝重用。

Codebase 应在新身份重新索引。可执行 Experience Procedure/Graph、发布记录、评审/任务效果、Context 会话、Evolution、原生会话和未列出的类型没有自动导入规则；须另行处理，不能用字符串替换或修改普通存储守卫绕过。这里的 `coverage=selected_roots_and_typed_dependencies` 不是整个旧项目或历史版本的迁移证明。

## 回滚与恢复限制

调用 `restore_data_migration`，提供相同 project_root、登记 migration_id 和已应用的 expected_digest。回滚只移除该批次创建的记录，旧记录及其所有历史不变。每个目标须仍是发布的版本，并符合冻结的内容/权限摘要；回执 after 摘要不能覆盖预检约束。目标被后续修改、重新创建、引用或内容文件漂移时拒绝自动处理。

当前回滚采取保守的发布水位检查：本批次之后，主库若仍有其他发布记录，先要求依赖审查。原因是部分跨记录引用位于分库正文，主库头部不能证明没有引用。即使后续记录与本项目无关，也可能触发这一限制；不会借此扫描全部分库或自动删除其他工作。普通读取和分库 Trace 写入不构成主库发布。

真实迁移应先制作离线备份，并安排没有后台业务写入的维护窗口。后台学习产生的新记录同样可能阻止自动回滚；隔离测试的回滚通过不代表持续运行中的真实数据空间已经具备相同条件。

新生成但不再发布的不可变内容文件保留供审计，迁移失败、崩溃与回滚不批量清理文件。相同预检的重试可核验并复用兼容暂存内容及未发布分片版本；原文件始终保留。因此迁移会暂时增加磁盘占用，不能替代容量治理或离线备份。

数据回滚成功后，再执行 `restore_registry`。该入口会验证已经 restored 的业务迁移回执及目标确实不存在，再允许忽略这些审计记录；仍有新身份业务记录、格式损坏的回执或被重建的目标时继续拒绝。恢复到原登记后，Context 再次报告旧身份待迁移是预期结果。
