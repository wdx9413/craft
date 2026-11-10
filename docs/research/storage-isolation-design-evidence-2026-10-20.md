# 按能力与作用域隔离存储：Memory 分区原型及剩余约束（2026-10-20）

## 结论

现有 `CraftStore` 不能通过把 `craft.db` 复制到几个能力目录来完成隔离。已完成 Memory 的第一版分区原型：正文和完整版本写入按作用域选择的 SQLite 文件，主 `craft.db` 保留用于查找与路由的脱敏目录行。该原型没有解决跨分区崩溃恢复，也没有迁移 Knowledge、Experience 或 Codebase，不能视为正式全局隔离协议。

本记录保留最初的 SQLite 试验结论，并补充当前实现与可验证的限制，供后续迭代使用。

## 当前状态证据

- `CraftPaths.databaseFile` 指向单一 `db/craft.db`。`CraftStore.open()` 对它执行迁移、打开连接并重建域索引。
- `knowledge/knowledge.db`、`experience/experience.db` 仍保存可重建的 `content_index`。Memory 正式记录已按作用域进入用户全局 Memory 库、项目 `.craft_data/memory/memory.db`、会话 `/tmp/.craft_data/memory/{session_id}/memory.db`，以及其他作用域的独立文件。
- `records` 的主键是 `(kind,id,version)`。`create/save/updateIfVersion`、`find/list/listScoped/history`、摘要、删除和批量写入都直接读写主库。
- `listScoped` 以主库 `rowid` 生成读取 Watermark；`ContextAccessGuard` 和 Memory 治理代码也有直接 SQL 访问。核心、能力和公共包中共查到 31 处直接访问记录表或原始记录的调用点。
- `transaction()` 只在主连接创建事务/保存点。迁移升级有版本化 registry，并在旧库升级前备份。把行移到另一个文件会改变这些事务、Watermark 和备份语义。
- 当前项目数据根的只读聚合快照在 `.craft_data/runtime/storage-isolation-inventory-2026-10-20.json`。它只描述该项目根，不代表全局或其他项目。

## Memory 分区原型状态

- `CraftStore` 的 `memory_*` 记录按 `scope` 路由；global/user 写入全局库，project 需唯一活动项目路径别名，session 使用固定 `/tmp/.craft_data/memory/{session_id}/`，task 与其他具名作用域有独立兼容分区。无项目根、多个项目根或非法作用域会失败关闭。
- 主库保留作用域、正文引用/摘要等重建路由和筛选所需字段，不保留 Memory 正文；项目和会话 Markdown 投影写入各自的 Memory 目录。旧库启动时先备份，再迁移每个版本，迁移后的记录可重新读取。
- 事务失败时会删除尚未发布的分区行，测试覆盖回滚和不发布目录引用。分区提交与主目录发布仍不是可抵御进程崩溃/断电的原子事务；崩溃窗口的孤儿清理和恢复协议尚未实现。WAL、多进程竞争和迁移中途崩溃也未完成故障注入验证。
- 本轮最后一次分区存储、会话隔离、Memory 晋升与竞态定向运行共 65 项通过；TypeScript `tsc --noEmit` 和 `git diff --check` 通过。直接核验持久化数据：主库 83 条 Memory 目录行都有 `_memory_partition` 且正文数为 0；全局 Memory 库有 79 条，当前项目库有 4 条，与目录行总数相符。最近一次完整覆盖门禁为 91/140 组通过，发生在这轮最终修复之前；`store-atomicity` 组对整个历史 `store.ts` 计数为 46.90% 行覆盖，不能证明本次新增路由代码达到 100% 增量覆盖，覆盖率目标仍未验收。

## 本地 SQLite 隔离试验

在独立临时目录创建一个控制库和两个附加库，将三个库都设为 `DELETE` journal。一个 `BEGIN IMMEDIATE` 中分别插入三库，随后 `ROLLBACK`；三处行数都回到 0。这证明当前 Node SQLite 连接可以把多个附加文件放进同一应用事务并执行回滚，未测试进程崩溃或断电恢复。

附加库的临时 `UNION ALL` 视图可以读取多个库。尝试通过 `INSTEAD OF INSERT` 触发器把写入路由到指定附加库时，SQLite 拒绝了限定表名，错误为：`qualified table names are not allowed on INSERT, UPDATE, and DELETE statements within triggers`。因此不能靠一个联合视图和触发器保留现有写入接口。

## 尚需满足的迁移约束

1. 所有能力的正式账本按用户指定目录边界落盘：Memory 已有第一版；Knowledge、Experience 和 Codebase 仍需迁移到全局 `~/.craft_data/{knowledge,memory,experience,codebase}/` 与项目 `<project>/.craft_data/{...}/`。
2. 每个分区继续保留记录版本、Evidence/Source 引用、来源会话、记录状态和可校验正文引用；路径路由不能降低现有读取权限与撤销检查。
3. 一次操作写入多个分区时，必须有经过故障注入验证的恢复协议。现有普通函数回滚测试不能代替进程崩溃、重启、并发写入和待恢复状态测试。
4. 跨分区查询需要定义排序、版本水位和权限检查顺序。当前单库 `rowid` Watermark 不能直接作为多库全局水位。
5. 迁移需先备份，再执行 dry-run；正式切换前逐版本核对记录数、负载摘要、引用完整性和目标路径。失败时能恢复旧读写路径，不能双边各自成为活动事实源。

## 下一步

先给 Memory 原型补充跨进程写入、崩溃恢复、迁移中断和孤儿回收验证，修复 100% 增量覆盖缺口。之后再审查全部直接 SQL 读写调用，定义正式的多分区事务、查询水位和备份协议，最后逐项迁移 Knowledge、Experience 和 Codebase。

这一步仍不能只靠 `ATTACH` 联合视图解决：读取视图的能力已验证，写入触发器路由已被试验否定；故障恢复保证也尚未验证。若选择附加库方案，需先证明多进程、WAL/DELETE journal 配置、崩溃恢复和分区数量上限。若采用应用层事务协调，则需先定义提交日志、重放幂等键和读侧如何处理未完成事务。
