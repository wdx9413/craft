# 0.12.99 学习链路候选与验收记录

## 目标与结论边界

目标仍为五能力完整自进化。此前 `.98` 的真实 CLI 调用与完成 Trace 证明调用链可运行，但结果为 `case_skipped`，没有产生独立评测案例，不能证明知识收益或晋升有效。本轮把受限调用、失败诊断、Experience Trace 关联、归档证明读取和留出调度合成一个候选。

## 代码与合同

- `deploy/experience-learning/codex-cli-transport.ts`：估算业务输入默认上限 8192 token，超限在启动子进程前拒绝，不截断证据；保留只读 sandbox、临时调用和原有安全规则。限制技能上下文并关闭 shell、图像和网页工具，发现工具事件时拒收结果。8192 不是 Host 总输入上限，实际消耗以 CLI usage 为准。
- `deploy/experience-learning/knowledge-sync.ts`、`learning-tick.ts`、`worker.ts`：只输出受约束的错误码及阶段，不在后台诊断中泄露原始正文、路径或异常消息。MCP 结构化错误码会加 `ERR_MCP_` 前缀。
- `worker.ts`、`experience-scenario-classification.ts`：Experience 模型请求、响应、候选提交、评测分发和票据完成关联同一 Trace；失败有阶段记录。票据保留传入 Trace，并校验模型、任务和操作关联。兼容路径未提供 Trace 时仍可完成，因此不能据此宣称所有历史票据均有模型证明。
- `session-knowledge-candidates.ts`：候选处理状态保留终结 Trace 引用。`evaluation-model-profile.ts` 通过注入的 Trace reader 读取归档 Knowledge 调用证明；归档不可读时失败，不把它误当成从未调用而重新生成。
- `session-knowledge-evaluation.ts`：持久化 `last_attempted_task_id`，每轮最多一个任务；等待审核或失败的任务不会被标成已完成，也不会永远挡住后续任务。旧状态没有该字段时保持兼容。没有任务不调用模型。

## 隔离与验证方法

候选基线为 main `708b3dd08eaa8ee388dd7a558f7e65175fb2de56`，从 Git archive 建立临时验证目录，无分支切换。只纳入学习链路与所需版本元数据，主工作区其他改动保留。候选临时目录用于验证，不绑定为安装来源。

持久项目测试改用 `/workspace/craft-persistent-project` 的只读模拟内容引用，避免 `process.cwd()` 在临时验证目录中被正确识别为临时项目而误报失败。生产临时目录隔离规则保持不变。

`evaluation-model-workflow-evolution.test.ts` 中依赖未发布 Store 分区实现的“不可迁移 scope”断言留在主工作区，候选保留票据目标 scope 不匹配的负例。Store 分区及迁移一致性尚需单独完成完整验收，不将其算成本轮已交付。

验证日志与覆盖率位于 `/private/tmp/craft-learning-release-vk48184t/`；正式发布与真实运行证据在核验后追加。测试通过、源码推送、Marketplace 发布、安装、当前会话连接、后台自动调度和真实收益分别判断。

## 未完成的整体验收

1. Knowledge 真实独立评测案例、已审定标签、效果比较、项目及跨项目晋升退出。
2. Memory 两个独立会话、三个项目的三级晋升，以及冲突、撤销传播、会话归档清理。
3. Experience 独立来源到项目产物、跨项目验证到全局产物，以及真实回退和后续任务收益。
4. 全能力范围存储、并发更新、过期拥有者、崩溃恢复和重复晋升门禁的真实验证。
5. Context 带正文的精确注入、重复 Hook/MCP 累计预算和 Host 总输入成本；真实大库并发性能目标。
6. Codebase 五语言固定真实仓库统一评测、分支和未提交变更隔离、重索引与性能。

不以单次模型调用、模拟产物、记录数量或局部覆盖率替代以上验收。

## 本轮已验证结果

- 203 项相关测试通过，失败 0；包含无任务不调用、业务输入超限不启动、工具事件拒绝、归档读取失败、模型失败重试和留出轮转。
- 相对 main 基线的增量覆盖：165 行、160 个分支、2 个函数，全部 100%。这不是整仓覆盖率。
- 类型检查、七个公共/能力包构建、插件构建与打包、发布目录和版本检查通过。独立 bundle 在无 node_modules 时可启动。
- 验证目录最初无 .git 导致打包检查不能执行 Git 跟踪断言；用只读 GIT_DIR/GIT_WORK_TREE 指向基线仓库与候选目录后检查通过，没有更改该断言。

## 远端发布与真实运行结果

源码 main `6e9f36d512109a27ad012e617f43b13d9de9094e`，Marketplace main `b91529d4e8a042155d2e0d95f4dbd53e97def4d1`，均已推送并读回。Marketplace 从该固定远端源码归档重建。本机由远端安装 `.99`，MCP/Hook/Worker 与 Marketplace 字节相同；MCP SHA-256 为 `d48a1304e3fecb92e606d7b355459ea9566633b3d52b2004c06a4e668038b363`。当前会话附带 MCP 仍 Transport closed；以下为新进程证据。

连续三个真实 Knowledge Worker `--once` 正常退出，正常领取和释放锁，未修改任务、标签或游标；轮转执行分类、会话候选和留出阶段。第一轮处理 9 个会话，第二和第三轮各处理 5 个会话；这是增量处理次数，可能包含重复文件，不是独立会话数之和。第一轮选中 5 个来源，4 个完成且各报告 1 条候选处理，1 个目录不可用；不能把处理计数当作新增独立候选。三个阶段均未新增评测案例，也未触发新模型调用。

对真实留出函数另做有界诊断（最多 8 个现有任务、每次最多 1 次模型请求）。CLI 0.163.0 退出 0 且返回最终消息，但 `.99` 拒收其 error 事件。脱敏诊断明确显示：`tools.view_image` 被该 CLI 忽略；另有技能目录预算超限通知。业务输入估算 811 token 的一次请求，CLI 实际 input_tokens 为 11667、output_tokens 为 77。此次仍标失败，没有评测案例或晋升；不能算作成功调用闭环。`.98` 的不同任务输入为 20796，二者不能用来计算严格的成本改进比例。

这暴露了发布前只验证模拟 CLI 响应的缺口。跟进修复见 [CLI 通知兼容记录](cli-notice-0.12.100-evidence-2026-10-22.md)，保留真实错误拒收门禁。
