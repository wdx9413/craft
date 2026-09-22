# 真实 Host Runner 与 GitHub Actions：一手资料调研

> 调研日期：2026-09-22
> 范围：Codex、Claude Code 的官方无人值守接口与结构化运行事实；GitHub Actions 的官方安全边界；对 Craft v0.12.37 的差距判断。
> 结论级别：外部事实仅引用供应商/项目官方文档或官方源码；Craft 判断基于当前工作树代码与文档审阅。

## 结论

Craft 已有受限的 `CodexHostKernel` 和 `ClaudeHostKernel`：它们以参数数组调用 CLI、固定工作区和权限模式、限制输出/超时，并保存宿主回执。因此不应另建一个“编码 Agent 运行时”。

v0.12.37 的关键缺口是**评测桥接**，不是再加一个 CLI：当前 Engineering Profile 可以验证已经存在的 `host_session`、独立 `outcome_observation` 与 program Evidence，却没有一个可重复运行的 Host runner 把 CLI 的真实终态事件、冻结工作区验收和 sibling-caller 断言转成这些受信事实。没有这层桥接，就无法产生计划要求的真实 Codex 配对试验回执。

推荐最小实现是一个仅供 CI/本地显式调用的 `host-evaluation-runner` Adapter：它消费已固定的 Case、Task-bound Activation、Host Session 和预算/模型/环境指纹；通过既有 Codex Driver 运行；独立执行确定性验收与 sibling 断言；只导入摘要、digest 和 Evidence 引用。它不直接晋级 Profile、不创建 PR、不写远端，也不接受任意命令或 prompt。

## 官方宿主能力

| 宿主 | 可用于真实评测的官方能力 | 对 Craft 的采用方式 |
| --- | --- | --- |
| Codex CLI | [`codex exec` 非交互模式](https://developers.openai.com/zh-Hans/docs/non-interactive-mode) 支持 `--json` JSONL 事件、模型/工作目录/沙箱选择、`--output-schema`、恢复和终态 usage；官方明确默认只读，自动化应采用最小权限，`danger-full-access` 只可用于隔离 runner。 | 固定 `codex exec --json --ephemeral --sandbox <read-only|workspace-write>`；以 `turn.completed`、`turn.failed`/`error` 和 CLI exit status 判定 Host 终态，usage 进入成本/时延事实。最终 schema 仅约束摘要，不能替代验收。 |
| Codex GitHub Action | [官方 GitHub Action 文档](https://developers.openai.com/codex/github-action/) 支持固定 CLI 版本、sandbox、输出文件与受限运行策略；官方建议只让可信触发启动，清洗 Issue/PR/commit 中的 prompt 输入，并保留 `drop-sudo` 或无特权用户策略。 | 不把 Action 当作 Craft 的事实源；第一期仅在受控 CI job 调用 Runner，产出 patch/回执 artifact，后续独立 job 或人工消费。禁止将 API key 作为执行仓库代码的 job 级环境变量。 |
| Claude Code CLI | [官方 CLI 参考](https://code.claude.com/docs/en/cli-usage) 指定 `claude -p` 为非交互入口，支持 `json`/`stream-json`、`--json-schema`、`--max-turns`、`--max-budget-usd`、`--no-session-persistence` 和权限模式。`stream-json` 会给出过程事件，适合审计。 | 保持既有最小 Tool allow-list；从 `stream-json` 的终态 result、usage、cost 和工具事件构造 Host receipt，而非从模型自然语言结论推导成功。`--json-schema` 只约束最终摘要。 |
| Claude GitHub Actions | [官方 GitHub Actions 文档](https://code.claude.com/docs/en/github-actions) 将带 prompt 的运行定义为 Automation mode；要求最小 GitHub 权限、秘密管理、写入权限与人工触发校验，并建议审查后合并。 | 作为第二个 Host adapter 的部署选项，不进入 v0.12.37 的真实 Codex 首期评测。对于 schedule/bot 必须显式 allow-list，不能默认绕过 actor 校验。 |

Codex 官方 SDK 源码进一步确认非交互适配器可通过 `exec --experimental-json`、`--output-schema`、`--sandbox`、`--cd`、模型和预算相关配置来固定运行输入：[`sdk/typescript/src/exec.ts`](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)。CLI 源码定义 `--json` 为 JSONL 事件输出、`--output-schema` 为最终响应 JSON Schema：[`codex-rs/exec/src/cli.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs)。这支持使用结构化事件作为回执，但不支持把最终文本当作验收事实。

## GitHub Actions 安全边界

GitHub 官方要求第三方 Action 固定到完整 commit SHA；tag 不是不可变发布物：[`Secure use reference`](https://docs.github.com/en/actions/reference/security/secure-use)。因此现有 `actions/checkout@v4`、`actions/setup-node@v4`、`pnpm/action-setup@v4` 是可读的惯用 tag，但不满足最严格供应链固定；应在独立安全收口中固定 SHA 并记录来源。

真实 Host runner 不应使用 `pull_request_target` 来检出、构建或执行来自 fork 的 PR 代码。GitHub 明确说明这会使具有 secrets/写权限的工作流遭受 pwn request；应使用无 secrets 的 `pull_request` 运行不可信代码，并把需要凭据的处理隔离在可信触发的后续步骤：[`Securely using pull_request_target`](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)。自托管 runner 若将来使用，必须是隔离、短生命周期且不跨运行复用的环境。

## Craft 当前事实与缺口

### 已具备

- `src/codex-driver.ts` 已以 `codex exec --json --ephemeral` 调用，固定 `read-only`/`workspace-write` sandbox、工作目录、prompt digest、超时和输出上限，并记录 exit status、JSONL 完整性、thread、usage 和回执 artifact。
- `src/claude-driver.ts` 已以 `claude -p --output-format stream-json --verbose --no-session-persistence` 调用；只读模式仅暴露 `Read,Glob,Grep`，写入模式仍不开放 Bash 或 MCP。
- `capability/engineering-quality-profile.ts` 已拒绝调用方传入的“通过”布尔值：旧 `evaluationRecord` 只能形成 `revalidation_required`；`evaluationReceiptRecord` 要求固定计划匹配的 terminal Host Session、独立 Observation 与 confirmed program Evidence。
- `host-session-events.ts` 已固定 Task、Host、模型、预算、环境、策略、Capability 指纹，并将 session 事件写入 Trace。

### 尚未实现或不足

1. **真实试验入口缺失。** 未找到将 Engineering Profile Case 执行到临时副本、调用 Codex、运行冻结验收和 sibling 断言、创建 Host Session/Observation/Evidence 并导入 `evaluationReceiptRecord` 的 Adapter 或 CLI。已有 Driver 与 Profile 是两段正确但未连接的能力。
2. **回执字段不够细。** `evaluationReceiptRecord` 只从独立 Observation 的单一 `passed` 推导 deterministic acceptance、sibling、未授权 effect、安全回退与事实回退；它没有分别绑定这些检查的 Evidence。最小扩展应要求每一项 verdict 都有对应的 program Evidence/ref，且将 effect 检查从“默认 false”改为由 Host event/Policy 证据导出。
3. **Case 资产尚未落地。** Profile 仅有 Store 中的冻结 Case 契约，仓库内没有 12–20 个脱敏 `bug-fix-shared-caller` Case 的版本化 fixture、工作区快照机制、验收执行器或保留集清单。
4. **独立观察尚未形成实际隔离。** 内核能验证 `observer_id !== host_id`，但未定义谁运行 acceptance/sibling 检查、其可执行权限和产物格式。第一期应由单独的 verifier process/CI step 产生 Observation；这只是协议独立，不能宣称进程级安全沙箱。
5. **终态和失败模型需统一。** Codex 应以 JSONL terminal event + exit code，Claude 应以 stream-json `result` subtype + exit code；超时、取消、输出截断、非法事件、预算耗尽、无进展都必须产生 handoff/rejected evidence，而不是由 Runner 补写 accepted outcome。
6. **CI 发布证据尚缺。** 当前 `test.yml` 只跑构建、静态检查、单元测试和插件 smoke，不运行真实 Host trial；这符合“非默认自动执行”的边界，但 release 不应宣称已证明 Engineering Profile 收益。另需从失败的具体 run 日志定位 GitHub Actions 报错，不能凭本地通过推断远端故障原因。

## 推荐的最小方案

1. 新增一个内部 Adapter/CLI，而非扩展 Craft 核心或默认插件面。输入只能引用已冻结 Case、既有 Task-bound Activation 和已创建 Host Session；Runner 自行创建临时目录副本，拒绝工作树、任意可执行文件、任意 prompt、Graph/外部 effect 与无授权本地写入。
2. Runner 以参数数组调用既有 `CodexHostKernel`。固定 Codex CLI 版本、模型、预算、环境与 Capability/Policy digest；解析 JSONL 到原始受限 artifact（权限 `0600`），仅向 Store 导入 digest、terminal event、usage、时延和允许的 artifact/Evidence 引用。
3. Runner 结束后交给独立 verifier process 执行 Case 固定的 acceptance 与 sibling-caller 命令。每项命令的 binary/version、工作区快照 digest、exit code、输出 digest 和 program Evidence 分别入库；任一失败/缺失/越权即写 handoff 或 rejection，不生成 `verified` record。
4. 仅当 Host terminal、环境指纹、四类 Case digest、effect 检查和独立 verifier Observation 均匹配时，调用现有 `evaluationReceiptRecord`。逐 Case × arm × trial 写入，完整 paired records 才能执行已有 Evaluate；三次仅诊断，五次才有 routeable 候选资格。
5. CI 拆为两个权限域：PR 的无 secrets 单测/fixture verifier；可信、显式 `workflow_dispatch` 或受保护分支的 Codex Trial job。后者最小权限、短生命周期 runner、固定 Action SHA、每个 Trial 输出只读 artifact；不 push、不建 PR、不合并。将 artifacts 的 digest 和源提交绑定入 release archive。

## 验收标准

- 对一个脱敏 Case 的 baseline/profile 各一次，能在不改当前工作树的临时副本中产生可读取、可复验的 Host Session、独立 Observation、program Evidence 和 `verified` evaluation record。
- 模型、预算、环境、Capability、Case snapshot、CLI terminal、验收或 sibling 任何一项漂移/失败，均拒绝导入或降为 handoff/rejected；不得写 accepted outcome。
- Runner 单元测试覆盖：Codex JSONL 的 completed/failed/error/非法行/截断、CLI 超时/取消、Verifier 不独立、无 Evidence、越权 effect、重复 slot、Case digest 漂移和完整配对比较。
- GitHub Actions 的 untrusted PR job 无 secrets/写权限；受信 Host trial job 不检出和执行 fork 代码，Action 固定 SHA，CLI/模型/预算/环境/源提交信息全部被记录。
