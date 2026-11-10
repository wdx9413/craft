# Context 非权限问题修复与验收

保留现有权限检查；C01 异步授权撤销竞态先前按用户要求排除，随后获授权并完成修复。本轮不升级产品版本，仍为 0.12.39。工作区已有 Graph、测试命名及表示层拆除改动保留。

## 实现

| 评审项 | 实现与验收入口 |
| --- | --- |
| C02 资产身份 | common-base/context-assets 统一 member/id/记录版/内容版/摘要/作用域；禁止 undefined/latest 伪引用。同 Source 的不同 Memory 不合并；required_refs 校验精确版本和摘要。 |
| 统一初始化、生命周期 | Context Open 和 Hook 均调用 Working Set；缺省回执稳定绑定材料、范围、访问上下文、任务/会话/轮次。Hook 输出有独立内容空白的 emission 记录；Host 缺少原生 turn_id 时为本次提示生成新的本地 turn_id 并随回执返回，Open 先重新受控选择，再仅排除同查询、范围、会话和轮次已输出且精确匹配的材料，补齐代码；更正、快照、任务变化产生新身份。没有永久正文缓存。 |
| 任务预算与必要材料 | code/review/debug/development 保留代码预算；跨能力必需引用先于可选材料，不能容纳时失败。Host history/state 仅接收版本化引用及摘要，不归档对话。返回材料序列化/token 估计，可用 max_tokens 约束估计；Host 实际 token 通过反馈单独记录。 |
| 渐进发现 | craft_context_tools_discover 返回任务相关小集合及精确 Schema 和估计占用。已有 daily/advanced 注册保持兼容；本轮不宣称所有 Host 的初始 Schema token 已减少，动态注册仍由 Host 决定。 |
| 反馈归因与更正 | 接受 Context 或 pack receipt，绑定具体资产及 selected/shown/used/verified。verified 需要同回执的 confirmed program Evidence。错误/过期进入 pending_review 更正任务；不直接改 Source。 |
| Knowledge 与查询成本 | listScoped 将字符串/对象作用域筛选下推 SQL；额外筛选用元数据，随后水合命中正文。Memory 当前版本检查可读元数据。保留增量来源导入、修改/删除失效与 cursor 漂移合同；Claim SDK 同步过期、来源/文档变化和有界矛盾关系。 |
| Memory 治理 | MemoryGovernance 和 MemoryCapture 迁到子包，core 保留兼容导出/委托。提供主题建议（需确认）、显式用户证据确认、治理任务；无 topic 的偏好捕获遇到相关条目/语言主题提示时，暂停自动提交，等待确认主题或明确替代。governed 模式也禁止绕过直接 Ledger 条目的冲突。更正/替代复用既有冲突选择→审核→approved commit→旧条目 supersede。 |
| Experience 双版本 | experience_release 固定正式记录，新候选不暂停旧正式版。Graph YAML 同时维护正式/测试内容版；晋级、候选失败、当前版撤销独立。规划/运行固定记录与定义；test 通道只读或绑定分离且已 checkpoint 的测试工作区。命名路由匹配解释缺失输入；diff 保留影响与重验说明。 |
| Codebase | 任务关键词/中文别名优先选文件及路径/符号；扫描移出发布写事务，include_paths 未变不追加 Workspace 记录。保留 Git ignore/退出/大小上限/快照检查。Adapter 预检区分可执行性、语义验收和完整性。 |
| 独立 SDK | Knowledge Claim、Memory 治理/捕获、Codebase 仓库准备迁入子包；仅依赖 common 包或 Workspace/Evidence 调用端口。Experience 仍向统一 Runtime 交计划，未复制执行器。 |
| 真实评测接入 | run-component-ablation 接入既有 CampaignRunner：Host argv 预检、匹配环境/预算、派发精确 case/harness/trial、绑定实际 TaskRun、使用既有 delivery grader。中断不重发未绑定动作；缺终态交付保持 awaiting_actual_outcomes，不编造指标或自动晋级。 |

## 验证

新增行为回归见 [context-remediation.test.ts](../../tests/context-remediation.test.ts)；执行/预检负例见 [component-ablation-execution.test.ts](../../tests/component-ablation-execution.test.ts)。覆盖门禁登记在 [coverage-gates.json](../../tests/coverage-gates.json)。最终源码验收：

- 13 组相关覆盖门禁通过，均为 100% 行/函数/分支（Context SDK、Working Set、Store、K/M/E 贡献、治理、Graph、规划/运行及仓库 Context）。新增执行/Adapter 两个脚本另经 c8 验证三项 100%；CLI 路径与失败/中断/未知终态均有负例。
- 97 项独立包、产品、MCP/Hook、SDK 和治理回归通过；新增 Context 行为测试 29 项、执行/预检测试 5 项。未运行整个仓库全量测试。
- typecheck、层级（401 模块无违规）、工具面、文档链接、版本/插件包装检查通过；diff 无空白错误。覆盖清单 new_missing=[]；既有 196 个基线未纳入门禁模块不计为本轮全库覆盖证明。
- build 成功。5 个独立新进程完成 initialize、tools/list 与业务调用：Context 9、Knowledge 22、Memory 14、Experience 45、Codebase 13，共 103 次；均通过，协议为 2025-11-25，实际 Host session 验证仍为 false。
- 子包使用 common 依赖；公共 exports 已包含治理、捕获、发布/规划和仓库准备接口。测试与包装没有提升产品版本。

## 环境边界

本机预检：Python/Jedi probe 失败，Java jdtls 与 Go gopls 不可用。这不妨碍基础索引及已有 checkpoint Adapter 导入合同，但无法据此证明三种语言的实际语义分析器验收通过。TS/JS 静态分析、LSP 归一化/导入负例与真实语言服务完整性分别计证据。

真实模型实验需要用户配置 Host adapter 和已独立审核的 20..100 held-out cases。没有真实运行与终态结果时收益为 unknown；本轮的 synthetic fixture 不能代替真实 Host/模型或生产验证。

## 执行真实消融

准备器继续接受既有 manifest；执行器额外要求 environment 包含 data_snapshot_digest、tool_schema_digest、model_fingerprint、host_fingerprint，以及既有 host/model/repository_revision。host_adapter 为 argv 数组与可选 timeout_ms。执行命令：

```sh
node scripts/eval/run-component-ablation.ts DATA_DIR manifest.json
```

Adapter 从 stdin 读取 JSON：preflight 携带 environment/budget，返回 ready 及实际 environment_digest/budget_digest（Craft digestJson 合同）；execute 携带固定 dispatch/environment/budget，只返回 task_run_id。Adapter 应从相同基线工作区、数据快照和工具 Schema 为每个 slot 准备隔离 TaskRun，保持模型与预算一致，并将终态 delivery/观察/证据写入同一受控数据空间。评分通过已有 Runtime，不接受 Adapter 自报成功率。未绑定 dispatch 必须先核对实际副作用并显式 bind，再继续，不能重新派发。

## C01 追加修复：异步撤销

- 初始读取只捕获相关记录种类的版本头，不水合其他项目正文；只将实际候选、来源、文档、发布指针及采用的别名纳入本次读取栅栏。状态/内容/授权修订后，旧请求明确失败并要求重新打开 Context。未相关记录变化不会阻止请求。
- Contributor 等待结束、每个 embedding 外发批次前、embedding 缓存发布前及最终返回前检查；Memory 同时重新读取当前授权与来源状态。撤销不能被 provider 的关键词回退或 allow_partial 隐藏。
- Resolution 的最终检查和回执发布在短 SQLite 事务内；Working Set、Context Open 和 Hook 在各自异步边界后再次检查。Hook 失败保持 fail-open，但不输出失效材料，也不登记成功激活证据。不跨网络等待持有写锁。
- [context-revocation-race.test.ts](../../tests/context-revocation-race.test.ts) 包含 21 个隔离回归，覆盖更换访问者/租户/作用域、敏感性、撤回/过期/替代/更正/删除、来源与文档撤销、发布指针、warm receipt、真实第二进程、外发批次及上层等待间隙。172 项相关回归通过，guard/resolver/retrieval-port 三个模块 c8 行/分支/函数均为 100%。
- 版本仍为 0.12.39，未新增依赖或数据库迁移。保证基于 CraftStore 的不可变记录修订合同；外部贡献者仍负责其独立来源的访问校验。本地并发证据不等于已证明生产曾发生泄漏。

C01 收尾：5 组直接受影响的覆盖门禁均通过 100% 行/函数/分支；额外 65 项上层与 Hook 边界回归通过。类型、层级、文档链接、覆盖清单及插件包装/版本检查通过；新包五产品冷启动 103 次业务调用通过，版本未变。
