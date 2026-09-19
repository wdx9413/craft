# 上下文成员的性质是固定的

`context` 由五个成员组成，每个成员的**来源性质**由 Craft 固定声明，不由能力重新定义：`history` 由宿主提供（Craft 只存 `query_digest`，按设计不持有对话正文），`knowledge`、`memory`、`experience` 由 Craft 跨任务累积、按 scope 检索、各有一道门槛（Evidence / 显式批准 / 评测加 Signoff），`state` 描述当前运行中的任务并在任务结束时过期。只有三个**累积型**成员可以成为能力并贡献上下文；`buildCapabilityRegistry` 拒绝贡献非累积型成员，而不是把它留给约定。**自托管不是反例**：Craft 自己跑循环时（`internal-host-driver.ts`）它就是宿主，因此在 `internal_session` 里持有 transcript 并直接压缩，不需要向自己要一个 `ContextContribution`——两种模式下 `history` 都是 `host_provided`，变的是宿主是谁而不是哪个成员可插拔。让 Craft 托管**外部**宿主的历史是一次对这张来源表的故意放宽，理由必须写在表旁。

`state` 的判别特征是**读取方式**而不是内容：它靠按 id 查询（`state_snapshot`、`task_run_state`、`context_manifest`）拿到，从不按相关度检索，并带一个 `stability_digest`——契约版本、activation profile、budget account、task_id、workspace、prompt_digest、environment_digest 中任一项漂移就进 `needs_replan`。这三条使它与三个累积型成员在机制上不同类，因此它不该被当作第四个可插拔成员。
