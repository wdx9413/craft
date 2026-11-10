# Context / Codebase / Experience 规格审查

日期：2026-10-04。基线为 `9ada1c7a92dfc3847837b063081176696ca9f463` 与当前工作树；同时审查未跟踪实现。以下均通过隔离 fixture 复现，未执行真实用户任务或宿主发布。

1. **P1：已跟踪文件绕过 Git ignore。** [规格](../technical/modules/craft-context.md)要求“Git ignore…在读取源码之前执行”。`repository-files.ts:32` 的 `ls-files --cached --others --exclude-standard` 保留已跟踪的忽略文件；`git add private.ts` 后加入 `.gitignore`，仍读取并建立索引。**已修复**：用 `check-ignore --no-index -z --stdin` 再过滤全部候选；覆盖换行/空格文件名、规则优先级、错误传播和旧索引失效。

2. **P2：恢复仓库快照后误报索引可用。** [规格](../technical/modules/craft-context.md)要求当前 checkpoint 的可用索引。basic 建 A、改代码以 semantic 建 B、`workspaceRestore` 回 A 后，`repository-context.ts:34` 只比较 checkpoint，返回 `ready/reused`；实际 `codebase_index.status=stale`，符号查询报错。已交主任务修复：校验真实索引状态，并在恢复后创建绑定当前工作区修订的新索引；既有 `importAnalysis` 幂等返回也不能把旧 stale 记录当新结果。

3. **P2：配置式 Procedure 无法导出 Skill。** [规格](../technical/modules/experience-composition.md)要求固定版本流程复用，现有 Skill 导出是其分发接口。`ProcedureConfiguration.save` 只写 checked JSON；`procedure-projection.ts:169` 原先强制读取缺失的 `content_ref`，四阶段 Gate 后仍报 TypeError。**已修复**：使用既有 Markdown 视图导出，并附验证过的 `PROCEDURE.json`；只接受 routeable，保持 disabled/draft，损坏定义拒绝导出。

4. **P2：同名材料加工后的返工丢失有效输入。** [返工规格](experience-multi-entry-graph-design-2026-10-04.md)要求保留无关有效材料、失效被修改材料的下游验收。合法 `prepare → refine(report→report) → rework → refine → done` 在 `procedure-graph-progress.ts` 删除失效输出时，同时丢掉先前 `report@prepare` 的名字绑定。**已修复**：从初始输入和未失效的已验收历史重建名字绑定；重启后能够返工交付，旧回执及旧输出仍不能通过新出口。

验收：新增 [3 项集成回归](../../tests/context-spec-regressions.test.ts)，相关 50 项测试通过。`repository-files.ts`、`procedure-projection.ts`、`procedure-graph-progress.ts` 全文件 c8 语句 431/431、分支 399/399、函数 29/29，均 100%。原始证据位于 `/tmp/craft-spec-coverage.log` 与 `/tmp/craft-spec-coverage/coverage-final.json`。索引恢复项由主任务单独合并验收；全仓类型检查当时仍有其他并行测试的类型错误，未声称全仓通过。
