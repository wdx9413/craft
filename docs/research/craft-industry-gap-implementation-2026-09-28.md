# 四组件业界差距补齐：实现与验收

2026-09-28。承接 [业界差距报告](craft-industry-gap-analysis-2026-09-28.md)。交付范围为当前仓库的实现、Skill/MCP 契约、打包产物和隔离验收；远程提供可部署材料，不上线。保留工作区内其他任务的未提交改动。

## 本轮交付

| 能力 | 行为变化 | 验收证据 |
| --- | --- | --- |
| 统一 Context | 授权过滤后统一 BM25 / vector / hybrid 排序，再分配预算；required Memory 显式优先；中文分词与代码标识符进入默认检索 | 弱 Memory 不再挤掉更相关的 Knowledge；必选项超预算显式失败；中文、混合标识符与跨 scope 负例 |
| Knowledge | 文档稳定身份、内容摘要与状态；段落切片；分页 cursor 绑定完整来源 revision；单文档更新/删除仅使关联 Claim 失效 | 未改文档保留审核；删除、修改、stale cursor、旧版本迁移、document guard 与 bundle 往返 |
| Memory | current/history/as_of/known_at；当前权限继续约束旧版本；历史结果标记 execution_context=false | revoked/expired/superseded 历史可查询；获知时间和业务时间分离；权限收紧后旧版本不能绕过 |
| 检索执行与成本 | 有界批次、超时、进程缓存与 SQLite 缓存；缓存绑定 endpoint/model/revision/content digest；缺用量保留未知 | 独立新进程无网络调用命中缓存；磁盘故障事务回滚；维度/大小异常降级；未知用量不按零计费 |
| 检索评测 | dataset 实际执行后保存语料、查询摘要、逐条结果和指标；调用方报分不能单独启用 vector/hybrid | 错 scope 标注被拒绝；真实执行指标决定 eligible；适配器并发变更使评测失败；明确成本门槛时未知成本不通过 |
| 记忆维护 | scoped 维护产生带版本的过期/重复候选动作；与回执绑定的 helpful Evidence 进入相关性同分排序 | 跨 scope 条目不进入维护；缺 scope 的独立组件返回 skipped；反馈不改变审核和撤销状态 |
| Experience | 保留 passed/failed/blocked/inconclusive/cancelled；按失败策略及当前状态证据恢复；每项最多三次重试，仍受总预算限制 | 重启、补证、漂移、过期、版本变化、取消、重试耗尽、未知派发不重放；旧串行幂等标识兼容 |
| 只读并行 | Route 显式 parallel_groups，2–8 个连续且独立的只读步骤；所有分支验收后汇合 | 乱序回执；一支阻塞仍可接收已派发兄弟的回执；多个阻塞逐个恢复；写操作及组内依赖被拒绝 |
| Codebase | 默认 TypeScript checker；保留显式 heuristic 降级；真实 Jedi Python 适配器；LSP 接收显式关系边 | 别名、方法、同名、注释/字符串负例、不可调用值不产生调用边、缓存后依赖变更、UTF-16 位置；Python → checkpoint → MCP import → callers 真正贯通 |
| Host 接入 | initialize/tools/list/readiness 暴露实际 schema、入口文件摘要和能力清单；Skill/插件包同步 | 四组件共 74 次真实 stdio 业务调用；握手 schema 与当前入口文件摘要一致 |
| 收益对照 | 复用现有 EvalCampaign，准备无组件、四个单组件及组合的配对试验；固定 Host/model/repository/budget | 24 个 development 场景目录；准备器要求 20–100 个已批准 held-out Case，默认每例三次；没有实际运行时维持 awaiting_actual_host_runs |

实现仍以 Skill + MCP 为可独立使用的标准路径。Hook 只增强触发时机与生命周期信号；接入方应以 initialize、tools/list 和真实业务调用确认当前会话，而不是只检查安装状态。

## 入口与运行边界

- [Knowledge Skill](../../skills/craft-knowledge/SKILL.md)、[Memory Skill](../../skills/craft-memory/SKILL.md)、[Experience Skill](../../skills/craft-experience/SKILL.md)、[Codebase Skill](../../skills/craft-codebase/SKILL.md) 已更新。
- [Procedure 执行合同](../../skills/craft-experience/references/invocation.md) 说明恢复证据、并行与结果状态。
- [Python 分析器](../../scripts/codebase/analyze-python.py) 使用 `uv run` 安装固定 Jedi 0.19.2，读取显式 checkpoint JSON；不执行项目代码。已随 Codebase 插件打包。
- [消融准备器](../../scripts/eval/component-ablation.ts) 在源码/npm 包中运行：`node scripts/eval/component-ablation.ts DATA_DIR manifest.json`。必须明确数据目录，并提供 environment、budget、acceptance_ref、六个不同 harness 标识和已批准的 case_ids。
- [场景目录](../../scripts/eval/component-case-catalog.json) 是开发材料；不能作为独立审批、真实模型运行或效果提升的证据。
- [远程配置与验收](../../deploy/components/README.md) 保留原交付方式。本轮仅启动临时本机 HTTPS 服务验证租户隔离。

知识摄取限制为 10,000 文件、每文件 2,000,000 字节、总计 20,000,000 字节；超限需缩小来源。Embedding 请求每批最多 32 项/32,000 字符，每次搜索最多 10,001 项/8,000,000 字符，单请求 10 秒、总体 60 秒。TS 分析最多 2,000 文件/20,000,000 字符；导入仍受现有节点、边、体积预算约束。

`entrypoint_digest` 表示服务器创建时的进程入口文件。CJS 单文件包可以用它比对整个 bundle；源码/ESM 多文件模式不能把它解释为全部加载模块的摘要。`model_revision` 是配置绑定值，不是供应商对模型版本的独立证明。Host Session、Observation 和反馈的证据绑定也不自动证明提交方独立执行过程序。

## 验收结果

[机器可读证据](evidence/industry-gap-implementation-2026-09-28.json) 保存源码摘要、产物摘要、协议指纹和测试范围。

- 257 项受影响回归通过；另有 22 项组件/接入检查、6 项运行包检查、1 项本机 HTTPS 租户隔离检查通过。未运行全仓测试。
- 17 个受影响注册模块门禁均通过：原生行、函数、分支覆盖率都是 100%。
- 相对本轮开始前的脏工作区快照，新增/修改可执行语句 633/633、分支路径 708/708 覆盖；包含本轮新增评测、打包和协议检查脚本。没有降低覆盖率阈值或添加忽略标记。
- Python 的 5 项测试通过；74/74 语句、30/30 分支覆盖。另完成 5 次 MCP 调用的真实 Jedi 导入链路。
- 四个组件 74 次 stdio 调用通过。产物复制后的 Runtime 在没有源码、没有开发依赖的目录中启动成功；TypeScript 已列为运行依赖。
- typecheck、core build、5 个入口 bundle、plugin pack、发行清单、分层检查、工具面检查、文档链接与 diff 检查通过。
- 全仓覆盖清单还有 201 个既有未登记文件；这项全仓审计状态仍为 incomplete。

打包时 pnpm 的自动依赖检查尝试联网安装，被当前环境中断；随后使用仓库已安装的 TypeScript/esbuild 执行同一构建入口并完成产物验收，没有清空或替换 node_modules。本机 HTTPS 检查需要允许 loopback 监听，已在隔离临时目录完成；没有发布远程服务。

## 尚存的能力边界

1. 本构建尚未在 Codex、Claude、Cursor 等真实 Host 的完整任务集上证明收益。实际宿主登录、挂载及模型对照仍需对应环境；本轮会话只暴露 Memory MCP，缺 canonical scope 时跳过读取，Knowledge/Experience 走 Skill 的 unavailable 分支。
2. Codebase 仍是有界图存储。TS 复用解析树，但 checkpoint 变化会重新绑定和建图；尚无大仓持久分片、增量关系索引。Java/Go 只验证了 LSP 标准化合同，未完成真实语言服务器调用关系验收。
3. 运行时动态条件、回环和跨副作用补偿没有扩展成通用 Graph 执行引擎。当前交付是命名 Entry/Exit、固定子流程、有界只读并行和证据驱动恢复。
4. Memory 维护输出可审查动作和候选，仍由 Host/已配置调度推进；不会自行生成、批准并发布新的长期结论。
5. 标注检索评测使用调用方提供的数据集；消融准备器不伪造独立审批或真实任务结果。真实项目召回率、质量提升与成本收益仍待测。
