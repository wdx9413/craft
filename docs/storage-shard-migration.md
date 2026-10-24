# Craft 主库分片迁移

当前源码把新 Trace 写入 `<data-root>/trace/v1/00.db` 至 `0f.db`。旧 Codebase 图记录在迁移后写入 `<data-root>/codebase/legacy-graph-v1/00.db` 至 `0f.db`。每个 Trace 及其事件固定在同一个分片；Codebase 图按记录 ID 分片。新 Codebase 图仍使用现有的项目目录文件存储。

迁移前必须先把包含这些读取路径的源码打包并安装，再停止所有 Craft Host。旧版 Host 不认识迁移后的分片文件。备份、迁移、压缩期间保持 Host 关闭；脚本的 `--offline` 表示操作者确认这个条件，脚本无法可靠检测所有外部进程。以下命令在仓库根目录执行。先确认磁盘空间足以保存主库备份和迁移中间文件。

```sh
node --experimental-strip-types scripts/trace-storage-migration.ts --data-root=/Users/didi/.craft_data
node --experimental-strip-types scripts/codebase-graph-shard-migration.ts --data-root=/Users/didi/.craft_data
node --experimental-strip-types scripts/compact-central-db.ts --data-root=/Users/didi/.craft_data
```

确认扫描量和可用空间后，在停机窗口依次执行：

```sh
node --experimental-strip-types scripts/trace-storage-migration.ts --data-root=/Users/didi/.craft_data --apply --offline
node --experimental-strip-types scripts/codebase-graph-shard-migration.ts --data-root=/Users/didi/.craft_data --apply --offline
node --experimental-strip-types scripts/compact-central-db.ts --data-root=/Users/didi/.craft_data --apply --offline
```

前两个脚本先创建并检查主库备份，再按 Trace 或图记录复制完整版本；目标行完全相同时可重跑，冲突时保留主库原行并报错。若中断，保持 Host 关闭并重跑对应迁移。压缩脚本使用 `VACUUM INTO` 创建新主库，检查完整性与表行数后原子替换，旧主库保存在 `backups/central-compaction/`。迁移完成并验证前不要删除备份。

验收：两个迁移脚本的只读扫描均返回 `versions` 或 `record_versions` 为零，Trace 流事件为零；Codebase 旧索引读取和 Trace 历史读取成功；主库与分片 `PRAGMA quick_check` 为 `ok`；主库文件大小下降。`VACUUM` 本身不会解决所有主库写锁：未拆分的其他业务记录仍共用主库 WAL 写入锁。
