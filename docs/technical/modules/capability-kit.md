# Capability 与领域 Kit

## 职责

Capability Catalog 发现、索引和按需读取 Skill 等能力资产。v0.11.13 增加首个可执行 Domain Kit Kernel；v0.11.14 将它扩展为宿主无关组合契约；v0.11.15 补齐递归依赖锁与预算闭环；v0.11.16 验证跨领域确定性验收；v0.11.17 将 Domain Action 与已验证、已发布的动态 Contract 融合；v0.11.18 补齐类型化输入、精确授权和证据化结果闭环；v0.11.20 增加逻辑能力索引。

## 关系

- 被 Agent IR 引用，提供可用 Operation 与约束。
- 被 Workflow 装配，提供实际步骤和验证器。
- 被 Experience/Eval 以精确版本作为评测 Subject。
- 由 Runtime Adapter 转成宿主可理解的 Skill、MCP Tool 或 Plugin。

## 边界

v0.9.9 的本地 Capability Asset Registry 已可登记 Skill、MCP Server/Tool、Workflow、Adapter、Validator、Grader 和 Eval Suite 的来源摘要、版本、依赖、信任、health、effect、凭据要求与成本提示。`Activation Profile` 只选择健康且 trusted/verified、权限匹配且不需要未配置凭据的最小集合；`Tool Selection Receipt` 记录候选、过滤理由、Profile 精确版本和授权边界。

发现、激活、授权、调用是四件不同的事：Craft 不替 Host 修改 MCP 配置；调用必须消费绑定 Profile 且会过期的 `call_id`。v0.11.52 的 Capability Connector 进一步统一内置、用户批准的 Skill 来源和 MCP 元数据，并以 Profile/来源摘要绑定的 ticket 交给 Host；它不保存第三方凭据、自动安装依赖或在后台拉取内容。详见 [Capability Connector](capability-connectors.md)。v0.9.4 的可选向量检索只负责候选召回，不能承担权限或质量判断。

## 领域扩展与普通用户体验（目标）

Kit 不仅打包 Skill，也定义工作对象 Schema、编辑/预览组件、动作契约、交付格式、验证与评测及示例。视频提供人物/镜头/时间线，销售提供客户/商机/行动，教育提供课程/练习/反馈；它们共享状态、版本、权限、执行与评测内核。

用户从目标和资料开始，按需连接应用并检查可访问范围；不必先选模型、配置 MCP 或手工搭建 Workflow。现成模板、用户自建与使用中提炼的候选并存。检索只返回少量适用候选、解释选择依据，加载与执行授权仍分别检查。

v0.11.13 的 Workbench 会从 Kit 字段即时装配文本、路径、整数、布尔和选项控件，再将表单值绑定到一个现有 Work Launch。首批研发与视频 Kit 共享 Acceptance Plan、租约 Job 和 Evidence 协议；文件条件自动进入内置确定性 Worker，人工条件仍由人明确确认。Kit ID、版本和值摘要共同形成幂等应用记录，内置 Kit 被同名漂移内容占用时失败关闭。

v0.11.14 的 Capability Requirement 固定资产版本、最低信任和副作用；应用时重新读取精确版本，只接受 healthy 且 trusted/verified 的匹配资产。Evaluation Suite 同样固定版本。Sandbox Requirement 不把声明当保证：调用方必须提供 verified Profile，Craft 运行兼容性规划并签发摘要绑定 Ticket。Object Schema 与 Component 为未来 Canvas 提供声明元数据；组件只允许 form、artifact preview、checklist 和 status，不携带脚本。Action Contract 明确副作用和审批要求。

v0.11.15 会递归解析能力依赖；每条依赖必须是精确的 `asset@version`，所有传递资产都重新检查健康、信任与副作用，浮动版本、循环依赖及隐藏越权均失败关闭。解析结果、Kit 摘要、评测集、沙箱 Profile 与预算绑定写入不可变 `Domain Kit Lock`。有 Budget Limit 的 Kit 必须提供归属于当前 Work Launch Task 的 Budget Account；Craft 预留声明额度，并通过 `craft_domain_kit_settle` 接受调用方报告的实际资源消耗，幂等结算和释放余量。沙箱先 dry-run 检查兼容性，预算预留后才签发正式 Ticket。

能力动作的长期契约还需继续补齐前后置条件、细粒度读写范围、类型化结果、可模拟性、幂等/补偿及验证器；这些字段将同时服务 UI、规划、沙箱和编译。当前动态 UI 只生成安全表单，不生成任意可执行组件；远程 Hub、自动依赖安装、Kit 签名发布和完整领域 Canvas 仍未实现。预算实际消耗由可信执行端上报，Craft 不根据文本或模型回答猜测用量；依赖锁也不等同于包管理器或自动下载器。

v0.11.16 的 `coverage_report` Evaluator 解析 Istanbul/nyc 总计指标并执行显式阈值，`media_probe` Evaluator 解析 ffprobe JSON 并检查技术约束。两者只消费工作空间内受限大小的普通 JSON 文件，不跟随链接，不执行报告中的内容。内置维护 Worker 会分别领取三个 Adapter 的 Job，避免一种检查器冒充另一种检查器。报告的产生仍属于 Host/工具职责；Craft 当前没有捆绑测试框架或 ffprobe，也不会把技术格式通过误称为业务质量通过。

v0.11.17 的 Action 可携带精确 `contract_ref`，其中同时固定 Contract 与其独立 Publication 生成的 Capability Asset 版本。应用时重新检查完整晋级链、Publication 状态、Kit 依赖锁、资产健康/信任及副作用一致性，并生成独立 Action Lock。动作准备固定 Application、Action、Contract、Capability 和输入摘要，保存审批、幂等、补偿及凭据句柄要求，但始终返回 `execution_authority=false`。它是 UI/规划器到 Autonomy/Host 的安全交接点，不是绕过现有执行网关的新调用通道。

v0.11.18 不再允许 MCP 调用方只声明一个未经 Craft 校验的输入摘要。输入仅在调用期间存在，经过 Action Lock 中的有界 JSON Schema 子集校验后生成摘要；未知关键字、错误类型、越界值和过深结构都会失败关闭。副作用被确定性映射为 Autonomy Action，并绑定 Task、Target、Policy 版本和调用者。授权必须被准确消费一次，报告成功时输出需通过同一锁中的输出 Schema，同时至少关联一条真实 Evidence；失败报告也形成明确终态。数据库不保存原始输入或输出。该内核不实现完整 JSON Schema Draft，也不自动执行 Contract；Host Adapter 的选择、派发和远端 Receipt 仍是下一阶段的独立边界。

v0.11.20 将“扫描到的文件”和“模型应看到的能力”分开。`source` 是可配置优先级的 Source Mount；`capability` 是一次来源观察；相同内容摘要生成一个 `logical_capability`，其中保留实例列表和按优先级选中的实例。相同声明身份（`capability_id`、`id` 或名称）出现多份不同内容时生成 `capability_conflict`，供用户或后续 Policy 显式解决。禁用 Mount 只取消其索引参与，不删除本地文件；重新启用会重建逻辑投影。当前逻辑能力尚未和 Activation Profile、Capability Asset 发布链统一，也不会自动安装、加载或调用任何 Skill。

关联：[Agent IR](agent-ir.md) · [Experience/Eval](experience-eval.md) · [Runtime 接入](runtime-integration.md) · [上下文与记忆](context-memory.md)
