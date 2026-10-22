# Context 0.12.97 发布与真实运行证据

日期：2026-10-22。本文记录已执行的发布与验证，不表示端到端自进化已经完成。

## 发布来源

- 源码 main 提交：`8b5002704681c98fb42449961bdd236a25615bb3`。
- Marketplace main 发布提交：`e6b8321c644b28b5d20f2670c0a11836cc26376e`。
- 发布范围：有界 Context 响应、读取调用的内容无关日志、批量状态计数、Trace 维护进程隔离及对应测试/版本信息。保留工作区其他未发布修改。
- 源码先推送，再下载固定远端提交归档；核对全部 50 个发布文件与受测候选一致，从该归档构建 Marketplace 产物。
- Marketplace `release.json` 保存来源提交和源码树摘要。通过 `codex plugin marketplace upgrade craft-marketplace --json` 刷新远端来源，再执行 `codex plugin add craft-context@craft-marketplace --json`，确认安装版本 `0.12.97`。
- 已安装的 MCP、Hook、Learning Worker 三个产物与 Marketplace 字节一致；MCP SHA-256：`2d9a68720fdc2b9b37b5670549fba9d8d3d53f60a444c081070a1102b414c088`。
- Marketplace 新增忽略 `.craft_data/`；发布提交不包含能力数据。

## 改动合同

- `craft_context_open` 默认返回 compact 响应，保留选中材料及稳定来源，移除重复审计数据。
- compact 默认最终响应上限为 1,500 个估算 token；full 必须显式给出预算。必需材料不能静默删除，不能容纳时明确失败。
- token 数使用现有字符估算器，不能当作模型 tokenizer 的精确计数；此上限也不覆盖 Host 已有历史和其他工具说明。
- 只读 MCP 调用的内容无关观测写入 JSONL，避免为读调用写 SQLite Trace。模型任务的 Trace 仍由其原有链路负责；本轮没有用只读调用代替真实模型调用证据。
- Trace 维护放到独立受限子进程，防止慢维护占用 MCP 主线程；不据此声称扫描量和磁盘争用已解决。
- 删除 MCP 中重复不可达的 full 响应参数检查，保留统一入口校验。

## 本地验证

在从清晰基线提取的发布候选中执行，未使用全部脏工作区代替发布源码。

| 验证 | 结果 |
|---|---|
| 七个相关测试文件：Context 投影、Trace Worker、可观测性、MCP、Service、Store、Action handlers | 81/81 通过 |
| 公共日志的只读嵌套、并发追加、文件系统失败 | 3/3 通过 |
| 相对发布基线的 16 个源文件增量覆盖 | 449 行、332 分支、35 函数；未覆盖数均为 0 |
| TypeScript `--noEmit` | 通过 |
| 发布目录、插件版本、插件包完整性检查 | 通过 |
| Marketplace 来源与同步检查 | 通过 |
| Marketplace 来源追溯测试 | 2/2 通过 |
| 最终暂存文件与受测候选逐文件比较、diff 空白检查 | 通过 |

覆盖率为本次增量覆盖率，不是全部历史代码达到 100%。重新开始采集后再汇总，避免把源码行号变化前后的 V8 数据混用。

## 真实安装包运行

每次启动独立进程，使用从远端安装的 `.97`，未把当前会话内已经挂载的 MCP 当作新版本。关闭连续学习和 Trace 维护，避免性能探测触发模型任务或存量归档。以下都是单次观测，不是延迟分位数或并发压测。

| 数据与动作 | 实际结果 |
|---|---|
| 空数据隔离环境，开启低频维护 | 初始化 595ms；维护期间 ping 1ms；info 9ms；无维护错误 |
| 同上，空 Context 查询 | 最终响应 551 个估算 token；上限 1,500；无 telemetry 错误 |
| 真实 `~/.craft_data`，首次独立探测 | 初始化 803ms；info 21ms；ping 小于 1ms；无 telemetry 错误 |
| 真实数据，第二次独立探测 | 初始化 696ms；info 22ms；ping 1ms |
| 第二次探测中的真实项目 Context 查询 | 352ms；最终响应 551 个估算 token；上限 1,500；无 telemetry 错误 |

第二次查询任务为“Craft MCP Context 响应预算与日志维护隔离”，`project_root` 是本 Craft 仓库，`include_codebase:false`。该次 Memory、Knowledge、Experience 选中条目均为 0，`partial:false`，`response_partial:false`。因此本次真实运行证明了启动、查询和响应边界，**没有证明相关材料召回质量或带正文时的真实模型收益**；材料保留和超限行为由对应相关测试证明。

真实数据的 info 返回 20 个非零计数键，零值键为 0。没有展示原始记忆、会话、知识正文或凭据。原始隔离日志与覆盖率明细位于本机 `/private/tmp/craft-release-097-review-vxz_my_u/`，临时目录可能被清理，本文件保存必要摘要。

## 未完成与下一验收

1. 当前长会话已挂载的 MCP 是否切换到新版本，未验证；新启动独立进程使用 `.97` 已验证。
2. 当前查询没有选中材料，尚需真实有相关资产任务验证“必要条件完整、无无关注入、后续按需展开”的模型效果。
3. 尚未进行真实大库后台维护并发压测、长期队列压力及崩溃恢复演练；JSONL 排队和保留成本仍需持续核验。
4. 本轮未新增真实模型任务、独立评测或晋升。接下来的关键路径仍是合格任务→受限 Host 调用→候选→独立评测→晋升或退出，并完成全部能力的真实生命周期验收。
5. 保留现有 Knowledge/Memory/Experience/Codebase 未发布改动，后续按其完整目标继续核验、修复和发布。不能将这次运行时发布作为整个目标完成。
