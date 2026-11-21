# 子能力独立存储

本文说明 Runtime 的所有者装配、Common 文件存储协议及各 Capability 的持久化边界。代码入口为 `core/interfaces/mcp/runtime.ts`，迁移入口为 `scripts/owner-history-import.ts`。本轮验收记录与实际发布状态分开保存，源码测试通过不代表已切换用户安装。

## 数据归属与入口

同一数据空间中，Knowledge、Memory、Experience、Codebase、Notes、Eval、Context、Runtime 各自只有一个发布库：`<data>/<owner>/publication.db`。独立 MCP、聚合 MCP、SDK、Hook、Workbench 和 Worker 委派到同一所有者。可选成员缺失时返回不可用，不在调用方的库中补建另一份资产。

| 所有者 | 权威内容 | 生命周期 |
| --- | --- | --- |
| Knowledge | 来源、文档正文、知识候选与证据 | 草稿、来源验证、评审、撤销与过期 |
| Memory | 陈述、观察、候选、正式记忆与支持证据 | 同意、冲突处理、独立支持、晋升与撤销 |
| Experience | 观察、场景、规程定义、评测派发与发布指针 | 分类、Shadow、Held-out、Signoff、Canary 与撤销 |
| Codebase | 固定快照、结构图和分析结果 | 激活、刷新、精确版本查询 |
| Notes | 设备、目录和文件笔记 | 观察、确认、更新与撤销 |
| Eval | 冻结合同、签名报告和任务效果记录 | 冻结、验证、精确版本绑定 |
| Context | 组合回执、工作集、候选投影与跨域提交账本 | 授权、选择、重验、提交与对账 |
| Runtime | 任务、执行、Trace、Hook 日志和运行配置 | 执行终态、恢复与维护 |

Context 插件默认装配上述成员。SDK 可只打开一个所有者；`CRAFT_CONTEXT_MEMBERS` 显式限定装配成员。各域的提交事务保持独立，跨域提交先保存操作意图，再接收目标回执。响应丢失时用同一操作 ID 重试，目标不重复创建候选。

## 文件和数据库

人读正文存 Markdown；结构化定义、合同、结果及完整记录存版本化 JSON；追加事件和冷历史存有界 JSONL。SQLite 保存提交可见性、版本、必要筛选字段和文件引用。完整正文、步骤和报告不作为通用数据库载荷重复保存。

不可变文件先写入并核对摘要，SQLite 提交后才可见。未提交文件不会成为正式资产。记录文件引用包含相对位置、摘要和字节数；冷分片还包含精确字节范围。冷分片每批最多 1000 条，普通批次最多 8 MiB，单条超限记录单独保留。读取范围时仍校验记录身份和摘要。

文件协议通过库内版本标记握手。带 Markdown 引用的记录使用 v2；旧读取器不能把它当完整正文。所有者模式另有独立标记，不能静默降级为旧分区写法。新数据目录设置共享库路径栅栏，旧二进制无法重新创建共享 `craft.db`。

稳定引用携带 `owner / kind / id / version / digest / scope`，不携带机器绝对路径。读取先验证作用域和受众，再读取正文；使用前重验当前状态。不存在、权限不符、版本不符、摘要漂移、撤销、过期与存储不可用分别处理。引用不能授权执行。

人工修改 Knowledge／Memory 时，先复制正文为草稿，通过资产工具的 `register_edit` 登记新候选。原版本及旧证据保持可核验；新正文不会继承原先的评审资格。若原权威正文已损坏，应先从备份恢复，不能用新草稿冒充原历史。

## 历史迁移与恢复

迁移从一致的主库快照及其已发布版本出发，保留原始行、外部正文、定义、域库和项目身份。未发布暂存记录单列。项目根或归属无法确定时保留待解析身份；不会自动归入全局，也不会重新授予晋升资格。

归档、导入、切换是三个阶段。副本导入可标明源库在快照后继续写入；正式切换必须重新核对源库、域库和权威文件，拒绝任何未对账增量。切换要求所有写入者停止，并保留完整旧目录。回退保留切换后的新目录，不能把两份可写权威合并。

每个所有者可单独备份。备份包含自己的发布清单、权威文件及必要分片；大清单分成最多 1000 条、1 MiB 的校验页，旧 v1 清单仍可读。兼容视图只缓存当前页，但路径库存和去重集合仍随文件数量增长。外部稳定引用保留引用关系。恢复到其他根目录时只重定位机器路径，不改签名合同和历史正文。

容量报告区分 JSON 载荷字节、记录范围、Markdown、SQLite 文件、WAL／SHM、冷归档和其他结构文件。SQLite 页统计区分表和 B-tree 索引；FTS 影子表仍计入表页，不能把该统计冒充全部搜索索引体积。备份和归档应各自盘点，硬链接分配字节去重与逻辑字节分开。

## 学习链路与证据

Hook 只记录宿主原生终态。无状态、运行中、取消、错绑或矛盾结果不记通过。异步任务需关联原始调用、命令、会话及轮次；最后一次编辑之前的验证不能支持本轮观察。验证缺失不撤销已保存的 Knowledge 或 Memory。

场景归并使用已冻结的目标、条件、输入输出和验收语义。两份不同会话的独立支持可以形成受治理候选；相同命令不能单独证明做法相同。Worker 根据显式授权或有效 Hook 登记处理候选，持续学习关闭时停止后台推进。

Held-out 适配器读取独立执行器输出的签名报告，复用 Eval 的验证器。缺适配器、坏签名、错误版本、合同不符或效果不达标均不能晋升。合成合同测试验证门禁可执行；真实宿主调用验证集成；真实任务的正收益仍需独立配对效果证据，三者不能互相替代。

## 独立构建

Runtime、Context、Datasec 和各独立插件分别记录自身版本。打包可限定单个产品；Marketplace 单组件同步检查实际构建输入与产物摘要，内容改变必须提高该组件版本，其他组件不被重写。

构建时对实际交给 esbuild 的输入缓冲区计算摘要，打包时沿用该快照，避免源文件随后变化导致清单失真。清单包含包版本、相对文件摘要、编译器、锁文件及可执行文件摘要，并单独记录外置 TypeScript 编译器产物。已加载制品可报告自身版本和字节校验结果。清单是可复核的构建记录，不是外部可信签名证明。

## 维护入口

CLI 包同时包含历史归档、压缩、导入、切换和容量脚本；脚本已编译进 Craft 包，使用 Node 23 以上运行。路径参数必须显式指定。`--allow-source-drift` 只允许生成带快照截点的副本，不允许绕过正式切换的最终增量校验。

```sh
node node_modules/craft/dist/scripts/owner-history-archive.js --data-root=<source> --destination=<archive>
node node_modules/craft/dist/scripts/owner-history-compress.js --archive=<archive> --manifest=<archive>/manifest-<digest>.json
node node_modules/craft/dist/scripts/owner-history-import.js --archive=<archive> --manifest=manifest-<digest>.json --destination=<staging>
node node_modules/craft/dist/scripts/storage-capacity.js --root=<active|archive|backup>
node node_modules/craft/dist/scripts/owner-storage-cutover.js --active=<active> --staged=<staging> --previous=<old-directory> --archive=<archive> --manifest=<archive>/manifest-<digest>.json --apply
```

切换前应完成归档摘要、导入结果、正常入口读回及写入者盘点。操作要求保留独立旧目录及新目录，不能在运行着旧写入者时直接覆盖数据空间。进程中断后使用切换脚本的 `--recover --apply` 恢复；普通入口看到维护锁会拒绝启动。
