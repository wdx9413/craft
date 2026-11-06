# Craft v0.12.37：生产 Agent、MCP 与代码库智能差距审查（2026-09-22）

## 结论

Craft 的方向是对的：它已经把通用 Agent 的难点拆为 Task / State / Policy / Receipt / Evidence / Outcome / Eval Gate，并把 Knowledge、Memory、Experience 的数据边界与外发产品边界分开。当前最大风险不是再少一个“能力名”，而是把大量**本地协议和 fixture 证据**误说成了“已经在真实 Codex / Claude 日常任务中产生收益”。

本次审查建议将下一阶段收敛为 **Activation & Proof 的真实运行闭环**，而不是扩张运行时：

1. 先使已有三组件、Engineering Profile 和新 `craft-codebase` 都能在真实宿主中产生可审计 receipt；
2. 再以固定 Case、等预算配对试验验证其收益和副作用；
3. 最后才考虑新的解析器、外部 Adapter、远程/自动化或更多外发产品。

`craft-codebase` 的正确定位是一个内部、显式启用、只读的 **Codebase Intelligence Capability**。它不是 Knowledge、Memory、Experience 的第四成员，也不该在未达到独立安装、索引正确性、隐私和 Host 效果门槛前成为 Marketplace 的第四个产品。

## 范围与方法

- 代码现状基于 `capability/craft-codebase/`、`capability/engineering-evaluation-runner.ts`、`src/activation-proof.ts`、`src/mcp-forward-compat.ts`、`src/release-catalog.ts`、覆盖率门禁配置及当前 capability matrix 的静态审查。
- 外部判断仅采用协议拥有者、宿主官方文档、OpenAI 官方发布/安全资料和项目官方源码/README；不以二手文章或营销 benchmark 作为事实依据。
- “已实现”只描述仓库中的协议/代码；“真实可用”需要受控宿主、环境、终态和独立验收的 receipt。两者在本文严格分开。

## 外部一手资料：对 Craft 有约束力的趋势

### 1. MCP 的正确职责是专用、可组合的 Server；授权和上下文聚合属于 Host

[MCP 架构规范](https://modelcontextprotocol.io/specification/2025-11-25/architecture) 将 Host 定义为连接生命周期、用户授权、安全政策和多 Server 上下文聚合的控制者；Server 则应提供聚焦的 resource、tool、prompt，彼此不应看到对话或其他 Server。这支持 Craft 继续以组件 MCP / 薄插件发布，而不应让任一组件悄悄读写 Host 配置、对话或其他 MCP Server。

2026-07-28 仍是 release candidate；其官方说明将 Tasks 移入独立 extension、强调 `traceparent` 等 OpenTelemetry 传播约定，并弃用协议 logging/roots/sampling，转向 OTel 或 Provider API。[MCP 2026-07-28 RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) 同时明确生产迁移会改写 task lifecycle。这证明 Craft 当前明确声明“实际 speaking 2025-11-25、只做前向兼容而不宣称完成迁移”是正确的；不能仅因代码知道新字段就升级协议宣称。

### 2. 生产代码 Agent 的价值来自受控 Harness、验证和隔离，不是只来自模型或 Prompt

[OpenAI 对 Codex Security 的说明](https://openai.com/index/codex-security-now-in-research-preview/) 将流程分为代码库上下文/可编辑 threat model、问题优先级与验证、补丁修复；其高置信结论依赖隔离环境中的 pressure-test。 [Codex 产品安全说明](https://openai.com/index/introducing-upgrades-to-codex/) 同样强调默认关闭网络、危险操作需授权以及验证命令。它们与 Craft 的独立 Acceptance、Effect 检查、Evidence 和配对 Eval 模型一致。

这也反过来说明：Engineering Profile 的 Markdown/规则、Host 的自然语言“完成了”、甚至单元测试绿灯，都不足以证明“更安全或更好”。在固定项目快照中运行、独立验收和明确的失败结论才是可信结论。

### 3. Codebase Intelligence 应优先接入精确的语义索引，而不是把正则/LLM 猜测包装成调用图

[SCIP 官方仓库](https://github.com/scip-code/scip) 定义了语言无关的代码索引协议，用于 definition/reference/implementation；其官方 indexer 列表覆盖 Java、TS/JS、Python、C/C++ 等多语言。[Sourcegraph 的 indexer 指南](https://github.com/sourcegraph/sourcegraph/blob/main/doc/code_navigation/explanations/writing_an_indexer.md) 建议从 occurrence/symbol 的最小索引开始、通过 snapshot 进行确定性金标测试、随后才逐步增加 implementation 等关系，并明确语义解析需要 compiler frontend 或语言服务器。

这给 `craft-codebase` 一个明确路线：不需要在 Craft 内复制 LSP 或图数据库；需要一个带 revision、解析器版本、覆盖率和 provenance 的统一查询契约。`builtin-regex-static-v1` 可以是早期的**低置信 fallback**，但不能作为“语义 callers / impact”或独立外发产品的质量基础。

### 4. 宿主能力扩张不等于 Craft 可以越过 Host 边界

[Claude Code CLI 文档](https://code.claude.com/docs/en/cli-usage) 显示 Host 自己拥有 MCP、plugin、permission mode、allowed/disallowed tool、background session 等控制面；它也将 `--dangerously-skip-permissions` 明确标为绕过确认。Craft 因而应把 Codex/Claude 看成受控事实源和可选 Adapter，不代替 Host 作授权，也不能通过 Hook 将全局命令权限扩大。

[Serena 官方 MCP Registry 页面](https://github.com/mcp/oraios/serena) 将其定位为“semantic code retrieval & editing tools for coding agents”。用户当然可以直接把 Serena 注册给 Codex/Claude；Craft 的差异化不能是重复一个 MCP，而是给外部分析器结果加上 project scope、snapshot、provenance、stale、policy、receipt 和评测边界。

## 当前架构：已具备的基础与可信边界

| 领域 | 已具备的代码事实 | 当前不能据此声称的事实 |
|---|---|---|
| 三组件发布 | `release-catalog.ts` 的 `external_marketplace` 仅为 `craft-knowledge`、`craft-memory`、`craft-experience`；完整 `craft` 为内部 full surface。 | 第四个 codebase 插件已可对外安装。 |
| Host 激活可见性 | `ActivationProofKernel` 只接收 Hook 写出的 content-free proof；doctor 将“配置存在”和“真实执行”区分为 `not_observed`、`hook_not_trusted`、`mcp_not_reachable`、`executed`。 | Codex/Claude 已在真实会话里持续生成 Context Receipt、Memory 写入和 Experience Observation。 |
| 可信评测协议 | Engineering runner 约束固定 Case、五次 trial、临时副本、固定 args 数组、效果与 acceptance/sibling 检查。 | 完整 12 Case × baseline/profile × 5 的真实 Codex 试验已归档并足以让 Profile routeable。 |
| MCP 迁移 | `mcp-forward-compat.ts` 明确当前 2025-11-25 和 2026-07-28 的逐项未采用状态。 | 已实现 2026-07-28 或其 Tasks extension。 |
| 代码库智能 | `craft-codebase` 已是内部 Capability：显式 activate、checkpoint 绑定、content-free receipt、stale 拒绝、符号链接/路径逃逸拒绝、无 Context 自动注入。 | 已具备 LSP/SCIP 精度、全语言/跨仓支持或真实调用影响完整性。 |

这种“边界先于宣传”的做法值得保留。它符合 MCP 的 Host-Server 分工，也避免在未部署 sandbox、broker、scheduler 或 Adapter 时把本地对象模型包装成生产基础设施。

## 主要差距与设计建议

### P0：证明已有能力在真实 Host 中有效

#### P0.1 三组件和 Engineering Profile 的真实配对评测尚未构成发布证据

仓库已有 fixture、Host receipt、独立 Outcome、Eval Gate 和 Engineering runner 的结构。下一步不是再增一个 evaluator，而是让下列实验真实发生并归档：

| Subject | 最少真实 Case | 对照和关键指标 | blocker |
|---|---|---|---|
| Knowledge | 小型代码修复、文件型交付 | Evidence 覆盖、事实正确、过期来源拒答、陈旧知识误注入 | 伪造/缺失来源、事实回退、跨 scope 注入 |
| Memory | 当前偏好、历史问答、冲突替换、跨项目边界 | 偏好命中、冲突误注入、跨项目泄漏、过期事实继续注入 | 隔离失败、撤销/超时未生效 |
| Experience | 两类真实任务 | 终态达成、已知错误复发、无效重试、held-out 回归 | 无独立 Outcome/Evidence、成本或时延恶化 |
| Engineering Profile | 12 个冻结 shared-caller bug-fix Case | baseline/profile 各 5，确定性验收、两个 sibling assertion、成本/时延 | 任一越权 effect、无根因证据、验收或 sibling 失败 |

等预算、同模型、同 Host、同环境、同项目快照的完整配对是晋级门槛；缺配对的 trial 只能诊断。结果若不优于 baseline，保持 candidate/revalidation，不通过“多跑几次”掩盖失败。这个方向也与 OpenAI 的“代码库上下文 → 验证 → 修复”闭环一致，而非只比较自然语言质量。

#### P0.2 `craft-codebase` 要先获得“结构正确”证据，才考虑发布或自动路由

当前实现的优势是正确的安全形态：不存原文、只从 Workspace checkpoint 读取、source digest 漂移拒绝、输出可追溯、默认不注入 Context。

但其解析器是 `builtin-regex-static-v1`：声明、import 和 call 都通过正则抽取；同名函数、动态 dispatch、alias、re-export、注释/字符串、JS/TS 类型关系、生成代码、框架约定都会产生漏检或误判。因此应立即补充：

1. `analysis_coverage` / `unsupported_reason` / `diagnostics` 成为每个 query 的显式字段；不能只有命中的 node/edge。
2. `impact` 的产品文案和 tool schema 固定为 `static_candidate_impact`，并把 `provenance` 与 `confidence` 作为必读字段。
3. 增加 12–20 个小型 TS/JS fixture，包含 alias、同名、dynamic call、barrel export、循环依赖、测试调用者、注释伪命中、敏感/ignore 路径和 checkpoint drift；有 ground truth 的 relation 才可评 precision/recall。
4. `index_build` 绑定 allowlist、ignore-policy digest、最大文件数/大小和解析器 fingerprint；当前 checkpoint manifest 虽能固定输入，但没有显式的 index scope/ignore policy 事实，未来容易把依赖、生成物或敏感代码扩大到索引中。
5. 让 `craft doctor`（或专属 `codebase status`）说明：是否 activate、最新 index 的 checkpoint/snapshot、stale 原因、解析器、覆盖范围、诊断数、Adapter 健康与未支持语言；而不是只告诉用户“已安装”。

这些都是内置 regex capability 的收口工作，不增加依赖，也不要求引入数据库、watcher 或外部执行。

#### P0.3 观测必须贯通 Host → MCP → Craft receipt，而不仅是本地 Store 记录

Craft 已有 OTLP 映射与 trace/archive 对象，也已将 Context Receipt、Activation Proof 和决策指标纳入模型。P0 应做一条真实、无敏感正文的 trace 验证：从 Codex 或 Claude 的一个 Hook/MCP tool call 开始，贯通 Host session、MCP request、Task、Context Receipt、Effect/Acceptance、终态，确认每段相同 correlation/trace id 可查询。

这比先做可视化 Dashboard 更重要。MCP 2026-07-28 RC 已把 OTel 作为结构化 observability 的替代方向；Craft 应记录实际 exporter/collector 为 `configured_and_observed` 或 `unavailable`，绝不把内部 OTLP JSON 形状写成“已接入生产 OTel”。

#### P0.4 覆盖率结论必须由一次新鲜门禁运行给出

`tests/coverage-gates.json` 的受管组阈值均为 line/function/branch 100%，这是**门禁规则**，不是本次审查时的通过证据。工作区已有聚合 `coverage-final.json` 约为 line 99.80%、function 96.76%、branch 98.07%，且它不是 coverage-gate 的逐组结果、时间也不可由该文件证明为最新。因此目前不能回答“整个项目单元测试 100%”。

发布或对外声称前必须在当前 commit 执行 `pnpm run test:coverage-gates` 并保存所有组的输出；任何组失败都应按缺失分支补测或删除真正废弃分支，而不是靠 aggregate 覆盖率或旧 report 宣布通过。

### P1：把实验性结构能力与 Host 运行能力做成可替换 Adapter

#### P1.1 `craft-codebase` 的 Adapter 端口：独立存在，也可用 Serena/SCIP 增强

建议 Capability 内定义窄端口，而不把具体工具耦进 `CraftService`：

```text
CodebaseAnalyzerAdapter
  describe() -> analyzer id/version/language coverage/effects
  health(snapshot, policy) -> ready | unavailable | stale | failed + receipt
  build(snapshot, budget) -> revision + nodes/edges/diagnostics/provenance
```

内置 regex 只是一个 Adapter 实现。第二个先做**用户自行安装、显式授权的 Serena Adapter**：Craft 请求受限 symbol/reference/diagnostic 结果，并用当前 checkpoint 的 path/span/digest 复核后才写 Codebase receipt。Adapter 不可用则 `unavailable`，不静默降级为“精确引用”。

再后才评估 SCIP importer：SCIP 是很适合的交换格式，具备语言无关 schema、多语言 indexer 和 snapshot 测试路径，但其生成往往依赖编译器、语言环境或 build configuration；它应是显式 `local_write` index artifact 的来源，不是每次对话同步启动的后台进程。[SCIP README](https://github.com/scip-code/scip) 与其 [indexer 指南](https://github.com/sourcegraph/sourcegraph/blob/main/doc/code_navigation/explanations/writing_an_indexer.md) 都支持这一渐进路径。

`craft-codebase + Serena` 的角色分工应为：Craft 管 snapshot/scope/stale/receipt/context budget，Serena 提供 LSP 级结构精度。用户未装 Serena 时仍可使用内置能力，但 doctor 必须如实显示 `heuristic / partial`；用户直接调用 Serena 也完全可行。

#### P1.2 Context Compiler 需由“有输入分层”走向“效果可验证”

现有 capability matrix 已记录 constraint recall、漏召回、输入 token、错误注入、真实 cache 或 unavailable 的设计。P1 需要把该记录接到真实 Host paired trials：稳定前缀、Task/State、关键决策材料、按需 materialized codebase references 分层后，至少比较工具选择、参数确定、写入准确性、恢复、token、缓存事实、成本和时延。

特别注意：Provider/Host 未报告 cache 时只能记 `unavailable`，不能从“布局更稳定”推断“命中缓存”。`craft-codebase` 只应贡献小的 references；任何正文 materialization 都必须重新经过 Task/Policy/Workspace gate。

#### P1.3 Claude Host runner、Sandbox Broker 与恢复演练仍是 Adapter 任务

目前 Engineering Runner 的目标为受控 Codex 试验。P1 可按同一 Receipt 契约增加 Claude runner，但不要复制另一套 Evaluation domain。应该进行至少一次 crash/timeout/`effect_unknown` reconcile/handoff 演练，并连接一个真实 Sandbox/Credential Broker 或明确报告 `unavailable`。

这和 OpenAI 对本地 Codex sandbox 的原则相符：作用域、网络与写权限应由环境强制，而不是依赖 prompt 自律。[OpenAI 的 sandbox 说明](https://openai.com/index/building-codex-windows-sandbox/) 对“工作区写入、网络访问与子进程约束”作了具体阐述；Craft 只应记录和验证该部署事实，不能在自身 TS 对象内声称提供了 OS 隔离。

#### P1.4 Knowledge / Memory 的数据保鲜应继续独立演进

不要为做 Codebase Graph 而把 code、docs、memory 全部塞入同一个向量库。更高收益的 P1 是：

- Knowledge：从 source revision/fragment 生成原子 Claim、实体/关系去重、fragment 增量复用、来源 drift 的复核与被频繁引用但 stale 的告警；保持 Claim 的 Evidence 审核链。
- Memory：明确事实槽位和生命周期策略，例如 current residence 可 supersede、deadline 临期升权并过期、项目依赖由来源 revision drift 而非时间盲衰减；压缩只能生成派生摘要，不能抹掉事件链。
- Experience：Observation → Pattern → Procedure 的推广仍须独立 Eval/Shadow/Held-out/Signoff/Canary；Repository relation 只能作为 Evidence 输入，不能自动产生 Procedure。

### P2：在真实治理与产品证据之后再做的项目

1. **MCP 2026-07-28 完整迁移。** 当前 protocol 仍是 RC 且会改变生命周期；先完成 Host compatibility matrix、双版本 contract tests、extension negotiation 和互操作 smoke，再切换 speaking revision。不要以 `server/discover` 已实现推断完成迁移。
2. **跨机器/组织协作。** Bundle、冲突 Candidate、A2A/远程 MCP 的本地模型不是 device/principal identity、签名、tombstone 授权、ACL 和审计的替代品。没有这些适配器前继续限定在本地用户、项目和显式导入。
3. **持续索引与大图。** watcher、post-commit hook、Graph DB、embedding、跨仓联结和 LLM 架构导览都要先证明成本、泄漏边界、增量正确性和禁用/卸载行为。它们不能进入 P0 codebase capability。
4. **自动执行外部 effect。** Tracker、worktree、Draft PR、CI/branch protection、Forge merge 是各自的 Capability/Adapter 项目；Experience 只能优化 Procedure，不能自己得到外部授权。
5. **第四个独立外发产品。** `craft-codebase` 要先满足 standalone install/uninstall transaction、doctor、语言支持声明、index policy、隐私/许可证、Host integration、结构正确和真实 paired benefit；否则继续作为 full Craft 内部 capability。

## 明确不应做的事

- 不复制或内嵌 Serena、GitNexus 等第三方实现；采用外部 Adapter 或开放索引格式，先核对 pinned revision 的许可证与供应链。
- 不自动写 Codex/Claude 的 MCP 配置、AGENTS/CLAUDE 指令、Hook、watcher 或全局权限；安装和 Host trust 必须显式且留 proof。
- 不将 regex/AST/LLM 推断的 edge 当作运行时事实、漏洞确认或“全影响范围”；动态配置、反射、HTTP/MQ、feature flag 一律保留 unresolved/observed 分层。
- 不自动索引任意根目录、`node_modules`、构建输出、符号链接或敏感路径；不上传源码；不默认注入全仓代码或 RepoMap。
- 不新增一个“通用 graph database”或“第四认知内核”来解决局部代码导航问题。
- 不因为 API/协议存在就绕过 Host consent、Sandbox、Credential Broker、Acceptance 或 release policy。

## 建议的验收顺序

```text
P0 覆盖率门禁全绿 + 三组件 Hook 真运行 + 真实配对 trial archive
  -> P0 codebase 静态正确性/doctor/scope 证据
  -> P1 Serena Adapter 或 SCIP importer 的受控 PoC
  -> P1 Context Compiler 和 Claude runner 效果对照
  -> P2 MCP/identity/automation/外发产品决策
```

只有每一级同时满足机制、fixture、conformance、真实 Host 与业务效果证据，才应将结果从 `candidate` 提升。该顺序保持 Craft 是通用 Agent：代码库理解只是按任务激活的只读 capability，不会重塑 Knowledge/Memory/Experience 或默认取得执行权。

## 参考（一手资料）

- [MCP Architecture, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/architecture)
- [MCP 2026-07-28 release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [OpenAI: Codex Security](https://openai.com/index/codex-security-now-in-research-preview/)
- [OpenAI: Introducing upgrades to Codex](https://openai.com/index/introducing-upgrades-to-codex/)
- [OpenAI: Codex sandbox on Windows](https://openai.com/index/building-codex-windows-sandbox/)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
- [Serena official MCP Registry source](https://github.com/mcp/oraios/serena)
- [SCIP official repository](https://github.com/scip-code/scip)
- [Sourcegraph: writing a SCIP indexer](https://github.com/sourcegraph/sourcegraph/blob/main/doc/code_navigation/explanations/writing_an_indexer.md)
