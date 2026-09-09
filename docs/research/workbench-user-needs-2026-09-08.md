# 工作台用户诉求与行业决策

> 整理日期：2026-09-08。供产品决策使用，非行业统计、竞品排名或实测报告。

## 目录

- [证据规则](#证据规则)
- [用户反馈](#用户反馈)
- [行业进展](#行业进展)
- [Craft 决策](#craft-决策)

## 证据规则

用户原帖证明发帖者报告了某种体验，不证明所有用户遇到同一问题，也不证明当前版本未修复。搜索样本偏向重度用户，不能据此声称需求普及率。GitHub Open 状态不等于完成复现；论坛自动回复不作为根因证据。产品文档证明所描述的功能，不证明实际质量；预印本结论限于研究实验。

部分 TRAE 页面正文抓取超时，能读取的搜索索引内容单独标记，不假称完整复核。千问公开独立用户反馈较少；品牌赞助访谈单列。这里只保留人工反馈，不使用帖子内模型生成的评论作为调查证据。

## 用户反馈

| 来源与时间 | 观察到的诉求 | 证据边界与产品解释 |
| --- | --- | --- |
| [Codex #19891](https://github.com/openai/codex/issues/19891)，2026-04-27 | 文件与命令被合并摘要隐藏，影响及时监督与检查 | 原帖当时版本；应默认展示重要对象变化与验证动作，细节再展开 |
| [Codex #23418](https://github.com/openai/codex/issues/23418)，2026-05-19 | 手机创建的任务存在，但桌面项目列表找不到 | 报告的是任务关联/可发现性，不是数据丢失；项目需稳定连接任务和成果 |
| [Claude 文档/个人事务用户](https://www.reddit.com/r/ClaudeAI/comments/1u3et85/pro_user_here_are_my_biggest_claude_ux_pain/)，读取时显示约两个月前 | Chat/Cowork 文件割裂、同名版本难区分、资料访问和指令需要反复确认 | 单个主帖与少量回应；需求是连续工作和版本透明，不能概括为当前产品没有相关功能 |
| [TRAE 长任务反馈](https://forum.trae.cn/t/topic/20701)，2026-06-03 | 长时间等待时希望中断/取消，相同语义要求下结果更稳定 | 原帖同时肯定速度；取消、进度与验收值得纳入产品 |
| [TRAE 归档建议](https://forum.trae.cn/t/topic/22125)，2026-06 起 | 希望归档、分类与批量管理，不必在保留和删除之间二选一 | 搜索索引可读、正文抓取超时；有多位跟帖，但不是总体比例证据 |
| [TRAE 教学实践](https://forum.trae.cn/t/topic/175211)，2026-08 | 要求可编辑 PPT，却生成 HTML；局部编辑不顺，借其他工具转换 | 搜索索引可读、正文抓取超时；交付格式和可编辑性必须实际验收 |
| [TRAE 跨设备/入口建议](https://forum.trae.cn/t/topic/179836)，2026-09-05 | 家里/办公室、Code/Work 的项目记忆与过程难接续，积分规则增加选择负担 | 单个近期用户报告；不能据此认定平台没有任何同步功能 |
| [千问产品矩阵反馈](https://github.com/QwenLM/Qwen/discussions/2314)，2026-08 | 产品命名、入口和付费关系难理解 | 只引用作者本人反馈，排除随帖附带的模型评论；不能据此认定实际账单关系 |
| [千问体验文章](https://www.sina.cn/news/detail/5327975289455756.html)，2026-08-03 | 同类产品看起来相似；作者无长期项目时认为切换成本低 | 个人体验，非留存调查；差异需在连续工作中验证 |
| [律师体验访谈节目说明](https://www.xiaoyuzhoufm.com/episode/6a8d157fef65145dfcc4f113) | 列出 PDF 数据读取、希望直接完成 Excel 操作、客户资料隔离等问题，也肯定澄清与交付 | 仅阅读节目说明，未审听完整音频；有千问品牌赞助，非独立评测 |

**已更新能力必须纳入判断**：[Claude 当前官方说明](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) 已描述共享入口、云端会话（beta）、跨设备使用和项目记忆；不能把早期反馈当作固定缺陷。[Codex 官方开发入口](https://learn.chatgpt.com/docs/developers) 已提供技能/插件、执行环境和程序接入能力；不应把基础可扩展性宣传成 Craft 独有。

## 行业进展

| 一手资料 | 有帮助的结论 | Craft 的取舍（推论） |
| --- | --- | --- |
| [LangChain 用户调查](https://www.langchain.com/state-of-agent-engineering) | 在其 1,300+ 受访者中，质量是主要障碍，观察与评测采用有差距 | 调查有选择偏差；用户价值应看交付质量和人工投入，不仅看日志或配置数量 |
| [Anthropic Managed Agents](https://www.anthropic.com/engineering/managed-agents) | 将推理/Harness、执行环境与持久会话解耦，避免模型特定假设固化 | 保留稳定状态与动作协议，Driver/模型/沙箱后端可替换 |
| [Cloudflare Sandbox](https://blog.cloudflare.com/sandbox-ga/) | 提供持久执行环境、文件事件、快照及凭据相关能力 | 适配成熟基础设施，不把自建容器平台作为主要差异 |
| [Notion Custom Agents](https://www.notion.com/help/custom-agents) / [Runway Workflows](https://help.runwayml.com/hc/en-us/articles/45769159004691-Building-your-first-Workflows) | 现成产品已围绕工作对象提供事件自动化或创作流程 | 画布、后台任务和模型节点本身不是空白机会；重点验证编辑、续做和复用体验 |
| [Ink & Switch 可塑软件](https://www.inkandswitch.com/malleable-software/) / [Patchwork](https://www.inkandswitch.com/project/patchwork/) | 探索用户改变工具及面向创作的版本控制 | 工作过程中形成可修改的小工具和专业视图，是值得验证的长期方向 |
| [Harness 演化评测研究](https://arxiv.org/abs/2607.12227)，v2 2026-08-27 | 在研究覆盖的任务/模型中，同预算下演化未稳定胜过简单搜索，泛化有限 | 与等预算基线比较，不能把更多尝试带来的提升算作学习能力 |
| [Harness Continual Learning](https://arxiv.org/abs/2608.19013)，2026-08-19 | 修改外部记忆/策略也可能遗忘旧行为 | 分离提出与采用，同时检查新任务提升和历史保持 |
| [Adaptive Auto-Harness](https://arxiv.org/abs/2606.01770)，2026-06 | 探索异质任务流中的多 Harness 与任务时路由 | 保留有适用条件的策略集合，而非不断覆盖一个全局配置 |
| [AcCoRD](https://arxiv.org/abs/2608.27818)，2026-08-28 | 购物/旅行评测中，交互中变化的偏好仍是难点 | 把目标与偏好变更纳入状态，不把每次修改永久泛化 |
| [HarnessEvolve](https://arxiv.org/abs/2609.00829)，2026-09-01 | 用参考轨迹分析失败，并设置质量和性能门禁 | 参考轨迹利用已知答案，开放业务未必具备；优先收集实际用户修正与可核查结果 |
| [TraceCompiler](https://arxiv.org/abs/2608.02680)，2026-08-03 / [SkillDisCo](https://arxiv.org/abs/2606.26669)，2026-06-25 | 从多轨迹提炼参数化数据/控制流；保留未确定判断或拒绝编译 | 借鉴可核查依赖与残余模型节点；前者未计离线编译成本，不宣称净效率或固定倍数收益 |
| [MCP 代码执行](https://www.anthropic.com/engineering/code-execution-with-mcp) / [Code Mode](https://developers.cloudflare.com/agents/tools/codemode/) | 按需工具发现、代码处理数据及复用函数已有实践 | 聚焦生成能力在日常工作中的验证、选择和维护 |
| [AWS Saga](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-patterns.html) | 分布式失败通过补偿处理 | 补偿与快照恢复分别设计，不承诺全外部环境无损撤销 |

以上论文按预印本/研究结果使用，不作为已独立复现的产品能力。

## Craft 决策

采用三大支柱：工作与协作、执行与保障、学习与改进；评测作为第三支柱内的独立模块，沙箱属于第二支柱。完整产品面向各行业，技术模式不作为普通用户必须理解的入口。

重点验证七类需求：成果可编辑、工作可接续、资料/记忆可见、运行可停止恢复、结果有依据、低配置开始、经验长期可维护。新增生成 UI、上下文分层和后台整理时，都要服务于这些结果。

优先自研工作对象变更、动作语义、证据与复用之间的连接；逐步接入模型/Host、沙箱及专业编辑器。已有功能的组合只是差异假设，需用真实任务对照检验。用户数据可导出和迁移，不以数据锁定作为价值主张。

关联：[产品概览](../product/overview.zh-CN.md) · [架构](../product/architecture.zh-CN.md) · [实施路线](../product/roadmap.zh-CN.md)
