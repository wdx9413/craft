# Craft Codebase：显式、只读的代码库结构分析

`craft-codebase` 是完整内部 Craft 的可选 Capability。它回答的是“在一个指定 Workspace
checkpoint 下，哪些文件、符号、导入和静态调用候选存在”；它不是 Knowledge、Memory、Experience
的第四个累积成员，也不会默认成为 Host 的上下文。

## 启用与查询

调用方必须先创建 Craft Workspace 与 checkpoint，再显式调用：

1. `craft_codebase_activate`：仅记录对该 Workspace 的只读分析授权，不扫描文件；
2. `craft_codebase_index_build`：仅从指定 checkpoint 的快照副本构建索引；
3. `craft_codebase_symbol_find`、`craft_codebase_callers_find`、`craft_codebase_impact_query` 或
   `craft_codebase_context_slice`：查询同一个 ready revision；
4. `craft_codebase_deactivate`：停止查询。已存在索引保留为本地记录，但不会再被使用。

`context_slice` 返回路径、source digest、source span 和 node id，**不返回源码正文**；Host 若要
读取正文，仍必须通过原有 Workspace/Policy 路径。在新的 checkpoint 成为 Workspace 的最新
checkpoint 后，旧 revision 一律是 `stale`，查询失败关闭，直到显式重新 build。

## 当前内置分析器边界

首期分析器是 `builtin-regex-static-v1`：它只处理 TS/JS 文件的基础声明、相对导入及调用候选。
导入边带 `provenance=extracted` / `confidence=high`；调用边带
`provenance=heuristic` / `confidence=partial`。未解析 import、歧义调用和不支持文件会出现在
diagnostics，不能被解释为“没有影响”。`impact` 始终是静态候选范围，绝不是运行时路径、发布安全
结论或安全审计。

每个 index 和 query receipt 都携带 `analysis`：解析器、`certainty=partial`、明确允许路径的
scope digest、支持/未支持文件数、语言集合和诊断数。`craft_codebase_status` 的 `readiness` 明确
区分 `disabled`、`index_required`、`ready` 与 `rebuild_required`；它是 codebase 的首跑诊断，
不能把“已安装”误说成“已完成语义分析”。

没有 Serena、GitNexus、网络、shell、watcher、Hook 安装、代码写入或外部 effect。外部分析器要以
显式 Capability Adapter 接入，并将其版本、健康状态、允许 root 与结果重新绑定到同一个 checkpoint
revision；在那之前，`craft-codebase` 不宣称使用了已安装的 Serena。

## 发布边界

此 Capability 没有 `product` 投影，也不改变 `craft-knowledge`、`craft-memory`、
`craft-experience` 三个外发产品。它仅出现在完整 Craft 的 full MCP surface；组件 surface、
Marketplace 与 common-use 均不会自动得到 `craft_codebase_*` 工具。
