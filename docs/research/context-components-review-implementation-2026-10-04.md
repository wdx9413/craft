# Context 与子能力审查：修复与交付

日期：2026-10-04。审查固定 HEAD 为 `9ada1c7a92dfc3847837b063081176696ca9f463`，范围包含当前未提交实现。增量证据相对本轮开始前的工作树快照计算，保留此前功能改动。此次交付本地源码、Skill 与分发产物，不安装全局插件、不上线远程服务。

## 审查结论

现有 Context 聚合、四个独立组件、Procedure 多入口/出口与 Graph 分工可以继续使用。主要问题是访问策略在调用链中丢失、候选上限造成跨项目漏召回，以及索引/返工恢复的状态一致性。本轮修复这些确定缺陷，并补上默认入口需要的检索控制和不完整结果说明。

原始发现分别记录在 [Standards 审查](context-components-standards-review-2026-10-04.md)、[Spec 审查](context-components-spec-review-2026-10-04.md)；它们描述修复前的发现和当时证据，最终状态见下表。

## Standards 修复

| 问题 | 已实现行为 | 直接证据 |
| --- | --- | --- |
| Source 私有受众/租户未约束派生材料 | Knowledge、Memory 召回同时检查材料和 Source 当前权限；Source 的内容用途不覆盖派生记忆自身用途 | `tests/context-source-access.test.ts` |
| Memory 精确读取、列表、历史绕过访问策略 | 当前与历史 Envelope 双重校验，当前 Source 权限收窄不能被历史版本绕过；保留旧精确 ID 读取兼容 | 同上 |
| 无 scope 维护短路权限，空集合退回 legacy | Ledger、semantic、legacy 一致过滤；存在 Ledger 时不会因过滤后空集合而退回旧数据 | 同上 |
| 聚合丢失用途/身份和已有检索控制 | 显式贯通 `cognitive_purpose`、scope 扩展、来源/必选记忆、restricted/working-notes、检索 adapter 与时间 | `tests/context-aggregation-policy.test.ts` |
| 远程读取接受客户端自报身份 | 认证 receipt 的 subject digest 与服务端 tenant 绑定到已声明参数；身份冒充明确拒绝 | 同上；`tests/component-remote-deployment.test.ts` |

Source 访问谓词复用已有 ScopeAccess，没有新增并行权限系统。远程模板仍是共同信任租户，尚非完整的逐用户写入授权平台。

## Spec 修复

| 问题 | 已实现行为 | 直接证据 |
| --- | --- | --- |
| tracked 文件绕过 Git ignore | 全部候选读取前经过 Git 规则引擎；支持 NUL 文件名、否定规则与错误传播 | `tests/context-spec-regressions.test.ts` |
| 恢复 checkpoint 后误报旧索引 ready | 检查索引真实状态和策略版本，按当前 workspace revision 重建；基础缓存固定 analyzer 版本 | `tests/context-aggregation-policy.test.ts` |
| 配置式 Procedure 无法导出 Skill | 从已校验 Workflow/Graph 定义生成既有 Markdown 视图和 JSON；保持 routeable 门禁与 disabled 草稿 | `tests/context-spec-regressions.test.ts` |
| 同名材料加工后返工丢失先前输入 | 从初始输入及未失效、已验证历史重建名字绑定；保留旧审计记录，旧输出不能冒充当前验收 | 同上 |

## 业界对照后的能力补齐

本轮对照了 Anthropic 的按需上下文、Cursor 当前搜索/忽略边界、Graphiti 来源与时态、LangGraph checkpoint/store，以及 MCP 工具发现规范。来源、版本差异与八组候选方向在 [业界调研](context-components-industry-review-2026-10-04.md) 中。

1. **可控首包**：`include_codebase:false` 支持纯知识任务；自动仓库索引仍为编码任务默认，无逐项目激活。聚合可使用已经评估的检索 adapter、来源过滤和必选 Memory。
2. **真实的不完整结果**：顶层与 pack receipt 汇总成员失败、索引不可用、基础分析不完整、文件遗漏、预算不足、查询截断；独立严格调用仍传播错误。超大 contributor 在允许部分结果的聚合路径隔离，不吞掉必选材料失败。
3. **正文去重保留出处**：Knowledge 的大小写转换和 tags 不再污染去重键；完全相同正文只占一份材料预算。最多保留 100 组去重来源引用并记录超额计数，不做近似语义合并，不改变历史视图。
4. **多项目召回不被全局 LIMIT 挤掉**：Knowledge、Memory（含历史）、Experience 先过滤可访问候选，再执行 10,000 条上限；sources 按需读取。用当前项目旧记录加 10,001 条其他项目新记录验证不漏召回，当前范围真正超限则明确失败或聚合 partial。

对应测试为 `context-aggregation-policy`、`context-candidate-scope`、`context-source-access`、`context-spec-regressions`。这次没有更换数据库、引入自动执行器或让 Hook 成为必需条件。

## 验证与分发

本轮运行 225 项相关回归、随后扩展后的 10 项聚合边界回归，以及 6 项本机隔离 HTTPS/认证验收，均通过。前两组有重叠，不相加为不同测试总数。本轮 14 个运行时文件增量覆盖为 **200/200 语句、232/232 分支，均 100%**；方法和前后文件摘要见 [增量覆盖证据](evidence/context-review-incremental-coverage-2026-10-04.json)。这不是整个仓库的 100% 覆盖或全量测试声明。

分发构建与检查结果记录在 [本轮验收证据](evidence/context-review-delivery-2026-10-04.json)。五产品的 Codex、Claude、独立 Skill + MCP、dsh 产物共用修复后的 Runtime。DSH 本地矩阵替换宿主注册函数，MCP 进程和业务调用真实执行；仍需真实模型会话才能证明宿主实际遵循 Skill。

## 仍值得投入的增强

以下是明确保留的能力边界，不计作已经实现：

- **按任务分配代码预算与大仓聚焦**：现在 K/M/E 先使用共享预算，Codebase 使用余量；自动入口最多选 500 个文件。下一步可增加可解释的代码配额/任务文件范围，先用 review、需求开发、纯知识任务比较引用准确率和遗漏。当前可用高级 Workspace 缩小范围、单独查询代码。
- **统一回执重检**：现在应在权限、来源、Memory、Procedure 或代码变化后重新 resolve。可以再提供只读 validate API，沿用当前权限检查并逐项说明 stale/revoked 原因；回执自身仍保留历史审计用途。
- **规模与上下文成本**：Store predicate 仍读取全表后过滤，未完成 SQL 分页/索引优化；dsh discover 仍返回完整工具目录。先测 1k/10k/100k 数据规模、冷/热仓库和序列化输出，再实现范围索引、游标扫描及按工具名发现。MCP 字符预算不是精确 token 预算。

没有执行真实 IdP、Docker 镜像构建、Codex/Claude/dsh 模型会话或线上发布，也没有把回归成功当成 Agent 效果提升。效果仍需在固定 Host/model/仓库/预算下做带 Context 与不带 Context 的配对研发任务评估。
