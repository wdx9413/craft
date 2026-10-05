# Matt Pocock `loop-me`：一手来源核验与 Craft 适配判断

> 检索日期：2026-10-03（Asia/Shanghai）。范围：Matt Pocock 官方仓库的 Skill、目录、提交历史及相关讨论；不安装、不执行外部 Skill，不修改 Craft 代码。本文的 Craft 建议是设计推论，当前实现核查由同轮主报告承担。

## 结论

`loop-me` 确实存在，但它是**把重复工作问清楚、写成规格的访谈 Skill**。本次核验未发现它带有任务执行器、重试循环、自动上下文重启或跨任务学习引擎。它对 Craft 最直接的价值在 Procedure 的设计入口和人工复核体验；不能据此认定 Craft 应再增加一个自主循环运行时。[Skill 源码](https://github.com/mattpocock/skills/blob/main/skills/in-progress/loop-me/SKILL.md?plain=1) · [目录](https://github.com/mattpocock/skills/tree/main/skills/in-progress/loop-me)

## 身份、分发与版本证据

- 准确位置为 `mattpocock/skills/skills/in-progress/loop-me`。官方将 `in-progress` 标记为 Beta：未进入正式插件或顶层 README，无独立文档页，可能变化或移除。用户贴出的 `ask-matt` 路由表没有列出它，不能据此判断它不存在。[官方分类说明](https://raw.githubusercontent.com/mattpocock/skills/main/skills/in-progress/README.md)
- 目录枚举只有 `SKILL.md` 与 `agents/openai.yaml`，未见配套脚本、模板或测试目录；元数据要求显式调用：Claude 侧为 `disable-model-invocation: true`，Codex 侧为 `allow_implicit_invocation: false`。这些是声明，本文没有运行宿主验证其强制效果。[目录](https://github.com/mattpocock/skills/tree/main/skills/in-progress/loop-me) · [agents 目录](https://github.com/mattpocock/skills/tree/main/skills/in-progress/loop-me/agents) · [Codex 元数据](https://raw.githubusercontent.com/mattpocock/skills/main/skills/in-progress/loop-me/agents/openai.yaml)
- 本轮可读取的文件历史显示：2026-06-24 移入 `in-progress`；2026-07-31 改为逐轮访谈表述；最近可见的 2026-08-19 提交调整标点。它们是文件历史，不是独立的 `loop-me` 发布版本。[迁移提交 e95b181](https://github.com/mattpocock/skills/commit/e95b1813c5b634cbc1484ca972557adcc10614c0) · [逐轮访谈提交 bfdaef8](https://github.com/mattpocock/skills/commit/bfdaef8e989a5c81160e74bc5043bd434da49cac) · [标点提交 3216582](https://github.com/mattpocock/skills/commit/321658273cb1d20b76026717d027d505790106d4)

证据限制：正文按本轮成功读取的 `main` 页面核验；提交历史页有抓取缓存，固定 SHA 的 blob/raw 请求返回 cache miss。因此本文提供已读取的固定提交页面，但**不声称已取得、逐字比对该 SHA 的完整树，也不把最近可见文件提交说成仓库当前 HEAD**。[文件历史](https://github.com/mattpocock/skills/commits/main/skills/in-progress/loop-me/SKILL.md)

## 实现机制

其自身提供一个很薄的领域层：把生活中的重复模式叫作 loop，把对应设计叫作 workflow；让 Agent 复用 `/grilling`，并将用户背景、术语写入 `NOTES.md`，每个流程的规格写入 `workflows/*.md`。背景不足时先访谈背景；并不要求所有流程都使用 AI、定时触发或人工检查点。[Skill 源码](https://github.com/mattpocock/skills/blob/main/skills/in-progress/loop-me/SKILL.md?plain=1)

四个有用的设计词汇分别是：触发条件（Trigger）、人作决定的位置（Checkpoint）、尽量准备充分后再交人判断（Push right）、以及带成果链接的简短决策摘要（Brief）。其完成条件是**规格足够清晰，接手实现者无需继续追问**。[Skill 源码](https://github.com/mattpocock/skills/blob/main/skills/in-progress/loop-me/SKILL.md?plain=1)

真正驱动访谈的 `/grilling` 将决策组织成有前置依赖的树；每轮只问前提已明确的问题，并提供推荐答案。查文件、查工具等事实调查由 Agent 做，用户负责尚未确定的决策；回答会改变下一轮可提问的范围。它以决策边界全部澄清、没有隐藏假设作为结束条件，并要求双方确认共同理解后再行动。这是自然语言过程约束，并非可执行状态机。[grilling 源码](https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/grilling/SKILL.md)

```text
用户的重复工作 + 现有背景
             ↓
grilling：事实调查 / 决策依赖 / 逐轮确认
             ↓
NOTES.md + workflows/*.md
             ↓
可供另外的实现流程使用
```

图中最后一条交接是对用途的解释，不代表 `loop-me` 自动启动实现。

## 三种不同的“循环”需要分开

| 问题 | 本轮证据支持的结论 |
| --- | --- |
| 如何把反复做的工作设计清楚？ | `loop-me` 的职责；产物是规格和背景记录。 |
| 一次运行如何成功、失败、重试或回滚？ | 当前 `loop-me` 没有可执行实现；规格完成条件不能代替运行完成证明。 |
| 如何从多次结果中验证改进并改变未来行为？ | 未见它实现评测、候选版本治理、效果归因或自动发布。不能把保存规格等同于持续学习。 |

上述否定判断限于已核验的 `loop-me` 文件及目录，不外推为整个 Matt 技能库都没有相应能力。[源码](https://github.com/mattpocock/skills/blob/main/skills/in-progress/loop-me/SKILL.md?plain=1) · [目录](https://github.com/mattpocock/skills/tree/main/skills/in-progress/loop-me)

上游 Issue #657 正在建议补充可观察的成功信号及失败策略，特别区分“规格完成”和“一次运行完成”。本轮页面仍显示 Open，带有 `ai-drafted-feedback` 标签；它是外部贡献者的提案，**不是 Matt 已接受的设计，也不是已实现能力**。[Issue #657](https://github.com/mattpocock/skills/issues/657)

上下文管理属于另一个层面：`ask-matt/PHASE-BOUNDARIES.md` 讨论在阶段边界选择继续、清空、交接、子代理或压缩，优先考虑保留仍有价值的原始上下文。`loop-me` 本身没有调用这些操作的自动重启脚本；跨会话持久化材料也不等同于自动恢复运行状态。[阶段边界文档](https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/ask-matt/PHASE-BOUNDARIES.md)

在已核验文件中也未见 grader、独立评分程序或短期 scratch 的过期清理规则；`NOTES.md` 与 `workflows/*.md` 应理解为持续维护的文件产物，不能推定为会自动清理的临时记忆。“可以交给实现者”是访谈的目标，由 Agent 与用户判断，不是已有测试证明的质量保证。[Skill 源码](https://github.com/mattpocock/skills/blob/main/skills/in-progress/loop-me/SKILL.md?plain=1) · [目录](https://github.com/mattpocock/skills/tree/main/skills/in-progress/loop-me)

## 对 Craft 的设计启示（建议，尚未实施）

1. **把重复工作发现做成轻量设计入口。** 用户说“每周都在做这件事”时，从真实样例和失败案例开始，形成可审阅的 Workflow/Procedure 草稿。先证明它值得重复，之后再决定是否加入定时、AI 或人工检查点。这是对 `loop-me` 方法的迁移，不是安装它便能得到的 Craft 能力。
2. **把背景与可执行契约分开。** `NOTES.md` 式材料适合作为待核验上下文；执行计划则须明确适用范围、输入、成功证据、失败去向和外部副作用边界。不能把访谈者写下的偏好直接升级成已验证经验。
3. **把人工检查点做成可作决定的页面或摘要。** 展示交付物、证据、尚存问题、需要用户作的那个决定及原件链接。把准备工作前移，减少来回追问；但不能把“晚些问”理解为先执行未获授权的不可逆操作。
4. **复用 Craft 的运行与经验治理边界。** 若当前内核已有有界重试、暂停、恢复、验收和候选经验评测，应把设计结果接到现有接口，而不是因名称中有 loop 再建立一套状态机。

可供后续验证的最小场景：选一个已经重复执行过的低风险任务，保留三份真实输入（含一次失败），产出一份草稿；由另一上下文中的实现者指出仍缺哪些决策，再让现有运行机制回放。分别验收“设计能交接”“一次运行能证明完成”“多次结果足以支持改进”，不以一项替代另外两项。

## 本轮验证范围

- 已读取官方 Skill 正文、依赖 `grilling`、Codex 元数据、目录、分类说明、文件提交历史和相关 Issue。
- 未安装、执行或测试外部 Skill；因此没有实际提问质量、宿主兼容性或持续改进效果的实验结论。
- 本次仅新增研究文档，不涉及增量代码覆盖率；后续若实施，需单独建立针对真实行为与失败分支的验收。
