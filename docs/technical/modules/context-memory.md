# 上下文、记忆与后台整理

> v0.12.19 在 v0.10.0 的范围化 `memory_item` 与预算化上下文装配之上，新增 `KnowledgeSource`、`MemoryLedger` 与 `ContextResolutionReceipt`。v0.12.31 将知识和记忆正文分别放入 `~/.craft_data/knowledge/md/`、`~/.craft_data/memory/md/`，对应域 SQLite 作为可重建索引，主 SQLite 继续承担跨域事务；旧对象通过显式、可回滚迁移兼容。Markdown 文件名采用“可读标题 + 稳定短 ID + 版本号”，例如 `接口超时排查--a1b2c3d4e5f6.v1.md`，名称变化不会改变 `record_id`、Evidence 或权限。向量检索只有经泄漏、召回、时延和成本评测后才可选择。

v0.12.32 增加 `MemoryMaintenanceKernel`。`Light` 只做重复、过期、敏感和格式信号；`Review` 检查冲突、来源、作用域与使用关系；`Deep` 才可生成 Knowledge、Skill 或 Workflow Candidate。三阶段都保留历史、不物理删除、不自动覆盖，候选必须继续经过 Evidence、评测、Signoff 和 Canary。

### 作用域缺失时的只读行为

只读 Memory 查询和 Context Resolution 不应因为宿主暂时拿不到 user/project/task scope 而打断整轮工作：Craft 返回 `skipped: true`、空结果和 `reason: "scope_unavailable"`，不创建伪造 Receipt，也不回退到全局记忆。`craft_memory_search` 同时兼容旧的字符串作用域和标准 `{ kind, id }` 作用域；显式传入空对象、空字符串或 `null` 都按上述短路处理。为兼容既有 legacy service 调用，完全省略 `scope` 的旧搜索入口仍保留原行为；新的 MCP/Context Resolution 路径不会以省略 scope 的方式搜索全局。正式 Memory 写入、候选接受、状态迁移和持久 Context 绑定仍必须提供完整作用域，避免把局部事实升级为全局事实。

## 上下文分层与 CVMM

Context Virtual Memory Management（CVMM）在 Craft 中是应用层类比：模型当前可见内容相当于有限工作集，可检索资料和工作记录是外存。它不能直接操纵模型内部 Token、触发真实 CPU 缺页中断或扩展服务商 Context Window。

| 层次 | 内容 | 生命周期 |
| --- | --- | --- |
| 当前工作集 | 最新目标/约束、当前操作、必要资料和未解决问题 | 随阶段和预算更新 |
| 工作状态 | 对象版本、计划、产物引用、决策与 Checkpoint | 跨会话保留，输入变化后重检 |
| 事实与偏好 | 有来源的知识、用户选择及其适用范围 | 可更新、纠正、撤销或过期 |
| 程序经验 | 已验证的策略、模板、Workflow、脚本及失败模式 | 版本化评测、采用和淘汰 |

目标流程：按任务检索 → 权限与版本过滤 → 选择工作集 → 原文/摘要按需读取 → 记录使用依据。缺少信息时显式读取或询问，不依赖模型必然意识到自己遗忘了什么。

工具结果可在程序中筛选/聚合，只向模型返回必要数据与可重新读取的引用；摘要保留来源与关键约束，不能声称压缩无损。缓存按用户/项目权限、对象和版本隔离；原文件变更或权限撤销使旧引用失效。

## 可见、可纠正的记忆

当前内核按用户、任务或工作空间定界记忆，保留来源、证据、有效期和替代关系；正文存为带 frontmatter 和 digest 的 Markdown，域 SQLite 中的 `content_ref` 是唯一受管引用。上下文装配合并有效记忆与未归档工作对象，按查询匹配并遵守条目数及字符预算。

正文文件的名称是给人看的导航，不是事实主键：标题优先来自显式 `title`，没有标题时从 Markdown 一级至六级标题或首个非空行推导；文件名会保留中文和英文语义字符，清理路径分隔符与危险标点，并追加由 `record_id` 派生的短哈希避免重名。frontmatter 同时保存 `title`、`record_id`、`record_version`、`body_digest`、作用域、状态和来源。读取始终校验路径、身份、版本和 digest；用户可以改标题，但不能靠改文件名改变记录身份或权限。

`Context Profile` 是可审阅、可精确引用的选择策略：它固定任务/工作空间范围、允许的记忆类别和对象类型、强制纳入的记忆/对象，以及最大条目数与字符数。Profile 的同一 ID 可有多个版本；Task Graph 绑定的是精确版本。必选材料失效、超出范围或自身超过预算时，装配直接失败，而不是静默遗漏。它不是模型内部上下文窗口控制器，也不自动拉取或执行能力。

- 区分用户明确要求、模型推断偏好、已观察事实和候选经验。一次修改默认留在当前任务，不自动变成全局规则。
- 记录来源、置信/验证方式、适用项目与输入范围、有效期、替代关系及冲突；冲突未解决时保留多个版本或请求判断。
- UI 展示“本次采用了哪些资料/偏好”及访问状态。用户能排除、纠正、删除和导出自己的记忆。
- 逻辑失效/撤销与审计事实保留分别处理；按用户的数据保留或删除要求清理相关原文、索引和缓存，不以“审计”阻止正当删除。

## 后台整理 / Memory Consolidation（目标）

### 记忆写入策略

记忆捕获策略通过 `craft_memory_policy_save/get` 配置，范围默认是 `default`：

| 模式 | 行为 |
| --- | --- |
| `off` | 丢弃本次候选，不写入候选表或 Ledger；适合临时关闭自动捕获 |
| `propose`（默认） | 只生成脱敏候选，等待 Evidence-backed Review；不改变既有安全边界 |
| `governed` | 仅当候选无冲突、至少有 Evidence 且每条 Evidence 达到 `min_confidence`（`confirmed` 或 `bounded`）时自动写入 Ledger；不满足条件仍停在候选态 |

策略变更本身版本化并保留审计字段。`governed` 不是绕过审核的万能开关：它不能接受未验证结论、秘密、冲突候选或无 Evidence 的程序记忆。

只在用户配置的范围、时间与费用预算内调度可暂停任务。这里的“睡眠”不是模型生理机制，也不默认训练模型参数。已有知识 Claim 或 Memory Candidate/Ledger 时，Maintenance Tick 会自动运行过期扫描；没有相应数据时不会产生空的维护健康记录。过期只改变状态并保留历史，不删除正文。

```text
允许使用的已完成记录 / 用户修改
  → 去重与冲突候选 / 成功失败聚类
  → 带来源和适用条件的经验或程序候选
  → development 验证 + 独立评测 + 历史保持检查
  → Signoff 后采用 / 观察 / 撤回
```

幂等记录整理游标，避免反复付费处理同一批记录；用户开始前台任务或预算耗尽时让出资源。后台摘要不覆盖不可变 Trial/Trace/Outcome，不直接删除相互矛盾的事实，不自动发布 Skill 或提升执行权限。

`craft_memory_maintenance_cycle` 提供一个可恢复的后台学习游标：它按终态 Trace 的稳定 ID 顺序分批生成 `learning_observation`，只保存 Trace/版本/环境指纹和摘要 digest，不保存原始 Prompt、回复或敏感正文。观察可以成为后续 Experience/Memory Candidate 的输入，但不会自动写入正式 Memory，也不会绕过评测、Signoff 或 Canary。Worker 宕机后可用相同 `cursor` 重放，重复批次保持幂等。

反馈用于开发与候选诊断；held-out 不向候选生成器透露答案或逐例反馈。反复选择造成测试集过拟合时更新独立测试集。现有线上反馈审核和晋级协议继续生效。

## 评测与实施边界

评测召回/引用准确性、过期知识与跨项目混用、约束保持、重复解释次数、人工纠正时间、总 Token/时延/成本，以及学习新任务后的历史回归。删除与权限撤销需要独立验证。

第一步复用能力检索和持久工作状态，提供可见的上下文来源；随后补充权限/版本感知检索与偏好范围，再建设预算化后台整理。通用热点预测、自动换入/换出及后台守护进程目前尚未实现。

关联：[Capability](capability-kit.md) · [Workspace](agent-native-workspace.md) · [Experience/Eval](experience-eval.md) · [轨迹编译](transactional-runtime.md)
