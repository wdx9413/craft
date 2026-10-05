# Craft Codebase：自动准备、只读的代码库结构分析

Codebase 提供独立 Skill/MCP 产品，也包含在默认 Craft Context 聚合产品中。它查询固定 Workspace checkpoint 的结构事实，代码引用与 Knowledge、Memory、Experience 一起按预算提供；代码正文不会自动转成累积知识或记忆。

## 使用合同

普通仓库任务调用 `craft_codebase_repository_ensure`，或聚合入口 `craft_context_open`：自动识别 Git 根目录、建立或复用基础索引，不需要用户逐仓库激活。忽略规则、退出配置、缓存与预算见 [Craft Context](craft-context.md)。

高级范围控制保留 `craft_codebase_workspace_open` 指定 root 和 include_paths，`craft_codebase_activate` 启用；`craft_codebase_refresh` 创建当前 checkpoint 并构建索引。已有 checkpoint 可直接 `craft_codebase_index_build`。symbol_find、callers_find、impact_query、context_slice 必须引用同一 ready index。新 checkpoint 使旧索引 stale；deactivate 停止查询，自动入口不会擅自重新启用。

查询返回路径、UTF-16 span、digest、node 和 receipt，不返回正文。工作树漂移不能用当前文件冒充历史快照。影响查询是有界静态候选集，不能作为运行时路径或发布安全证明。

## 分析器

自动入口默认基础分析，按文件持久缓存文件及常见声明，不推断调用关系。按需使用 `index_depth: "semantic"` 或高级 `craft_codebase_index_build` 时，TS/JS 使用 TypeScript checker，在仅含 checkpoint 文件的内存 CompilerHost 中解析别名、导入、函数和方法调用。不会读取仓库外文件或执行项目代码。支持进程内文件解析缓存，最多 2,000 文件、2,000 万字符、10,000 节点和 20,000 边。缺少外部依赖、动态调用等保留 unresolved；`analyzer: "heuristic"` 是显式旧分析器降级。

Python 适配器见 [脚本](../../../scripts/codebase/analyze-python.py)，固定 Jedi 0.19.2，输入显式 checkpoint documents，输出 `craft-static-analysis-v1`。LSP adapter 接收 DocumentSymbol 和显式关系：calls/imports/references/implements/type_definition。只提供符号时不会猜调用关系。其他语言可通过同一 analysis_import 合同接成熟分析器。

导入校验文件归属、source_digest、UTF-16 span、节点引用和大小预算；analyzer/version 随索引固定。外部事实标为 adapter_reported/partial，不能证明分析器真实运行或完整覆盖动态行为。

## 限制

当前图仍按有界 index record 保存，尚无大仓持久分片索引；超限需缩小 include_paths。TS 缓存只复用解析树，checkpoint 变化仍重新绑定与建图。Python、TS 的合成项目验证不等于所有真实项目 precision/recall 达标。Hook 不参与分析必要链路；安装状态不等于当前 Host 会话已完成真实调用。
