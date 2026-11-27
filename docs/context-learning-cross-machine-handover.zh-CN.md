# Craft Context 经验与存储：跨电脑交接

本文供下一台电脑上的执行者继续组装、验证和迁移。**这是一份交接草稿，不是已在目标电脑验证的操作手册。** 先完成三仓依赖装配并在隔离数据副本验证，再考虑目标电脑上的真实数据。不要把本机测试、候选生成或 Git 提交当成插件已安装、经验已启用或实际效果已验证。

## 当前状态

- 实现涉及 `craft`、`craft-common`、`craft-capability` 三个独立 Git 仓库。Common 对应提交 `d2c4b58`，Capability 对应提交 `878f0c3`；Craft 使用包含本文的提交。另一台电脑先逐仓核对 `git rev-parse HEAD` 和工作区状态。**仅有一个仓库的提交不足以复现。**
- 项目级长期数据目标位置是各项目根目录的 `.craft_data/`，全局数据使用 `CRAFT_DATA_DIR` 指定的数据根，未设置时采用默认配置。运行所需会话状态设计为驻留 Supervisor 内存；证据可以保留来源标识。
- 会话工作可能生成 Memory、Knowledge、Experience、Notes 的相应候选。脚本本体仍是项目或全局目录中的文件，Experience 保存引用及摘要；候选与已启用、可执行、实际复用和独立效果是不同状态。
- 两份手册的代表性内容已经在隔离数据副本验证候选生成和重复执行，但**尚未导入正式数据**。可提交的 `scripts/import-context-manuals.ts` 支持指定目标电脑上的项目根、预览摘要和幂等导入；目标电脑必须先准备对应来源文件和本次 Capability 构建。
- 正式数据迁移、插件安装、真实 Host 验收、独立任务效果尚未由这份交接证明。目标电脑的文件、项目路径和运行状态必须重新盘点。

## 先解决三仓依赖

三个仓库各自有版本和依赖。`craft` 的 `pnpm-workspace.yaml` 显式关闭兄弟仓库自动链接，依赖锁定为 registry 包；例如 `craft-common-store-local@0.21.1`、`@craft/capability-memory@0.20.10`、`@craft/capability-experience@0.21.0` 和 `@craft/craft-notes@0.20.9`。这些版本号本身**不能证明**取到包含本次源码的构建。

1. 在目标电脑准备三个仓库和本次交付提交，确认没有覆盖目标电脑既有工作区。Node 要求见各仓库的 `package.json`，当前仓库声明 Node 23 或更高；pnpm 版本见 `packageManager`。
2. 使用 `scripts/dev/build-local-workspace.py` 在工作区外的新目录装配源码并构建。需要 Node 23 或更高、pnpm 11.19.0、可访问其余依赖的 registry，以及精确的 `craft-eval@0.7.4` 成品包目录。本机 registry 未找到该版本，目标电脑须自行准备；不能用 0.8.0 代替。脚本不会改动原仓库的 `node_modules`，但会复制源码到指定目录，应按目标环境规则保护该目录。本机隔离构建和类型检查已通过，目标电脑仍需重新验证。

   ```sh
   python3 scripts/dev/build-local-workspace.py "$BUILD_OUTPUT" "$CRAFT_EVAL_PACKAGE_DIR"
   ```

   `BUILD_OUTPUT` 必须是工作区外尚不存在的目录；第二参数可省略，此时脚本要求 `craft/node_modules/craft-eval` 已安装精确版本。直接在原仓库执行 `pnpm install` 可能取到旧 registry 包，不应把它当作本次三仓源码的装配结果。
3. 在隔离装配完成后运行 Craft 的类型检查、相关测试和插件构建，确认打包后使用的是同一组三仓成果。已有入口包括 `pnpm run typecheck`、`pnpm run audit:layering`、`pnpm run audit:docs`、`pnpm test` 和 `pnpm run build:plugin`；这些命令必须在依赖装配正确的 Craft 检出中运行。不要使用构建或测试结果覆盖目标电脑现有的工作目录或运行数据。
4. 安装及切换 Host 使用的插件包前，记录原插件版本、位置及回退方式。检查真实 Host 加载路径和运行进程，确认其加载新包，而不是旧缓存。接入方式另见 [快速入门](quickstart.md)，其中全局存储路径描述不能替代本文的项目分区目标。

## 数据迁移的对应关系

| 旧数据或状态 | 目标或处理 | 注意 |
| --- | --- | --- |
| 可确认项目归属的长期数据 | 对应项目根目录 `.craft_data/` | 每个项目独立；父工作区与子仓库不是同一项目 |
| 全局数据 | 全局数据根 | 保持作用域和治理条件 |
| 运行中会话上下文 | Supervisor 内存 | 不新增会话级长期存储；历史记录单独对账 |
| 旧项目记录、知识和 Codebase 快照 | 经各迁移入口逐项预检、迁移、回读 | 缺根、缺文件、冲突和归属不明项保留，不猜测项目 |
| 旧 Notes / Experience owner catalog | 对应项目或全局范围 | 预检生成摘要，写入时要求相同摘要；多版本逐项核验 |
| 历史 Trace | 可验证归属的项目 Trace 分区 | 逐条预检；来源和身份不明确时保留待对账 |
| 历史仓库目录 | 复制归档 | 该迁移只复制归档，不代表已导入运行时，也不自动删除来源 |

## 迁移前置检查

以下步骤需要操作者在目标电脑重新验证。预览属于只读盘点，SQLite 快照或临时文件可能写入临时目录；`--apply` 会修改目标数据，不要在未完成备份和核验时使用。

1. 确定实际数据根、所有项目根、旧插件和 Worker 的运行位置。默认全局根通常为 `~/.craft_data`，但环境变量和设置文件可能覆盖它；以目标机器实际配置为准。检查项目根真实路径、空间、权限及 `.craft_data/.gitignore`，不要把业务数据提交到 Git。
2. 停止会访问同一数据根的旧 Host、MCP、Supervisor 和 Worker，确认不存在仍会写入的旧版本。旧版本未必识别新的项目分区；新旧版本同时写入可能造成状态分叉。SQLite 写锁只约束遵守该数据库事务的写入，不能防止外部程序直接改文件。
3. 保持停机，完整备份数据根、各目标项目已存在的 `.craft_data/` 及需要的旧来源目录，确认能恢复数据库、WAL 和内容文件。把备份放到独立位置并验证可读；仅靠脚本内部备份不能代替这一步。
4. 在已正确装配三仓依赖的 `craft` 根目录，分别运行适用的预览。下面的变量由操作者填写为目标电脑真实路径：

```sh
# 先设置实际路径；这里只是示例值，不会自动发现配置。
CRAFT_MIGRATION_ROOT="$HOME/.craft_data"
PROJECT_SCAN_ROOT="$HOME/projects"

node --experimental-strip-types scripts/storage-migration-apply.ts --data-root="$CRAFT_MIGRATION_ROOT"
node --experimental-strip-types scripts/codebase-storage-migration.ts --data-root="$CRAFT_MIGRATION_ROOT"
node --experimental-strip-types scripts/context-storage-migration.ts --data-root="$CRAFT_MIGRATION_ROOT" --limit=500
node --experimental-strip-types scripts/legacy-repository-storage-migration.ts --data-root="$CRAFT_MIGRATION_ROOT" "$PROJECT_SCAN_ROOT"
node --experimental-strip-types scripts/notes-storage-migration.ts --data-root="$CRAFT_MIGRATION_ROOT"
node --experimental-strip-types scripts/experience-owner-storage-migration.ts --data-root="$CRAFT_MIGRATION_ROOT"
```

Notes 和 Experience owner 入口要求对应 catalog 存在；不适用时记录原因，不要创建空库来让预检通过。Context 按返回的 `next_cursor` 翻页，直到结束。分别保存完整输出、退出码、待对账条目与预览摘要；不要只看 `migratable`。涉及个人信息的输出按目标环境的数据规则保管。

5. 对需要迁移的 Trace，用实际 Trace ID 单条预检。该脚本的 `--offline` 是操作者对停机条件的确认，不证明所有进程已停止。仅在来源、项目根、所有版本和事件都可核验时考虑执行；共享冷文件仍被引用时留待对账。

```sh
# TRACE_ID 必须替换为预检识别出的真实 ID。
node --experimental-strip-types scripts/trace-project-migration-preview.ts --data-root="$CRAFT_MIGRATION_ROOT" --trace-id="$TRACE_ID"
```

## 执行与回读

**目标机写入流程尚未实跑，先在备份副本上演练。** 写入期间继续保持旧 Host 停止；任何预览摘要变化、数据库锁冲突、项目根变化或回读失败都应停止并重新预检。不要把存在 `pending` 或 `blocked` 的部分成功说成全部迁移完成。

1. 按预览结果确认各组件的适用入口、备份位置和目标。Notes 与 Experience owner 的写入需要携带该组件本次预览返回的 `digest`，不得复用别的组件或旧预览的摘要。Trace 写入需要它自己的预览 manifest 和 `--offline`；上下文迁移需逐页处理并核对最终 `completion_verified`。命令参数以对应 `scripts/` 源码和本次构建为准。
2. 对已经在备份副本上通过预览、写入、重复执行、冲突处理及回读的入口，才在停机窗口使用对应 `--apply`。各工具的备份、输出和删除语义不同：例如历史仓库迁移是复制归档，旧会话目录隔离仍保留来源。不要手工删除旧数据来清除待对账数量。
3. 再次运行相同预检，逐版本回读项目库中的内容、作用域、来源引用和摘要，检查全局数据及其他项目隔离。对 Trace 检查事件、版本和源证据；对脚本检查文件路径、摘要及文件失效或变化时的状态。保存迁移结果与未处理清单。
4. 仍需回退时先停止所有写入者，再依据事先验证的完整备份恢复数据根与受影响项目目录，并恢复旧插件；恢复后核对数据库与内容文件一致。迁移之后产生的新写入不会自动合并回备份，因此恢复会丢失这些新增写入。不要单独替换 SQLite 而遗漏 WAL、内容文件或项目分区。

## 两份手册的后续处理

- `eval-all/AI_WORKSPACE_OPERATIONS.md` 的多仓约定归 `eval-all` 父工作区。
- `d-simu/docs/runbooks/standardized-conversation-agent-setup.md` 中专属内容归 `d-simu` 项目。

在目标电脑确认文件路径和当前摘要后，可在隔离副本先运行以下预览。将预览返回的两个完整 SHA-256 摘要分别填入变量，再以相同根目录和摘要执行 `--apply`；摘要变化会拒绝写入。

```sh
node --experimental-strip-types scripts/import-context-manuals.ts --workspace-root="$WORKSPACE_ROOT" --dsimu-root="$DSIMU_ROOT"
node --experimental-strip-types scripts/import-context-manuals.ts --workspace-root="$WORKSPACE_ROOT" --dsimu-root="$DSIMU_ROOT" --apply --workspace-digest="$WORKSPACE_DIGEST" --dsimu-digest="$DSIMU_DIGEST"
```

逐条回读 Knowledge 来源及候选、Experience 操作或恢复候选的来源、摘要、项目归属与生命周期。不要直接将设备快照当作当前事实，也不要把候选当作已启用能力。实际使用且可核对的设备和目录才进入 Notes。

## 验收与已知限制

- 本机隔离测试覆盖了 Hook / Supervisor 并发、项目路径、历史兼容、Notes 多版本与真实 Context MCP 召回等路径；这些结果不证明另一台电脑的装配、数据迁移或真实 Host 已通过。隔离 `pnpm test` 在文档检查阶段因缺少 `craft-workbench` 和 `craft-eval` 源码引用而中止，原工作区文档检查通过。单独继续的 `test:ts` 在串行进程中等待超过五分钟且无输出，已中止，失败数未知；目标机仍需定位并完成全量测试。
- 增量覆盖尚不能整体验收：Hook / Supervisor 相关差异已达到行和分支 100%；手册导入原始源码为 94/94 行、42/48 分支，另外六个故障分支已有注入测试，但不同注入版本的覆盖数据无法可靠合并；Experience contribution 的末次独立统计为 21/21 行、24/28 分支，后续补充的测试尚未重新统计；本地装配 Python 脚本覆盖未采集。基线分别为本次提交前各仓 HEAD。最后一轮 OCR 因网络或超时未完成，不能当作无问题；此前审查发现的问题已修复，最新差异需要重审。
- Host 应实际执行 Context 入口并遵循 Skill，Worker 的存在与启动需分别核验；MCP 工具可用不等于 Host 一定会调用。用真实项目分别验证已验证任务、无终态验证任务、无新增经验、项目与全局脚本召回、跨项目隔离及来源变更提示。
- Supervisor 的 Host / session 标识是同一操作系统用户下的协议边界。Host 复用相同会话标识且不提供生命周期代次时，无法可靠区分延迟到达的旧事件；进程异常退出或状态文件不可读时，部分清理可能依赖过期或 Supervisor 退出。
- 不明项目、缺失来源、无独立证据或发生冲突的记录保留待对账。候选、晋级、真实使用和独立任务效果分别验证；源记录不可用时不要补造证据。
- 本交接以目标电脑完成三仓装配、迁移回读和真实 Host 验收为完成条件；完成后将其标记为历史交接，并链接到实际运行文档。
