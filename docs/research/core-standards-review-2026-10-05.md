# 核心与子能力 Standards 审查

审查日期：2026-10-05。范围为当前核心、公共包、四子能力及其 MCP/远程 Adapter；排除 Workbench/Desktop UI。差异基点为 `9ada1c7a92dfc3847837b063081176696ca9f463`，包含未提交及未跟踪源码。本报告只评价 Standards，不与 Spec 轴混排。

## Findings

计数：3 项明确问题，1 项性能改进候选；本轴最严重为 **S1 / High**。未修改实现。

1. **S1 / High：Knowledge 旧读取入口绕过已有私有受众规则。** `core/application/craft-service.ts:2815–2816` 直接读取 Claim；`core/mcp/tool-catalog.ts:363–364` 不接受访问身份，故 `deploy/components/server.ts:28–32` 也无法注入身份。同 Store 的私有 Claim，经绑定为另一 principal 的真实 MCP 仍被 get/list 返回，asset_inspect 则拒绝。违反 `AGENTS.md:10` 的安全要求及 `common/craft-common-base/src/scope-policy.ts:93–103` 的统一可见性规则。属于当前全貌的既有缺陷。修复应让所有公开读入口复用同一授权查询，并补当前/历史版本、Source 撤销、tenant/principal 矩阵。
2. **S2 / Medium：配置事务回滚留下不可重试的文件版本。** `capability/craft-experience/procedure-configuration.ts:27–38` 在 SQLite 提交前写入不可变 JSON；`procedure-definition.ts:76–85` 的文件不参与回滚。故障注入后数据库为空但 v1 文件留下；同 id/title 修改内容重试报 `Procedure definition digest drifted`。违反 `AGENTS.md:10` 的异常、数据一致性及恢复要求；这是新增实现问题。需要可恢复的文件发布协议，覆盖写文件后、写记录前、提交失败和进程中止。
3. **S3 / Medium：Codebase 的 owns 宣称超出本包实现。** `capability/craft-codebase/ownership.ts:7–10` 声明 asset_inspect/asset_restore；实际位于 `core/application/coordinators/component-assets.ts:37–138`，由 `craft-service.ts:277–280` 装配；本包只注册 Index Kernel（`capability.ts:20–21`）。违反 ADR-0016 的“归属必须真实，投影可更宽”。属于本轮差异。保留产品投影，收窄 owns；若未来确需包内版本 Interface，再把真实实现交给所属 Module。
4. **S4 / Worth exploring：有界输出没有带来有界读取成本。** `common/craft-common-store-local/src/store.ts:197–205,310–315` 在 predicate 前装载全集合及正文；limit=1、201 条记录的探针发生 201 次正文读取。与 `capability/craft-knowledge/contribution.ts:64–65` 的已知限制一致，属于当前性能债务，未测生产延迟，不能断言现有数据量已超时。优先增加按 kind/scope 的元数据分页查询，在授权、筛选后读正文；用扫描行数/正文读取数验证，暂不引入外部数据库。

## 验证证据与范围

摘要结果见 [standards-probes-2026-10-05.json](evidence/standards-probes-2026-10-05.json)。临时探针位于 `/private/tmp/craft-standards-probes-20261005.ts`、`/private/tmp/craft-remote-review-probe-20261005.ts`、`/private/tmp/craft-list-read-probe-20261005.ts`，使用 Node 原生 Type Stripping；每次创建并销毁隔离 Store。

S1 先通过 `knowledgeClaimSave` 创建 audience.private=[owner] 的 Claim，再分别调用真实 `McpServer` 与 `bindRemoteIdentity(mcp, other, tenant-a)`。两种路径的 get/list 都返回 fixture 正文；asset_inspect 返回拒绝。它证明同 tenant 多 principal 的读取策略旁路；单 owner 本地体现为不同公开入口策略不一致。部署按 tenant 分 Store 的隔离仍存在，**没有证据表明能跨 tenant 读取**；未启动 HTTPS、真实 IdP 或生产 Host。

S2 仅在 `experience_procedure` 的 Store.create 注入异常，保留真实 SQLite 回滚与真实文件写入。随后恢复原方法并修改 instruction 重试。尚未模拟断电、真实磁盘满、多进程文件竞争，因此这些是待补故障场景。

S4 用读取计数探针测量 Store 的调用次序，未测磁盘吞吐和实际延迟。此次没有运行全量测试，也没有把先前的覆盖率结果作为本次安全与故障恢复结论。

## 保留的设计与审查原则

已有 Graph transition 在 `core/application/procedure-invocation.ts:233–239` 复用 Store 事务、当前状态检查和 CAS；不建议再建立 Graph 专属执行器。已有 `ComponentAssets` 当前与历史双重授权、Memory scoped list、经过摘要校验的版本引用值得沿用。薄兼容再导出与刻意保留的不同 digest 语义不构成问题；依据 ADR-0018，不因名称相似批量合并。

未把纯行数、格式或工具已经强制的 lint 当作 Findings。完整类型化、减少重复登记及提升 Module 的 Depth/Locality 可纳入总架构路线，但本报告只保留能明确说明触发条件、证据和影响的 Standards 项。
