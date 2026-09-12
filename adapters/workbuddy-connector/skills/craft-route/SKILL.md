---
name: craft-route
display_name: Craft 路由
description: Route substantial work to Craft's smallest safe MCP surface before selecting detailed tools.
description_zh: 先用最小 Craft 路由面决定复杂工作，再按需加载能力。
category: productivity
version: 0.11.62
author: wdx9413
---

# Craft Route

短回答、简单改写和一次性读取直接完成。对会改变交付、外部效果或验收条件的歧义，先写出简短工作约定，并最多提出三个会改变决策的问题；不依赖其他 Skill。

已知工作使用 `craft_default_route_resume`；自然语言续接只在唯一匹配时使用 `craft_default_route_find`；其他复杂工作只调用一次 `craft_default_route`。严格执行返回的下一安全动作，只读取被选中的能力上下文，并用 `craft_task_checkpoint` 记录真实进展。

默认 Core MCP 足够用于路由、证据、续接和已签发访问票据。只有用户明确批准登记、审核或修改外部能力来源时，才使用完整 MCP；完整工具面不等于扩大权限。
