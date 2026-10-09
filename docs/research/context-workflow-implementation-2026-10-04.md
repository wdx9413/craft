# 上下文可见性与工作流规格优化：实现及验收

完成日期：2026-10-04（验证跨越 10 月 3 日晚至 4 日）。依据：[研究与建议](context-workflow-learning-opportunities-2026-10-03.md)。用户授权按建议实施。改动基于既有工作区，保留了此前大量未提交变更，没有发布新版本或重启用户应用。

## 交付结果

| 验收点 | 实现 | 验证结果 |
| --- | --- | --- |
| 人能看到上下文使用依据 | 侧边栏新增“上下文使用”。按明确范围显示回执、精确引用版本、摘要、来源、作者、当前状态、关联任务、预算遗漏与历史记录缺失。提供、遵循、结果验证分开表达。 | 服务/API 测试通过；浏览器完成范围查询。没有记录 Host 时明确显示未记录，遵循保持未知。 |
| 停用影响后续召回 | 页面调用现有 Memory 撤销和 Knowledge 失效内核，要求同范围和当前版本；保留旧回执。 | 正常、越范围、限制级别、版本冲突、来源撤销、后续不再召回及另一项目隔离均有测试。 |
| 用户不用写 JSON 也能整理流程 | 新增“梳理流程”，按八个问题整理实例、触发、输入、步骤、输出、预算、失败与样例；保存未决问题，可恢复版本并复制 Markdown 交接材料。 | 浏览器真实完成保存、继续填写、重新打开；测试验证并发版本冲突、范围切换、编辑器切换与旧响应隔离。 |
| 规格与经验权限分开 | 复用通用对象存储，新增 `workflow_design` 对象类型，无数据库迁移；草稿始终 `execution_authorized:false`、`routeable:false`。Experience Skill 新增条件触发的设计指南。 | 草稿内容完成只进入待复核，不执行、不安装，也不自动生成 Observation 或可召回 Procedure。 |
| MCP 参数与运行包对齐 | 当前源码已有正确参数契约，实机安装包较旧且缺 runtime fingerprint。重新构建四组件包，并在备份后更新本机缓存。 | 源码构建产物、组件包、本机安装产物均通过 stdio `initialize`、`tools/list` 和实际业务调用，共每轮 74 次调用。 |
| 可重复的配对评测 | 新增 8 类合成导出状态样例、固定规则/数据摘要、独立判分器和 3–100 对同 Host/模型/预算比较。缺失结果为 inconclusive，回归保留。 | 判分机制测试通过；真实模型试验未完成，详见下文。 |

记录页复用已有 token/origin 防护；不读取正文，不展示带 principal/tenant 或限制权限的回执。数量明确为当前范围可见回执数，最多 100 条并显示截断；旧回执没有逐条引用时不补造历史。停用不撤销已发生的外部动作。

两个新增页面无需先配置模型。功能定位是本地规格整理，尚不支持模型自动访谈、自动生成可运行 DAG 或自动证明用户填入的样例正确。

## 主要入口

- [上下文投影及撤回](../../core/application/coordinators/context-usage.ts)、[回执引用补齐](../../core/context-resolution.ts)。
- [工作流设计服务](../../core/application/coordinators/workflow-design.ts)、[两个页面（已迁移）](../technical/modules/presentation-separation.md)。
- [Experience 设计指南](../../skills/craft-experience/references/design.md)。
- [独立评测样例及判分器](../../scripts/eval/completion-contract.ts)。

## 验证证据

新增 7 项测试全部通过。新增四模块行、分支、函数覆盖率均为 100%；既有四文件新增功能行由 c8 或浏览器 V8 覆盖记录核对，未覆盖新增行数为 0。覆盖率是本次范围，不代表全仓库覆盖率 100%。

- [覆盖率、安装包协议及环境阻塞证据](evidence/context-workflow-2026-10-04.json)。
- 相关回归共 68 项通过；其中 Workbench HTTP 测试首次受 sandbox socket EPERM 阻塞，获得本地网络执行权限后 5 项全部通过。
- TypeScript 类型检查通过；层级审计 367 模块、0 违规；工具表面、插件包、版本目录检查通过。
- 浏览器验证渲染、保存、恢复、范围查询，无页面 JavaScript 异常，并覆盖离线页面和普通页面的模型设置分支。
- 全仓库覆盖率库存检查仍存在既有未归组模块；本次没有将其掩盖成全仓库绿色状态。

可重跑新增模块覆盖率（仓库根目录，使用已有 Node 环境，无需安装依赖）：

```sh
node --experimental-strip-types --experimental-test-coverage \
  --test-coverage-include='core/application/coordinators/context-usage.ts' \
  --test-coverage-include='core/application/coordinators/workflow-design.ts' \
  --test-coverage-include='workbench/context-workflows.js' \
  --test-coverage-include='scripts/eval/completion-contract.ts' \
  --test tests/context-workflow-workbench.test.ts \
  tests/context-workflow-pages.test.ts tests/completion-contract.test.ts
```

## 实验如何复现及当前阻塞

八种样例覆盖 queued、有效产物、同步产物、失败、取消、轮询超时、重复提交和产物范围错误。它们是状态判断 Fixture，不是实际导出接口的端到端验收。

用 `completionPrompt(false)` / `completionPrompt(true)` 分别生成不含答案的基线/候选提示词，以相同 Host、模型和预算跑至少三对独立新会话，交替运行顺序。每次保存模型原始 JSON 输出，填入下面的记录结构，组成 `runs.json`。不要把测试预期答案作为模型输出。

```json
{
  "trial": 0,
  "arm": "baseline",
  "host": "实际 Host 及版本",
  "model": "实际模型版本",
  "budget": {"timeout_seconds": 55},
  "dataset_digest": "COMPLETION_DATASET_DIGEST 的值",
  "output": {"decisions": []}
}
```

`trial` 每对相同，`arm` 分别为 `baseline` 和 `candidate`；同一批次 Host、模型、预算与数据摘要必须一致。用以下方式调用判分器：

```sh
node --experimental-strip-types --input-type=module -e '
import { readFileSync } from "node:fs";
import { compareCompletion } from "./scripts/eval/completion-contract.ts";
console.log(JSON.stringify(compareCompletion(JSON.parse(readFileSync(process.argv[1], "utf8"))), null, 2));
' /absolute/path/to/runs.json
```

本机实际尝试了 Codex CLI 0.151.0 的临时只读会话，使用当前配置的 `gpt-6-astra`。CLI 返回该模型要求更高版本，退出码 1，无模型输出。因此未继续浪费其余配对请求，没有生成胜率或学习收益结论，没有切换用户模型或升级用户 CLI。

即使 Fixture 分数提高，报告仍保留 `verification_provenance:host_attested`、`production_effect_proven:false`、`promotion_eligible:false`。后续需在兼容的真实 Host 上重跑，再通过现有 Procedure Invocation 验证真实终态、恢复、重复副作用、成本和时延。

## 本机插件状态和恢复

更新范围仅为四个已安装组件的共享 `dist/plugin/craft-mcp.cjs`，以及 Experience Skill 和其设计、组合、调用参考文件。安装目录为 `~/.codex/plugins/cache/craft-marketplace/<component>/0.12.37/`；旧文件备份在 `/private/tmp/craft-installed-before-context-20261003/`，按相同组件及相对路径恢复即可。新增参考文件原先不存在，需要恢复时单独移除。

本次重新打包的共享文件摘要：`7239bb8881121c2588cc405146fc8a68c73263283e06cfa584c79df155fa75c0`。本机安装包的新进程已验收；当前对话的 MCP 进程与工具描述仍是旧版本，需要重连后才能验证当前 Host 会话。这不等于桌面二进制已重打包或公开版本已发布，缓存也可能被插件更新覆盖。

结束时通过共享 resolver 再次使用当前项目的 Knowledge、Memory 与 Experience，回执为 `context_resolution_baed235e13bd45bc9ee1b36a4d443970`。当前可调用旧 Experience schema 未提供 scope 字段，因此没有创建无作用域 Observation，也没有用真实模型失败伪造成功学习记录。
