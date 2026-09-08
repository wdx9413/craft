# Craft 产品概览

## 目录

- 一句话与用户问题
- 产品闭环与差异点
- 适配方式与当前边界

## 一句话

Craft 把用户目标转成可移植、可验证、可复用的 Agent 工作资产，让不同模型和 Agent 不再只产生一次性结果。

## 用户问题

- 能力很多，但不应全部加载进上下文，也很难判断该选哪个。
- 长任务跨会话、跨模型后丢失状态、决策和失败原因。
- Agent 说“完成”不等于结果经过程序、专家或真实环境验证。
- 成功经验常被埋在对话里，无法版本化、回放、比较和回滚。

## 产品闭环

```text
能力发现与管理 → 任务匹配 → 组合执行 → 状态/产物/证据
          → 验证与评测 → 受控晋级 → 跨任务复用
```

Craft 不替代 Codex、Claude 或其他模型；它们可以作为执行宿主。Craft 保留能力目录、任务状态、执行谱系、验证结论和用户积累的经验。

## 差异点

短期差异是本地能力发现、跨会话任务、证据、确定性 Workflow 和跨宿主接入的统一。长期差异不是“自动改提示词”，而是四项可以共同形成基础层的能力：

1. `Agent IR`：与宿主无关的目标、约束、执行图和验证语义。
2. `Capability Design Kit`：领域能力、Schema、Validator、Policy 和 Eval 的组合包。
3. `Verification Signoff`：明确区分程序证明、模型判断、人工审批和真实业务结果。
4. `Agent Digital Thread`：从目标到 Trial、Trace、Artifact、Evidence、Outcome 和版本晋级的完整链路。

## 适配方式

研发、视频、销售、教育和内容创作共用 Task、Capability、Workflow、Trial、Trace、Outcome 与 Signoff；领域差异由 Kit 中的能力、产物结构、验证器和策略表达。

## 当前边界

当前版本已实现核心/完整双 MCP 面、Capability Asset Registry、持久 Task/Evidence、确定性 Workflow、可续接的默认安全路线、受限 `diagnostic_research` Expert、Experience/Eval Kernel、多来源 Grader/Signoff，以及同评测集版本的聚合对比。v0.9.9 增加最小 Activation Profile、profile-bound 调用回执、最多五个只读 Sub-agent、配对可靠性检验、Judge 校准、Signoff 后 Canary 与精确回滚；v0.9.10 把显式文件根、不可变 Checkpoint、摘要差异和人工打断做成共享 Workspace 状态源；v0.9.11 增加本地写事务和受 Signoff 约束的静态脚本候选；v0.9.12 把 verified 脚本绑定到 prepared Transaction 并生成精确 Host 回执链。本地生成代码写入按平台隔离，读/规划不强制沙箱。真实容器或 Windows 隔离 Adapter、外部短期凭据 Broker、模型 Grader 自动执行、真实业务金标、远程 Hub/A2A 与桌面端仍是后续方向。

## 形成行业基础层的条件

Craft 只有在 Agent IR、领域 Kit 或跨宿主 Digital Thread 至少一项成为可复用接口，并能稳定降低人工修正、恢复时间和回归率时，才可能推动行业变化；功能数量或“自进化”叙事本身不是壁垒。
