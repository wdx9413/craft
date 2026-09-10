# 控制面安全、资源与长任务护栏

本页把容易散落在 UI、Runtime、Memory 和 Adapter 中的横向规则放到同一控制面。内核规则的描述以 v0.10.2 为基线，其后版本在此之上叠加了供应链、注意力与工作台投影等能力，未改变本页的护栏语义；下文明确区分现有内核与目标 Adapter。

## 状态变更与并发

v0.10.0 使用 Workspace `state_revision` 阻止旧结果覆盖新状态。v0.10.1 新增追加式 `ChangeSet / ActionPatch`：记录基线修订、目标对象精确版本、JSON Pointer 字段、作者和意图。提交前逐字段比较基线与当前值；其他字段变化不阻断合并，同字段变化形成冲突。提交在一个存储事务中更新对象、ChangeSet、Workspace 修订并传递标记依赖对象 `needs_review`。富文本区间、列表合并及 CRDT Adapter 尚未实现。

CRDT 只适用于具有明确合并语义的文本、列表或协作对象，不作为所有业务状态的默认答案。付款、审批、状态机迁移和生成产物仍采用动作前置条件、乐观并发、幂等和人工裁决。

用户修改产生 `[生成版本 → 最终采用版本]` 差异，可作为低成本的隐式反馈候选；它可能只是临时修正、合规要求或个人选择，未经作用域确认和评测不能自动提升为全局偏好或奖励真值。

## 执行、凭据与不可信输入

- 模型只获得凭据句柄。v0.10.2 已实现 Broker 控制协议：只登记 `env:VARIABLE` 引用而不读取值；为 Task 签发最长一小时、绑定精确 DNS 主机与动作的租约；只授权无内嵌凭据的 HTTPS URL；指定动作要求审批引用；授权回执按请求摘要幂等，返回值只有 Handle。真实 Secret 注入仍必须由受信任 Host Broker/出站代理完成，Craft 当前不会代发 HTTP；日志、Trace、Artifact 和模型上下文的通用结构化脱敏仍需继续建设。
- 网页、邮件、PDF、工具说明和第三方响应标记为不可信数据。v0.10.2 已实现最小信任域协议：原文只登记 Locator 与摘要，不复制进 Craft；解析结果永久标记为零执行权限；疑似指令进入隔离状态；只有程序或人工审查后的顶层字段白名单投影可进入决策上下文，且仍需再次经过 Action Policy。敏感字段名会被确定性拒绝。每个放行字段保存内容摘要、解析器与 Schema、可选源片段 Selector/Citation 和审查身份；`craft_decision_projection_explain` 只解释已放行字段，不泄露同次提取中未放行的数据。

  `craft_untrusted_content_parse` 是第一种跨平台 Data-Only Adapter：原文摘要必须与信封一致，最大 1 MiB；JSON 只接受明确的 RFC 6901 Pointer，文本只接受一基行号；它不调用网络、命令、模型或其他 Tool，原文只存在调用内存中。确定性规则发现可疑指令时只记录信号类型，不复制攻击文本，并自动隔离结果。它是数据流权限隔离，不是独立进程或 OS 沙箱，也不负责 HTML/PDF/邮件解码，更不宣称识别所有提示注入；两个模型互审只能提高检测率，不能构成安全边界。

  `craft_parser_security_evaluate` 可用 1–100 个调用期样本重复运行同一 Parser 规则，计算提示信号 Precision/Recall、字段提取 Accuracy 与 TP/FP/FN，并把 Parser 版本、Suite 版本和整套输入摘要绑定到结果。数据库只保存样本摘要、期望/实际信号和是否提取一致，不保存攻击原文或期望业务数据。它让规则变化可以比较，但样本覆盖不足时的高分不等于真实世界安全保证。

  `craft_untrusted_content_parse_process` 将同一确定性解析协议放入独立 Node 子进程：请求只通过 stdin 发送，结果只通过 stdout 返回；子进程环境只保留操作系统与临时目录所需变量，Node Heap 上限为 64 MiB，调用可配置 10–30000 ms 超时，输出超过 2 MiB 会终止。成功与失败都生成不含原文的 `parser_process_receipt`。这提供进程崩溃、内存和超时边界，但没有网络命名空间、系统调用过滤或文件系统隔离，因此仍不能替代容器级不可信格式解析器。
- 所有变更型动作具有稳定 Action Hash 和 Idempotency Key；重试复用同一键。外部系统不支持幂等时，Adapter 必须先查询当前状态或转人工，不假装“恰好一次”。
- 新工具/API 的契约推导只生成候选 Schema、风险分类、探针和补偿草案；先做只读探测、Schema 校验和 Shadow Eval，通过签署后才能进入可执行 Registry。
- GUI/Computer Use 是结构化 API 不可用时的低可信 Adapter。每次关键操作前后重新观察界面；发送、发布、购买、删除等动作提高审批等级。验证码、登录确认及服务条款限制交还用户。

## 长任务与调度

持久 Run 保存目标、锁定版本、Operation DAG、已用/剩余预算、Checkpoint、Lease、待决策和外部等待条件。v0.10.2 已提供 Durable Wait 记录：审批、事件或时间等待进入持久状态后执行环境可释放；唤醒时复核信号、事件键、Workspace 修订和 Policy 指纹，漂移时转为 `needs_replan`。等待可绑定既有 Trial，创建与恢复会追加 `execution_waiting / execution_resumed` Trace，且不会因幂等重试重复记录。`craft_durable_wait_sweep` 可由任意跨平台调度器周期调用，以有界批次恢复到期时间等待；绑定过 Policy 却拿不到当前指纹时失败关闭为 `needs_replan`。真实 Webhook/定时进程、凭据和外部状态复核仍由后续 Adapter 提供。

子 Agent 只接收 Goal、约束、必要对象切片、可用动作和预算，返回 Artifact/Evidence/Outcome 引用。调度器记录调用图、深度、重复失败指纹和累计成本；环形转交、连续同类失败或无进展达到策略阈值时暂停并请求人类处理。

编译产物必须声明输入契约、适用范围、验证器和 `Fallback Trigger`。v0.10.2 的 Fallback Contract 已绑定精确 Subject 版本、显式触发器、回退策略、最大次数和可选预算预留；未命中继续执行，达到次数时阻断，预算不足时等待追加。调用方可把决策绑定既有同 Subject Trial，也可显式要求为命中的 Fallback 在原 Task 下开启续接 Trial；决策和预算预留写入 Trace。`craft_fallback_complete` 使用 Host 回执把运行中的 Fallback 收口为不可变 Outcome，校验 Evidence 与 Subject 版本，结算实际资源，并记录 `fallback_completed` Trace；重复完成返回原结果，不产生第二个 Outcome。输入契约自动判定及 Host 自动执行仍待接入。

## 成本、血缘与自主等级

预算是 Task、Plan、Run、Operation 和后台工作的一级对象。v0.10.2 已支持任意命名资源的硬上限、幂等预留和实际结算，实际值不能超过预留值，未使用部分自动释放；预留和结算可追加到关联 Trial Trace。父 Task 可为子 Agent、探索分支或后台工作分配子预算：创建时先在父账本冻结完整配额，防止并行超卖；子预算必须结清自身 Reservation 才能关闭，关闭时把实际消耗结算到父账本并释放未使用额度；父预算不能在活动子预算存在时关闭。预算预测、汇率/计费采集和接近上限时的计划重写仍是后续能力；不能固定在 70% 时无条件降级模型。

成果对象可按字段、单元格、段落、镜头或指标关联输入引用、转换动作、Capability/模型版本、时间和验证证据。不是所有格式都能立即做到单元格级血缘；最低要求是对象级来源，领域 Adapter 再提供更细粒度映射。

自主等级由动作风险与组织策略决定，而不是 Agent 自报：只读/本地临时、通知后执行、单人审批、多人联签和禁止。等级同时约束工具、数据范围、预算、环境和可接受验证器。

## 主动性、组织共享与存储

v0.10.2 已提供最小外部事件收件箱：按调用方提供的稳定事件 ID 与规范化请求指纹去重；相同 ID 携带不同事件键、Task、来源或载荷会被判定为幂等冲突。载荷永久标记为 `untrusted_data`，并只唤醒事件键和可选 Task 精确匹配的 Durable Wait。事件不会被解释成动作，也不会授予执行权限。后续的订阅 Adapter 可以触发预取、索引、只读诊断或草稿候选；主动任务必须显式订阅、可暂停、可查看费用，并有节流、过期和静默规则，默认不进行真实外部写入。

组织经验池属于后续 B2B 能力。个人轨迹先去除凭据和业务载荷，再形成带适用条件的候选；脱敏不等于匿名。发布需要数据归属、成员权限、独立评测、版本签署、撤回和删除传播机制，不能自动 Push 到所有员工。

当前 SQLite 记录已经采用版本化记录和追加 Event。长期通过 `Event Store + Snapshot + Projection + Artifact Store` 接口支撑时间查询与恢复；是否迁移到时序/图数据库由真实规模、并发和查询指标决定，不把更换数据库当作产品差异点。

## 实施优先级

1. 已完成内核：`ChangeSet / ActionPatch`、持久等待、预算预留/结算与 `Fallback Trigger`。
2. 已完成 Trial/Outcome、预算结算、幂等事件收件箱的控制面闭环；下一步连接真实 Webhook/定时 Adapter 与 Host Driver，验证崩溃恢复和人工接管。
3. 已完成凭据句柄、短期租约和精确出站授权协议；下一步实现至少一个真实 Host Broker/代理并做泄露测试。
4. 已完成不可信内容信封、字段血缘、零权限提取与审查投影协议，提供确定性 JSON/Text Data-Only Adapter、独立进程 Runtime 与可复算安全指标；下一步接入容器或平台 Sandbox 中的 HTML/PDF/邮件解码器，并维护覆盖多语言、编码混淆、间接注入和结构破坏的 held-out 样本资产。
5. 对象级血缘、Context Viewport 和受控 UI 投影。
5. 真实 Host 与领域场景验证后，再建设 GUI Adapter、主动任务和组织经验池。
