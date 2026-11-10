# 通用 Agent 业界一手调研：Muse、Claude、MCP Apps

调研日期：2026-09-27。目的：为 Craft v0.12.37 的统一计划补充产品方向与架构约束；不是实现或发布声明。仅采用已打开的官方页面。供应商描述属于“其公开宣称”，不等于本次独立实测；产品方向也不等于经过用户调研验证的需求。本文不修改生产代码。

## 1. Muse 指代与证据边界

用户只提供名称，尚不能唯一确定指代。与“近期、通用个人 Agent”最吻合的候选是 Meta 于 2026-09-08 发布的 Muse；但应保留假设，不能直接宣称用户一定指它。官方发布说明长期目标、背景执行、浏览器和权限控制；这证明产品定位，不证明“最火”或市场份额。[Meta 官方发布](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)

另外两个已核验候选：

- **Agent Muse / SiaFlow**：官网定位为接入既有 Agent 引擎的本地工作区，包含网关、审批、会话与移动端监督。页面存在 Beta 与 early-access 标记；本次没有验证下载包、团队能力或商业可用性。[官网](https://musetheagent.com/)
- **Muse.art**：官方手册定位为 AI 音乐创作与 MIDI 编辑工作区，不是同一通用个人 Agent。[官方手册](https://www.muse.art/docs/user-manual)

本次没有验证流行度；不以搜索排名、媒体标题或同名论文推导需求。以下重点采用 Meta Muse 的公开产品与工程设计，并将建议明确列为 Craft 的设计推断。

## 2. 三个方向的一手事实

### 2.1 从回答问题到持续负责目标

**已证实为官方设计描述**：Muse 的设计文档将目标、后台任务、计划进展、可见活动和结构化审批作为独立界面；计划或相关事件驱动后续工作，只在有意义的变化或需要输入时通知。其记忆允许用户查看和修改。[Muse 设计说明](https://introducing.muse.ai/)

**对 Craft 的推断**：用户主要感知应是“交付了什么、还等什么、下一步是什么”，而不是是否调用 Knowledge/Memory/Experience。Workbench 应优先提供统一任务收件箱、产物预览、待审批与接管、下一次唤醒及最近事实变化。底层组件仍可独立安装，不应要求非技术用户先理解组件名。

**验收建议**：引入两个非编码旅程——来源可核查的调研报告、文件整理/汇总交付；加一个只读变化监测旅程。记录终态成功率、返工量、用户主动介入次数和无效通知率。监测必须显式 opt-in、可暂停/撤销、有限预算；先证明可靠唤醒与恢复，不能用一个循环函数宣称全天候服务。

### 2.2 隔离权限权威，而不只是多一个审核 Agent

**已证实为官方工程描述**：Muse 将运行单元与安全敏感服务分离；Sentinel 是连接器动作及出站请求的权限权威，凭据服务在授权后代入秘密，审批通过独立客户端通道往返。具体实现涉及 Linux 隔离与网络控制，而非只靠模型自我约束。[Muse 安全工程](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)

**对 Craft 的推断**：应该借鉴职责边界，不复制一套昂贵 VM 或“再加一个 LLM”。Policy/Activation 负责可执行的确定性约束；Host Broker、Credential Broker、出口 Adapter 承担真实边界；模型风险判断只能补充证据。批准绑定具体目标、作用范围、动作摘要、有效期和 Task，不能由自然语言或调用参数变成授权。

**验收建议**：先在受控本地 Host 证明凭据不进模型上下文、拒绝跨 Task/replay、撤销即停止、敏感动作在实际 effect 前阻止。未做网络层控制时，只能说具备应用层限制，不能说“网络隔离”。同进程双 reviewer 也不是安全沙箱。

### 2.3 可靠工具优先，视觉控制是补位

**已证实为官方帮助文档**：Claude computer use 文档给出连接器优先、浏览器其次、屏幕交互最后的顺序；页面将 desktop computer use 标为 Beta，列出 macOS/Windows。文档还提示 Cowork 与聊天的合并正在渐进推出，因此旧名与界面可能不同，不能假设所有账号一致。[Claude computer use](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)

**已证实为官方工程论述**：Anthropic 区分环境隔离与概率性模型防护，并指出大量批准会造成注意力下降。其架构说明强调环境边界，而不是把逐次询问用户当作唯一保障。[Claude containment](https://www.anthropic.com/engineering/how-we-contain-claude)

**对 Craft 的推断**：默认路由应由“当前可用性、任务授权、效果风险、可验证性”选择工具，而不是优先演示点击。建议顺序是受控原生 API/已有 MCP → 结构化浏览器 → Accessibility/UIA → 经批准的视觉策略。每一次降级都要重新核对作用范围，不得把连接器不可用解释为屏幕操作已获授权。

**验收建议**：同一非编码任务比较上述路径的成功率、耗时与人工介入；低风险动作在确定边界内采用 Task 授权，高风险与目标不确定动作单独批准。Credential/审批/恢复等基础优先于新增视觉模型或平台数量。

### 2.4 通用应用需要交互产物，不只有聊天文本

**已证实为官方协议文档**：MCP Apps 将服务器工具/资源、Host 和 sandbox iframe View 分开；UI 资源与数据分离，初始化进行能力协商，并区分模型与 UI 可见工具。Apps 是扩展能力，不能由支持基础 MCP 推导支持 Apps。[MCP Apps 概览](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html)

**已证实为官方授权文档**：受保护 HTTP 请求应在协议边界认证，服务端验证身份及目标资源令牌；工具处理器仍需防御性检查。[MCP Apps 授权](https://apps.extensions.modelcontextprotocol.io/api/documents/authorization.html)

**对 Craft 的推断**：可将产物预览、事实来源卡、Memory 编辑、审批/接管做成接口层的可复用交互面；核心规则不依赖 iframe 或特定 Host。先复用 Workbench 视图及既有 Artifact/Evidence 契约，后续再接 MCP Apps Adapter；不为 UI 增加第二套 Task 或执行内核。Apps-only visibility 不是安全认证，不能因此允许 UI 自签审批。

**验收建议**：Host 不支持扩展时退回文本/结构化结果和本地 Workbench；支持时验证协商、CSP、消息来源、资源隔离、生命周期清理以及越权 UI 调用。任何生成 HTML 都不自动成为可信批准界面。

## 3. 对统一计划的优先级修正

以下是设计判断，不是供应商事实，也不是已经实施的代码。

| 优先级 | 建议工作包 | 架构落点 | 进入下一阶段的证据 |
| --- | --- | --- | --- |
| P0 | 维持既有终态、观察绑定、审核包和浏览器状态修复优先级 | Core 验证链、Experience/Knowledge Capability、Browser Adapter | 反例回归拒绝；现有正常任务闭环仍通过 |
| P0/P1 | 增加用户可见的任务收件箱与两类非编码产物旅程 | application 用例编排；Workbench/可选 Desktop 呈现；复用 Artifact/Evidence | 交付文件可打开、来源可追踪、缺证据不称完成；人工修订不会被后续运行覆盖 |
| P1 | API/MCP 优先的能力发现与降级协商 | 既有 Capability 注册/Activation/Host readiness；Adapter 报告实测能力 | 权限、Host、插件版本和目标都吻合；降级不扩权；无能力清晰 handoff |
| P1 | 权限与执行分离、凭据最小暴露、批准/接管 UI | 通用 Policy/Receipt + 外部 Host/Broker Adapter | 用户在独立可信界面批准，模型不能伪造；effect_unknown 不重放 |
| P1 | 显式后台目标与变化监测最小纵切 | 既有 Task/调度请求/恢复/配额 + 显式 Scheduler/Notification Adapter | 关界面后按配置继续；崩溃恢复不重复 effect；无变化不刷通知；撤销立即生效 |
| P1 | 可查看、改正、撤销的个人上下文 | Memory/Knowledge 保留来源链；接口层提供编辑/纠错 | 事实冲突可解释、跨项目隔离；“忘记”有清楚传播与保留边界 |
| P2 | MCP Apps 兼容呈现 Adapter | interfaces 层；复用既有用例，不向 Core 加 UI 类型 | 协商失败可退回文本；UI 与权限域分离；支持矩阵基于实际 Host 验证 |
| 后续独立项目 | 移动端/跨机器/云驻留 | 有 principal/device/ACL 后再建可信连接及部署 Adapter | 设备身份、撤销、审计、数据所在地和运行费用均可核验 |

不应为追热点将移动 App、云 VM、多 Agent 群、自动付款或图数据库同时塞进 v0.12.37。优先让一个普通用户的端到端任务真实完成，再扩展平台与协议。

## 4. 用户诉求假设与验证，不用热点替代产品研究

| 假设 | 小规模验证方法 | 与已有纯代码评测的区别 |
| --- | --- | --- |
| 用户希望少盯过程但能随时纠正 | 让用户中途修改目标、暂停、恢复；记录最终产物与接管次数 | 需要证明协作状态而非仅测试退出码 |
| 用户希望在已有工作习惯中使用，不想换 Host | 相同任务通过现有 Codex/Claude 插件及 Workbench 两个入口试用 | 区分可挂载、可发现、实际使用、终态四层 |
| 用户需要可编辑交付物，不只是答案 | 对报告/表格或目录清单执行格式、内容、来源验收 | 记录打开成功、返工和版本冲突 |
| 用户接受主动帮助但反感打扰 | 只读监测明确事件，比较有价值提醒与误提醒 | 单独测通知命中与误报，不用任务数替代价值 |
| 用户愿意复用记忆，但需要解释与控制 | 提供来源、适用 scope、纠错与撤销测试 | 区分个性化收益与隐私/陈旧信息风险 |

这些是待验证假设。本次没有用户访谈或统计调查，不能宣称代表全部通用应用用户。建议以实际完成率、返工、人工介入和安全/事实失败为主指标；时间、费用、Token 与缓存为有来源的辅指标；缺数据保持 unavailable。

## 5. 来源新鲜度及限制

- Meta 发布页明确日期 2026-09-08；安全/设计文章通过该官方页链接核验。没有据此承诺地区、套餐及后续发布计划一定已兑现。
- Anthropic containment 页明确日期 2026-05-25；computer-use 帮助页仅显示相对更新时间，因此本文记录读取日期而不编造具体修订日。
- MCP Apps、Agent Muse、Muse.art 页面未获得稳定发布日期；本次仅表示 2026-09-27 读取到的文档状态。协议实现应固定后续选定的规范/SDK 修订，再做 conformance；不是直接追浮动文档。
- 本次未安装或登录外部产品，未验证供应商安全机制、热度、用户规模或具体账号可用性；未新增依赖、插件、网络写入或后台任务。
- 与 Codex 最新能力的对照由同轮独立调研提供；此文不把 Claude/Muse 的桌面私有能力推断为 Craft 或 Codex CLI 已有能力。
