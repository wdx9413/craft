# transcript 不对外成为能力

Craft 自己跑循环时（`internal-host-driver.ts`）它就是宿主，因此它在 `internal_session` 里持有并压缩 transcript——但这是**一个宿主实现**，不是第五个可插拔的上下文成员。决定：**transcript 不对开放成能力**，`CONTEXT_MEMBER_SOURCES.history` 保持 `host_provided`。

理由是 `contributes` 的语义：它是"**自己持有 prompt 的宿主**缺料时向 Craft 要"的机制。宿主就是 Craft 时这个往返没有意义——它直接把 `messages` 拼进 `buildChatRequest`，不需要向自己要一个 `ContextContribution`。把 transcript 做成能力，等于为唯一一个不需要该抽象的调用者引入一层间接，同时把"Craft 不持有对话正文"这条可检查的事实换成一句承诺：记录一旦存进 Craft 数据库，`history` 就不再是宿主的东西，"内容不在 Craft 里"就无法再靠 schema 证明，只能靠政策约束。

因此三种累积成员之外的一切保持现状：`history` 由宿主提供（自托管时宿主即 Craft），`state` 属于运行中的任务并由 `StateViewKernel` 只读投影，两者都不是能力。若将来确实要让**外部**宿主把历史托管给 Craft，那是一次对 `CONTEXT_MEMBER_SOURCES.history` 的故意放宽，必须连同上面这条理由的反驳一起写进那张表旁，而不是顺手改一行。
