# Craft 能力架构映射

本文把产品结果、入口、逻辑能力、基础设施、三仓代码和评测证据放到同一张图中。它描述当前代码与已知边界，不代表所有入口已交付，也不把合成评测当成真实用户效果。

## 一句话架构

```text
CLI / Desktop / IDE / Cloud / Mobile / DC 小助手
                    │ 薄适配；入口状态分别标注
                    ▼
          业务结果组织的能力平面
    效率更快 │ 质量更高 │ 安全可度量
                    │
                    ▼
      Control · Context · Capability · Execution · Trust
                    │
                    ▼
      Agent 引擎 · Runtime · Model Gateway
                    │
                    ▼
     用户配置模型 / Host / 外部服务 / 合规与采购
```

图中的入口、五个逻辑平面和三层基础设施是不同维度：入口回答“从哪里使用”，能力平面回答“给用户带来什么结果”，五平面回答“由谁承担职责”，三层基座回答“谁组织 Agent、在哪执行、使用什么模型”。五平面是逻辑职责，不要求独立进程。

## 北极星与业务结果

北极星：成为用户最信赖、最喜欢的统一 AI 工作工具。Craft 当前的产品重点是本机优先的个人助手与技术工作流；“统一 AI Coding 工具”是面向编码场景的愿景表达，不代表已有六端产品或组织级采购能力。

| 能力支柱 | 用户结果 | 能力例子 | 可度量信号（需注明来源） |
|---|---|---|---|
| 效率更快 | 少交代、少等待、少重复操作 | 会话与任务续接、产物管理、长任务、流程与编排、提醒、执行轨迹 | 完成耗时、人工介入次数、恢复耗时、重复任务背景补充量、Token/模型费用 |
| 质量更高 | 结果更准确、可修改、可复用 | 来源与证据、验收、版本差异、知识与记忆、工作流、经验候选 | 验收通过率、返工量、来源覆盖、重复任务质量变化、用户修改保留率 |
| 安全可度量 | 用户知道系统做了什么、依据什么、花了多少 | 权限规则、审批、PII 检查、仓库准入、Trace、预算和成本回执 | 越权拒绝/误放行、预算偏差、敏感泄漏、审计完整率、撤销成功率 |

指标是目标与观测口径，不等于当前已具备完整业务数据。出码率、SDD 覆盖等只适用于明确的编码场景，应由可复核的业务定义和数据源支撑。

## 入口目录与状态

入口适配必须调用共享服务/API 或协议，不复制任务状态、权限判定、证据账本和评测晋级规则。状态仅在本次盘点能由仓库结构和配置确认的范围内标注；“候选”不是路线承诺。

| 入口 | 效率：状态与证据边界 | 质量：状态与证据边界 | 安全：状态与证据边界 |
|---|---|---|---|
| CLI | 机制已实现：任务续接、运行恢复；代码与契约测试只证明机制，不证明耗时或重复输入减少 | 机制已实现：验收、产物与来源呈现；测试不证明独立验收质量或返工下降 | 机制已实现：策略拒绝、审批及审计入口；测试不证明真实 Host 的越权效果或泄漏率 |
| Desktop | 部分实现：桌面壳和固定版本管理；尚无真实安装包效率数据 | 部分实现：任务状态、产物与差异呈现；桌面壳测试不证明用户修改保留或结果质量 | 部分实现：审批界面及通知流程；签名安装、Gatekeeper 和真实系统通知尚未验收 |
| IDE / Host 插件 | 适配已存在、依宿主而异：能否减少上下文补充和等待尚无独立测量 | 适配已存在、依宿主而异：报告与验收回执不证明真实 Host 输出质量 | 适配已存在、依宿主而异：本地策略与回执机制不证明宿主隔离或实际效果 |
| Cloud | 候选：无已部署入口或效率证据 | 候选：无已部署入口或质量证据 | 候选：身份、租户、凭据、隔离、数据驻留与运维责任未定义 |
| Mobile | 候选：无已部署入口或效率证据 | 候选：无已部署入口或质量证据 | 候选：设备身份、离线授权、密钥与通知回执未定义 |
| DC 小助手 | 候选：无已部署入口或效率证据 | 候选：无已部署入口或质量证据 | 候选：企业身份、授权会话、消息审计和离线语义未验收 |

此表逐入口标注三项业务支柱的当前状态及证据边界。代码、模拟 Host、HTTP mock 和测试通过只表示相应机制或夹具结果；没有独立基线和真实用户结果时，不据此声称效率、质量或安全业务收益。Cloud、Mobile、DC 小助手仍为候选，不计为已交付。

## 三仓职责与权威边界

| 仓库 | 架构职责 | 权威数据 / 禁止事项 | 主要证据 |
|---|---|---|---|
| `craft` | 内核、领域服务、Policy/权限、Task/Run、Runtime 接口、MCP/Workbench HTTP 服务、模型与 Host 适配 | 拥有任务与策略的权威状态；Workbench 不应直接写 Store；模型输出不是执行回执 | `core/application/craft-service.ts`、`core/interfaces/workbench-server.ts`、`core/mcp/`；`audit:layering`、`audit:surfaces`、类型检查和内核测试 |
| `craft-workbench` | Web/桌面交互、用户确认、状态投影、视觉呈现和桌面壳 | 不复制内核业务规则；权限变更和任务决策须调用 Craft API；UI 状态不是权威审批状态 | [应用入口](https://github.com/wdx9413/craft-workbench/blob/main/workbench/app.js)、[审批界面](https://github.com/wdx9413/craft-workbench/blob/main/workbench/approval-ui.js)、[审批通知](https://github.com/wdx9413/craft-workbench/blob/main/workbench/approval-notifications.js)；前端测试、覆盖率门槛、`build:runtime` |
| `craft-eval` | 独立 Suite/Case 执行、证据采集、判分与比较 | 不成为 Craft 在线路由或权限来源；被测方自报轨迹不能替代评测器观测；合成场景不能证明真实 Host/用户效果 | [评测执行](https://github.com/wdx9413/craft-eval/blob/main/src/evaluation.ts)、[真实场景 Suite 生成器](https://github.com/wdx9413/craft-eval/blob/main/examples/real-world/craft-eval/build-suite.mjs)；Suite 测试、独立运行回执和报告 |

Workbench 可持有界面偏好和短期视图状态，但 Task、Run、Launch、授权决定和 Receipt 的正式写入应归 Craft。Eval 产出的报告可作为评审输入；是否进入 `business_eligible` 或 `routeable` 仍由 Craft 的受控晋级机制绑定精确版本和签收证据。

### 生命周期写入与恢复证据

| 路径 | 权威入口与约束 | 已验证边界 |
|---|---|---|
| Task Run 重试 | [Craft 服务](../../core/application/craft-service.ts)的 `taskRunRetry` 在事务内绑定原 Run、Launch、Host 版本和新 Run 标识；重复请求必须匹配原摘要 | [Task Run 契约测试](../../tests/task-run.test.ts)经 Workbench HTTP 与 MCP 验证旧版本拒绝、同请求回执重放及执行次数；重放回执本身不证明 Host 已开始 |
| 启动或审批结果未知 | [Task Run 状态](../../core/task-run.ts)列出未关联的 Host Run，`taskRunReconcileHost` 核对版本后关联；批准决定先持久占用，再启动 Host | 测试覆盖进程重开后的未关联运行、版本冲突与恢复；占用后尚无 Host 时可用当前版本取消 Task Run，阻止后续启动。取消不声称撤销已经发生的外部效果 |
| 展示与产物 | [Workbench 服务接口](../../core/interfaces/workbench-server.ts)返回 Craft 的 Task、Launch 和产物投影；UI 仅提交动作 | [服务接口测试](../../tests/workbench-server.test.ts)覆盖审批版本和读取同一 Launch；不能由界面缓存或 Eval 报告代替权威回执 |

上述测试包括模拟 Host 和受控夹具；不证明真实 Host、业务准入或发布验收。不同进程争用、写入与执行之间的中断仍应通过状态与回执核对，不能根据一次 HTTP 失败直接重试外部效果。

## 两套分层的映射

| 逻辑平面 | 职责和主要代码 | 三仓关系 |
|---|---|---|
| Control | 任务、运行及状态变化：[Task Run](../../core/task-run.ts)、[Craft 服务](../../core/application/craft-service.ts) | Craft 决定并写入；Workbench 通过服务操作并投影；Eval 观察结果 |
| Context | 按范围解析可用上下文：[Context resolution](../../core/context-resolution.ts) | Craft 解析；Workbench 展示；Eval 独立评估选取与遗漏 |
| Capability | 版本化能力与经验入口：[Experience capability](../../capability/craft-experience/capability.ts) | Craft 管理能力和门禁；Workbench 展示；Eval 提供评测证据 |
| Execution | 调度并观察 Host：[Host Run](../../core/host-run.ts) | Craft 管理执行和回执；Workbench 发起受控动作；Eval 测试执行行为 |
| Trust | 执行策略与事件：[执行策略](../../core/execution-policy.ts)、[Trace](../../core/trace-kernel.ts) | Craft 执行策略并记录事实；Workbench 展示批准；Eval 检查约束，不授予权限 |

| 基础设施层 | 主要回答 | 对应逻辑平面 | 当前代码锚点 |
|---|---|---|---|
| Agent 引擎 | 谁组织模型、上下文、工具和下一步 | Control、Context、Capability、Trust | Craft application services、Context resolution、Capability activation、Host adapters |
| Runtime | 在哪里执行、如何续接与观察 | Execution，并由 Control/Trust 约束 | Task/Run/Lease/Checkpoint、Workspace/Host adapters、Receipt/Observer |
| Model Gateway | 使用哪个模型、凭据从哪里来、如何记录成本 | Control、Execution、Trust | Provider/model gateway、dispatch 与 usage/cost receipt |

外部依赖包括用户配置的模型供应商与网关、外部 Host、操作系统能力、身份/合规服务和采购运营。接口可替换不代表供应商已经接入或通过准入。模型路由、自动降本和 Cloud 隔离在缺少部署与业务证据时应列为待验证项。

## 能力状态与证据门槛

用户界面可用简单状态“已实现 / 开发中 / 规划中”；架构清单必须附上证据等级，禁止状态跳级：

```text
mechanism_passed → fixture_passed → conformance_passed
                 → integration_passed → host_verified
                 → business_eligible → routeable
```

- `mechanism_passed`：输入、权限、版本、摘要和失败关闭契约正确。
- `fixture_passed`：确定性边界、冲突、恢复等夹具通过。
- `conformance_passed`：执行隔离、网络、凭据、资源和清理证据符合契约。
- `integration_passed`：Policy、Trace、Receipt、State 与验收链条一致。
- `host_verified`：真实 Host/平台运行证据验证端到端行为。
- `business_eligible`：固定业务集上证明质量、成本或耗时有净收益。
- `routeable`：独立留出评测、Signoff、Canary 和回滚均通过。

单测、代码覆盖率、合成 Host、HTTP mock、一次成功或安装脚本自测都不能单独证明真实用户效果。每份架构能力记录至少关联实现锚点、接口契约、Eval Suite、当前最高证据级别、最近运行结果及未覆盖的验收条件。

## 评测闭环与可度量横切面

```text
用户目标 → Craft 规划/授权 → Host/Runtime 执行 → Artifact/Receipt
     ↑                                              ↓
     └── 经独立评测、人工签收、灰度与可回滚的能力候选 ← Eval
```

Trace、成本、延迟、权限结果与用户修改横切所有能力支柱，不是第四个平行业务模块。Eval 记录的 Case、Suite、模型/Host/环境版本和预算必须与结果绑定；评测分数不得直接写成用户业务收益，自动改进也不得绕过 Signoff/Canary。

可比较指标的分母、排除规则、独立观察和隐私边界见[业务结果指标合同](outcome-metrics.zh-CN.md)。这份合同是候选口径，不是已经采集到业务效果的证据。

## 后续改造清单

按依赖顺序推进；本清单不表示已排期或已实施。

### P0：让三仓契约可追踪

- 建立机器可读的跨仓 Runtime 协议版本与兼容矩阵：Craft 发布协议/包摘要，Workbench 消费固定包并检查兼容，Eval 将协议与 Subject/Run 证据绑定。
- 为关键写操作定义权威写入者、幂等键、版本前置条件、未知结果恢复和回执来源；先覆盖 Task/Run/Launch/Approval/Artifact。
- 增加架构映射审计：检查文档中的接口/模块锚点仍存在，评测入口仍可定位；避免复制全仓文件清单。
- 逐项核实 Workbench 项目状态和审批是否仅投影 Craft 权威事实；凡有本地决策或双写，先加契约测试，再收敛到单一写入者。

### P1：把业务结果接入评测

- 为“效率更快、质量更高、安全可度量”各建立最小指标定义、分母/排除条件、来源和数据保留规则。
- 让真实 Host、安装包和系统通知拥有独立验收 Case；合成夹具继续用于确定性回归，不替代平台验收。
- 将用户修改、撤销、审批和恢复结果以最小化的来源回执传入 Eval；默认不回传原文或密钥。

### P2：只在测量支持时演进基座

- 先基准测量模型路由、Token/费用、延迟和任务质量，再决定是否启用自动路由或降本策略。
- Cloud、Mobile、DC 小助手分别完成身份、密钥、隔离、离线和运维设计后，才进入对应适配器实现。
- 仅当并发、数据量或恢复时间出现可复现瓶颈时，评估替换存储、队列或运行时；不预先引入新的 Agent 框架或独立服务。

## 本轮范围与非目标

本轮交付是架构映射与后续改造清单。当前三仓已有分层与 MCP 能力面审计，因此在没有发现契约违规前，不新增重复审计器、不重排 Core、不改公共 API，也不把候选入口实现成产品承诺。后续代码改动应由 P0/P1 中一项明确验收条件驱动，并继续遵守三仓单向依赖与 100% 增量覆盖要求。

## 相关文档

- [产品架构与三大支柱](architecture.zh-CN.md)
- [技术架构总览](../architecture.zh-CN.md)
- [三仓实施与验收清单](../technical/modules/three-repository-delivery.md)
- [当前能力矩阵](../technical/current-capability-matrix.md)
- [评测合同与能力晋级门槛](../technical/modules/assured-pilot.md)
- 可审计的实现入口：[Craft 服务](../../core/application/craft-service.ts)、[Workbench 服务](../../core/interfaces/workbench-server.ts)、[Task Run](../../core/task-run.ts)、[模型网关](../../core/model-gateway.ts)、[内置评测入口](../../capability/craft-eval/suite.ts)。文档链接审计检查这些声明路径是否仍存在；它不能证明运行行为或跨仓验收。
- 在三仓并列检出时运行 `pnpm run audit:architecture-integration`，检查本文声明的 Workbench 和 Eval 本地路径；缺少仓库或文件会失败，但本地检查不确认远端版本或仓库身份。独立[集成工作流](../../.github/workflows/capability-architecture.yml)检出指定三仓并记录提交，再执行同一检查；单仓文档审计不检查网络链接或假定兄弟仓存在。
