# Experience：多入口研发流程与子流程组合

调研日期：2026-09-27。范围：Experience 的领域模型与接入契约；本文是设计依据，不是实现完成或真实 Host 验收证明。

## 结论与边界

**设计判断**：粗粒度、入口数量、出口数量、子流程复用、执行拓扑是不同维度。用户提出的“大研发流程，既支持完整需求开发，也支持仅 Code Review”适合用一个 Procedure 暴露多个有契约的入口，并组合可复用 Procedure。入口选定后如果路径仍是有序步骤，就仍可使用 Workflow。只有运行过程中需要条件路由、并行汇合、回环或补偿，才需要 Graph 控制流。数学上都能画成图，不代表产品必须暴露任意 Graph 或新增执行器。

## 官方事实

1. **入口表达启动原因。** Camunda 允许用多个 Message Start Event 区分不同启动事件；默认 None Start Event 最多一个。这支持“明确选择入口”，不等于允许调用者从任意内部步骤跳入。[Camunda：Routing events to processes](https://docs.camunda.io/docs/components/best-practices/development/routing-events-to-processes/)

2. **路径终止与整体完成不同。** Camunda 允许多个 None End Event；到达一个只结束当前路径，所有活动路径结束后实例才完成。因此“审查报告完成”与“需求交付完成”应有不同终态契约，不能共用一个含糊的 done。[Camunda：None events](https://docs.camunda.io/docs/components/modeler/bpmn/none-events/)

3. **复用需要独立接口和绑定语义。** Camunda Call Activity 调用外部化流程，子流程完成后父流程继续；支持显式输入、输出映射。绑定可选 latest、deployment、versionTag，其中 versionTag 仍选择该标签下最新部署版本，并非不可变精确版本。其子流程调用从 None Start Event 开始，其他启动事件不会被自动沿用。[Camunda：Call activities](https://docs.camunda.io/docs/components/modeler/bpmn/call-activities/)

4. **组合需要控制状态传播。** LangGraph 子图可作为父图节点；共享状态键时可直接组合，状态结构不同时由包装节点映射输入输出。其按调用隔离模式每次启动新内部状态，并在该次调用中复用父检查点机制。[LangGraph：Subgraphs](https://docs.langchain.com/oss/python/langgraph/use-subgraphs)

## 对 Craft 的设计推断

以下均为本项目设计推断，不是上述产品替 Craft 提供的安全或执行保证。

| 概念 | 建议语义 | 必须守住的边界 |
| --- | --- | --- |
| Procedure | 可评测、版本化、晋级的复用过程资产 | 延续现有 Workflow / Graph / Prompt 类型与 routeable 门禁 |
| Entry | 某种任务意图的合法开始契约 | 命名入口、必需输入、前置条件、允许出口；未知或缺失输入明确拒绝 |
| Exit | 某个交付范围的完成契约 | 必需产物与验收引用；选择目标出口不等于已经通过验收 |
| Subprocedure Call | 有界调用另一个过程的指定入口 | 精确 id + version + digest，显式输入输出，不隐式加载全局上下文 |
| Plan | 选定入口、出口后得到的有界步骤计划 | 保留根与子调用来源；不能因为编译成功自动获得执行权 |

先沿用现有 Procedure Module 和 Interface，加深“校验并解析为计划”的 Implementation。输入映射、循环检测、依赖校验藏在这一个 Seam 后面，避免向每个 Host Adapter 泄露遍历细节。`CONTEXT.md` 已规定 Graph Compilation 降低为 Verified Work Loop Plan、不得拥有第二套 Runtime；新组合能力应保持这一边界。[本地领域词汇](../../CONTEXT.md)

子流程绑定比 versionTag 更严格：使用 Craft 已有定义版本与摘要，不自动漂移到 latest。每次解析检查依赖的当前可路由状态；内容锁定不能绕过撤销。父子范围兼容、子 effect 不得扩大父允许集合；拒绝递归环，限制深度与展开规模。上述措施不等同于新增团队 ACL，仍须遵守现有 Scope Envelope 和运行时授权。

## 两条实际使用路径

| 用户意图 | 入口材料 | 组合路径 | 目标出口 |
| --- | --- | --- | --- |
| 完整需求开发 | requirement_ref、验收条件、workspace_ref | 澄清 → 设计 → 实现 → 验证 → 调用固定版本审查过程 → 交付 | delivery_ready：实现、测试与审查结果满足验收；不隐含合并或上线 |
| 仅 Code Review | diff_ref、base/head revision、review_scope | 只进入审查过程的 review 入口 | review_complete：审查报告已产生；有 findings 也可完成审查，不等于代码获准发布 |

“进入审查”必须能提供审查所需材料，不应要求伪造已执行需求设计，也不能跳过审查自身必需条件。缺输入属于不可开始；执行失败、依赖撤销、验收不通过属于不同状态，不能用任意目标出口将其转换为成功。

## 建议验收

- 相同 Procedure 的完整开发与仅审查入口生成不同、有界的计划；只包含实际选中步骤及子调用。
- 未知入口/出口、重复标识、缺输入、输入输出映射不完整、不可达目标均明确拒绝。
- 子流程版本或摘要漂移、撤销、跨范围、不允许 effect、递归环及超限展开均失败关闭。
- 终态声明保留验收和 Evidence 要求；计划生成不伪造 Outcome。
- 旧单入口线性 Procedure 保持兼容；Graph 继续走已有编译及执行边界。
- Skill + MCP 能表达选择入口、查看缺失材料、获取计划和验收结果；Hook 只承担可选生命周期辅助。

本文不建议本轮引入 BPMN/XML、通用表达式语言、任意动态跳转、新的调度器或可视化编辑器；这些都不是两条目标路径成立的前提。
