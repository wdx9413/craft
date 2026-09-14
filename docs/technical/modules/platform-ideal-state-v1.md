# Platform Ideal State v1（v0.12.21）

## 目标

v0.12.21 将 Craft 的产品承诺收敛为一条可验证主链：**模型负责理解、提议与求证；Craft 负责事实、边界、恢复、验收和受限演进；Host 负责真实执行。**

```text
定义 → 准备 → 行动 → 交付 → 学习
```

1. **定义**：目标、约束、缺失条件和成功标准。
2. **准备**：读取事实状态，最小激活能力，检查权限、环境和预算。
3. **行动**：模型提议，Policy 决策，Host 执行，生成 Receipt，再观察真实状态。
4. **交付**：Acceptance 验收真实状态，生成 Outcome 或 Checkpoint。
5. **学习**：记录 Trace 与指标，生成受限 Candidate，经过 Shadow、重复评测、Signoff、Canary 后才可晋级，并可精确回滚。

`VerifiedWorkLoop` 是对外唯一的工作控制门面。Work Launch、Task Run、Execution Fabric、Acceptance、State Workspace 等仍是内部深模块，不能作为平行的公开主入口绕过主链。MCP 已停止发布这些历史阶段级入口；历史数据不迁移、不重写。

## 受限自主而非强制人工

默认模式是 `bounded_autonomous`。不确定时，系统可依据分层 `UncertaintyPolicy` 选择继续求证、保持不变、拒绝、放弃或请求人工判断；人工不是每次演进的必经步骤。

策略按以下顺序叠加：

```text
Core Safety Floor → Global → Project → Task → Case
```

较窄作用域只能调整阈值和求证策略，不能削弱 Core Safety Floor。自动升级只允许增加求证强度：确定性检查、已批准模型、独立评估器、授权上下文、只读 Expert 或额外 Trial；它不会扩大写入范围、数据范围、凭据、effect 或自治权限。`UncertaintyResolution` 永远不授予执行权。

人工裁决只适用于可裁决状态，必须绑定 confirmed/bounded Evidence，并保留相互冲突的证据。人工同样不能覆盖 Core Safety Floor。

## Reference Pilot 与发布资格

机制正确不等于业务价值成立。v0.12.21 固定两个无正文 Reference Pilot：

- `development`：Codex 控制台模式下的脱敏研发任务；
- `file_delivery`：通用文件型交付包，不把 AI 视频写进核心领域模型，视频只可作为某个 Case 的配置。

每个 Pilot 固定同环境、同预算的 5 次 baseline 和 5 次 candidate 配对 Trial。结果必须绑定 confirmed/bounded Evidence，并同时检查机制、主指标与安全/质量 guardrail：

- `eligible`：候选达到效果阈值且至少 3 个配对获胜；
- `rejected`：机制或 guardrail 失败，或总体回归；
- `inconclusive`：样本、可比性或效果不足，不能冒充提升。

平台 v1 的发布判断要求研发 Pilot 为 `eligible`，文件交付 Pilot 至少不是 `rejected`，且两者机制均通过。内置测试只证明机制；真实 Codex 运行与盲评必须由外部 Host/评审产生，Craft 不伪造业务提升。

## 数据与安全边界

- Caller 持有原始 Prompt、文件正文和业务数据；Craft 只保存摘要、版本、Artifact/Evidence 引用和无正文回执。
- 高质量外部 Workflow 只能先成为候选；本地评测通过后才能进入 Canary 或路由。
- 模型可以慢慢积累高置信经验，但不能直接改写全局 Prompt、Skill、Workflow 或默认拓扑。
- `autonomous` 模式仍受 Safety Floor、预算、effect、数据与凭据边界约束；它不是无限自治。

## 当前边界

本版实现了策略、回执、Reference Pilot 计划与资格判定，并收口 MCP 公共入口。真实业务 Case 的长期维护、真实 Codex 5×2 运行和人工盲评仍属于部署与运营工作；没有这些证据时只能声明机制通过，不能声明业务价值已经证明。
