# Craft Codebase：自动准备、只读的代码库结构分析

Codebase 提供独立 Skill/MCP 产品，也包含在默认 Craft Context 聚合产品中。它查询固定 Workspace checkpoint 的结构事实，代码引用与 Knowledge、Memory、Experience 一起按预算提供；代码正文不会自动转成累积知识或记忆。

## 使用合同

普通仓库任务调用 `craft_codebase_repository_ensure`，或聚合入口 `craft_context_open`：自动识别 Git 根目录、建立或复用基础索引，不需要用户逐仓库激活。忽略规则、退出配置、缓存与预算见 [Craft Context](craft-context.md)。

高级范围控制保留 `craft_codebase_workspace_open` 指定 root 和 include_paths，`craft_codebase_activate` 启用；`craft_codebase_refresh` 创建当前 checkpoint 并构建索引。已有 checkpoint 可直接 `craft_codebase_index_build`。`craft_codebase_symbols_overview` 按 checkpoint 相对路径返回文件内有界符号大纲；面向 Agent 的 `craft_codebase_symbol_explore` 将符号候选与所选静态关系合并到一次只读调用，保留歧义与截断信息；消歧后可用 `craft_codebase_symbol_read` 按 node id 读取同一不可变 checkpoint 中有界、摘要校验的源码窗口；`symbol_find`、`callers_find`、`relations_find`、`impact_query`、`context_slice` 必须引用同一 ready index。`relations_find` 可按 incoming/outgoing 查询 calls/imports/references/definitions/implements/extends/type_definition；它只返回静态边及其来源和置信度，adapter 提供的边继续标为 partial。新 checkpoint 使旧索引 stale；deactivate 停止查询，自动入口不会擅自重新启用。

`craft_codebase_impact_query` 最多扩展 5 层，默认 2 层、40 条边；`direction: "incoming"` 沿指向当前节点的边查调用者和依赖者，`"outgoing"` 沿当前节点发出的边查被调用项和依赖项，`"both"` 保持双向遍历的兼容默认值。可选 `relation_kind` 只遍历一种关系（如 `calls` 或 `imports`），省略时保留所有关系的旧行为；回执与缓存均绑定该过滤条件。结果是带回执的静态候选 blast radius，不含运行时行为、动态调用或覆盖证明，不能据此宣称发布安全。

用户管理的 `<CRAFT_DATA_DIR>/config/codebase-lsp.json` 可为每个受信任语言服务器设置 `request_timeout_ms`（默认 10000，最高 120000）；超时只延长协议请求等待，不扩大快照、文档、响应或图预算。服务端提前退出会记录最后等待的 LSP 方法、退出码和 signal，便于区分慢启动与进程崩溃。

默认结构查询返回路径、UTF-16 span、digest、node 和 receipt；显式调用 `symbol_read` 时，TS/JS、Python 与提供完整范围的 LSP 会返回解析器验证的声明源码，其他符号返回受字节数和行数双重限制的源码窗口。回执说明读取模式、范围和截断情况；截断时可把 continuation 传回同一工具续读，令牌绑定索引、符号和源码摘要。TS/JS 调用边归属到包围调用表达式的最近可识别函数/方法；函数体中的局部变量初始化不会把调用方降成该变量，具名箭头/函数表达式归属到其声明符号。影响查询会在结果正文和回执中都返回 `max_depth` 与 `truncated`，便于 Agent 明确判断查询范围；它仍是有界静态候选集，不能作为运行时路径或发布安全证明。工作树漂移不能用当前文件冒充历史快照。

符号检索以快照绑定 BM25 倒排索引排序，并缓存最多两个已校验索引。分析器提供的 `declaration_kind`（如 function、class、method）在图导入时保留并参与检索排序；格式错误的类别会拒绝导入。每次复用前对最新分片 payload 计算内容指纹；变化时丢弃缓存并重新验证分片 digest。长名称片段通过 trigram 缩小候选，短查询检查全量符号名。该缓存只加速同一进程内的重复查询，不代替 checkpoint 或图完整性校验。

同一索引、seed、深度和预算的影响查询可复用最多八条有界结果。缓存记录实际读取的 edge-route 与 graph-shard ID，并在命中前重新指纹这些原始 Store payload；任何依赖记录变化都会重新执行路由和 shard digest 验证。当前索引使用 `sharded-v4`：每个内容寻址分片仍以顺序 JSON SHA-256 验证，节点/边/整图清单提交有序分片摘要，避免重复序列化完整节点和边集合。`sharded-v1` 仍按规范化摘要读取，`sharded-v2`/`v3` 保留原有全量聚合摘要验证，旧版内嵌图不启用此缓存。

## 分析器

自动入口默认基础分析，按文件持久缓存文件及常见声明，不推断调用关系。仓库选择器识别 30 多个语言族的常用源码与配置扩展名；这表示文件可纳入有界快照，不表示该语言已有内置语义分析器。文件在 1200 文件、12 MiB 总量和 512 KiB 单文件限制内按语言族确定性轮转选择，避免路径靠后的语言被单一大语言族挤出；安全读取失败及文件、字节预算省略数按语言族随索引回执和 Context pack 返回，选择策略变更会触发重建。按需使用 `index_depth: "semantic"` 时，TS/JS 使用 TypeScript checker，并为符号记录函数、方法、属性、类、接口、类型、枚举、变量或参数类别；Python AST/Jedi 记录函数、方法、类及可判断的变量/参数类别；Java 使用 JDK Compiler Tree API 解析已选快照，禁用注解处理器且不解析外部依赖，只记录已解析的符号、调用、导入和继承关系；外部 LSP 的 numeric `SymbolKind` 统一归一为可检索的声明类别。图字段变化会更新 analyzer schema version 并触发旧 file-unit 缓存回建。Python 未安装 Jedi 时自动退到标准库 AST 分析。内建分析仅基于本次 checkpoint 文件解析本地导入、调用/引用、继承及可解析类型注解，不读取仓库外文件或执行项目代码。TS/JS 对文件集合和模块边界稳定的修改按反向导入闭包重算，有限复用最多两个 compiler program，并跳过未变 AST 的声明重建；新增/删除文件、ambient/global 声明及不完整缓存仍全量回退。Python AST 现在按反向导入闭包只重解析受影响文件，未变模块复用有摘要校验的符号和类方法索引；文件集合变化、动态/歧义模块、分析器版本变化、损坏缓存或预算限制回退全量。Jedi 暂不提供文件单元时仍走全量分析。`scripts/smoke/codebase-python-incremental-self-index.ts` 用当前仓库 Python 文件验证解析数量及增量图与全量图一致；这不减少仓库发现、源文件读取和输入传输成本。TS/Python 的持久 file-unit 缓存按 `unit_digest` 跳过未变记录；分析导入按每文件预计算行起点并二分转换 UTF-16 offset，避免逐边重复扫描源码前缀。隔离 485 个普通 TS/JS 模块的单文件更新约 7.6 秒，全图重建约 13.1 秒，图摘要一致；单文件 analyzer 约 12 ms，索引导入约 5.9 秒。这是单次本机测量，仍不是 IDE 级低延迟或竞品对照。动态分派、作用域歧义、复杂相对导入等保留 unresolved。多语言合并图最多 60,000 节点、300,000 边和 64 MB 序列化预算；超限返回 partial 并报告省略项与各语言诊断。语义导入最多 64 MiB，持久图最多 128 MiB，每个图分片最多约 1 MB。

Java 也缓存不含源码的 digest-pinned 文件图单元。修改已有文件时，按调用、导入、继承的反向依赖闭包和同包文件重算，其余单元复用；新增/删除文件、编译器未解析绑定、编译错误、缓存摘要损坏或 analyzer 版本变化都会全量回退。Javac 仍会解析并绑定有界快照中的所有文件以确定符号，所以 `parsed_file_count`/`reused_file_count` 只度量图单元提取与复用，不代表省去了编译器的全量解析。所有单元仅由 Craft checkpoint 产生，缓存写入发生在快照验证之后。

受信任 stdio LSP 会先向服务器发送本次有界快照的全部 `didOpen`，然后以最多 8 路并发请求 `textDocument/documentSymbol`，按输入文档顺序组装结果；JSON-RPC 响应可乱序返回。这样缩短多文件串行等待，同时保持全快照关系映射。它仍会传输并打开全部选中文档，且关系查询仍需按符号执行；这不是跨进程的 LSP 增量缓存，也不表示完整增量解析。

Python 适配器见 [脚本](../../../scripts/codebase/analyze-python.py)，固定 Jedi 0.19.2 为增强项，输入显式 checkpoint documents，输出 `craft-static-analysis-v1`；自动索引不安装依赖，在没有 Jedi 时使用 AST 降级。任意受支持的语言，包括 TS/JS 和 Python，都可以在用户管理的 `<CRAFT_DATA_DIR>/config/codebase-lsp.json` 登记绝对可执行路径；显式登记后，该索引对相应语言使用外部 LSP 替代内建 analyzer，semantic repository onboarding 会用注册的语言服务器分析本次选出的快照文档；默认不开启任何外部服务器，仓库内 `.craft-codebase.json` 无权注册程序。程序及参数不经 shell，文档先镜像到有界临时目录，分析后清理；外部服务器仍以当前操作系统用户运行，Craft 不提供进程沙箱。每种语言最多配置一个服务器，每个服务器最多分析 500 个文档，默认 100；配置摘要进入仓库索引状态，配置变化会触发重建。未登记或登记无效时保留基础索引并记录语言级 unavailable/partial。用户也可显式调用通用 stdio LSP 客户端：将语言服务器命令、参数、checkpoint 根目录和带 SHA-256 的文档列表写入请求 JSON，再运行 `node --experimental-strip-types scripts/codebase/analyze-lsp.ts request.json`。客户端通过标准 JSON-RPC 请求 DocumentSymbol；`relations` 可选择 `references`、`definitions`、`calls`、`implementations`、`type_definitions`、`type_hierarchy`。definitions 只有在 server 同时声明 references 和 definition provider 时才启用：先从符号位置枚举引用，再对每符号最多 20 个、全请求最多 500 个快照内引用位置逐一请求 definition；成功映射的边保留引用 token 的 UTF-16 源范围，重复位置全局去重。其他请求仅在服务器声明对应 provider 后发送 references、incoming call hierarchy、implementation、typeDefinition，以及 prepareTypeHierarchy/supertypes/subtypes。位置和层级项均须映射到所选 checkpoint 中已有的符号，形成 references/definitions/calls/implements/type_definition/extends 边；Type Hierarchy 的 `extends` 是协议提供的静态类型关系，外部 adapter 边保留 partial 置信度。导入索引后，`craft_codebase_definition_find` 可用文件相对路径和零起始 UTF-16 offset 查询该位置已有的 definitions/references/calls/imports/type_definition 边目标；它是快照图上的有界候选查询，不会启动语言服务器，也不会因空结果证明不存在定义。超出 `relation_symbol_limit` 的符号、每符号 20 个或全局 500 个引用上限、层级项超预算、服务器不支持、请求失败或位置无法映射均记录到 diagnostics，结果可直接传给 `craft_codebase_analysis_import`。stdio LSP diagnostics 区分关系候选符号总数、查询预算省略数、响应/结果预算省略数和关系映射省略数；这些类别之和等于 `relation_omitted_count`，便于 Agent 判断 partial 的具体来源。无配置时不运行外部服务器；未请求的关系标记 `not_requested`，能力缺失或发生省略时标记 `partial`。没有捆绑或自动安装语言服务器。

请求最小结构如下；`source_digest` 是 `content` UTF-8 字节的 SHA-256，路径相对 `cwd` 且必须属于所选 checkpoint：

```json
{
  "command": "clangd",
  "args": ["--background-index=0"],
  "cwd": "/absolute/path/to/checkpoint",
  "analyzer": "clangd",
  "analyzer_version": "installed-version",
  "relations": ["references", "definitions", "calls", "implementations", "type_definitions", "type_hierarchy"],
  "relation_symbol_limit": 100,
  "documents": [{
    "path": "src/example.cpp",
    "language": "cpp",
    "content": "class Example {};\n",
    "source_digest": "sha256-of-content"
  }]
}
```

脚本在 stdout 输出可导入分析 JSON；输入体、单文档、文档总量和响应均有大小上限，单个 LSP 请求默认超时 10 秒。客户端先解析 checkpoint 根路径，避免 macOS `/tmp` 等符号链接路径与语言服务器返回 URI 不一致而误丢关系；无法映射到快照符号的位置会按阶段计入 `relation_omitted_stages`。外部语言服务器的真实语言覆盖、编译配置和语义精度由具体 server 决定；本机 clangd C++ 小样例已分别验证 references/calls、Base→Concrete 的 `implements`、变量→Model 的 `type_definition`，以及 Type Hierarchy `Child extends Base`，并把关系导入 Codebase 后按 `extends` 查询到 Base。该证据仅覆盖一个小型 C++ 快照，不代表其他语言或真实大仓精度。LSP 请求遵循 [3.18 implementation](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.18/language/implementation.md)、[3.18 typeDefinition](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.18/language/typeDefinition.md) 与 [3.18 typeHierarchy](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.18/language/typeHierarchy.md) 的 provider capability 和层级项协议约定。外部进程可能按自身配置读取、写入 checkpoint 目录或运行其他逻辑；使用者应只对可信执行文件运行，并给它只读快照及合适的操作系统隔离，Craft 本身不提供进程沙箱。

导入校验文件归属、source_digest、UTF-16 span、节点引用和大小预算；analyzer/version 随索引固定。外部事实标为 adapter_reported/partial，不能证明分析器真实运行或完整覆盖动态行为。

## 限制

图以索引清单、节点/边分片和按节点哈希路由的节点目录与邻接表写入本地 Store；清单、路由和每个图分片均做摘要校验，发布在同一事务中，读取时校验后才返回。符号搜索扫描节点分片；已知路径的文件大纲按路径路由读取对应节点分片，已知节点的关系、Context slice 和影响查询按目标节点读取对应节点/边分片，不再为这些查询装载整份节点图。位置路由版本 2 同时登记符号节点所在分片；旧版分片索引通过校验后回退到全节点扫描，旧版内嵌图继续直接读取。路由数据单条最多 4 MiB、总计最多 64 MiB。旧版内嵌 `nodes`/`edges` 图仍可读取。当前仍有硬上限：超过 60,000 节点、300,000 边或 128 MiB 会拒绝或明确 partial，不应将截断图当作完整图。

`craft_codebase_control_flow_query` 按节点 ID 定位 TypeScript/JavaScript/Python/Java 符号，再从 checkpoint 读取并重新校验该文件摘要，构建有界、语句级、source-free CFG。输出包含 entry/exit、条件分支、循环回边、return 与异常出口；Java try/switch/synchronized、Python try/with/match/break/continue、短路表达式和解析错误会标为 partial。它不持久化块或边，也不提供路径可行性或运行时证明。`craft_codebase_data_flow_query` 支持 TS/JS/Python，以函数节点和变量名为入口；TypeScript 使用 compiler symbol 区分局部绑定，Python 使用 AST 并对嵌套作用域、解包/字段写入和 loop-target 近似保留 partial 原因，在相应 CFG 上计算函数内 may-reaching definitions。结果只包含定义/使用范围和数据依赖边，不含源码正文；不可达语句不产生 flow。两者都不宣称跨过程 PDG、字段/别名分析、taint、路径可行性或运行时证明；Java/Go 数据流仍未实现，Python/Java/Go 的数据流准确率仍需真实仓库 mutation oracle 验证。

`craft_codebase_diagnostics_find` 只对当前 ready index 的 checkpoint 文件运行，要求用户配置 `codebase-lsp.json` 中显式信任的 LSP adapter。它将同语言、受文档数与字节预算限制的 checkpoint 快照镜像到临时目录，支持 push `publishDiagnostics` 和 LSP pull diagnostic provider；只返回请求文件的诊断。收到空列表表示本次确实无诊断；未发布、pull 请求失败、位置无效或文档截断返回 `partial`，不能解释为文件无问题。诊断消息只在调用响应中出现，receipt 只保存查询摘要和结果摘要。查询结束会复核工作区索引/激活状态及 LSP 配置摘要，配置或快照变化时失败关闭。

TS/JS 语义事实和 Python AST 图单元均按文件缓存，不含源码。相同 checkpoint 与策略版本会在进入分析器前直接复用已发布索引；修改现有模块时，按本地 import 边重算变更文件及传递反向依赖者，未受影响文件复用旧事实。TS 的新增/删除文件、无模块边界、`.d.ts`、不兼容或损坏缓存会全量重建。Python AST 对稳定文件集按反向依赖闭包只解析受影响文件，并从未变单元恢复符号和类方法元数据；文件集合变化、动态/通配符导入、混合分析器版本、损坏缓存或预算截断会全量重建。Jedi 没有提供文件单元时也安全退回全量路径。增量仍会重新发现、读取和传输整个 checkpoint，减少的是 Python AST 解析与关系提取，不是文件扫描。新文件单元和索引只在快照校验通过后同事务发布。当前验证覆盖 Craft 自身仓库及受控变更夹具，不代表其他项目的 precision/recall；动态调用解析和语言覆盖仍未达到竞品能力。Hook 不参与分析必要链路；安装状态不等于当前 Host 会话已完成真实调用。

TS/JS 的已存 file-unit 集合绑定精确路径集合摘要；路径集合变化仍保守全量重建。路径集合不变但少量单元缺失时，只分析缺失单元并合并反向导入闭包；只有补齐结果仍不完整才全量重试。全局图的节点/边预算与每文件缓存预算分离：全局图可为 `partial`，但这本身不使所有完整 file unit 失效；超出单文件或聚合缓存上限的 unit 会标记不完整并触发安全回退。2026-10-14 在本机 472 个 TS/JS 模块上的两轮真实单文件更新均与干净全量重建得到相同 graph digest；两轮分别复用 471/467 个单元，增量中位 11.57 秒、全量重建中位 23.18 秒。该次运行的冷建索引为 14.17 秒，测量受机器缓存及并发负载影响，仅作为单机小样本基准，不代表稳定 SLA 或竞品性能结论。
