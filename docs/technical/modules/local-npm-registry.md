# Craft 本地 npm 制品仓库规范

状态（2026-11-18）：本机使用 Verdaccio `7.1.1`，监听 `127.0.0.1:4873`。Craft Runtime、Eval、Common 和 Capability 包都经本机 npm Registry 安装；清单和锁文件不再把这些依赖链接到兄弟仓库。Workbench 固定依赖 `craft@0.20.5`。当前本地包版本和依赖仓库映射见“当前依赖审计”。本规范覆盖 `craft`、`craft-common`、`craft-capability`、`craft-eval`、`craft-workbench` 与 `craft-marketplace`。

## 当前本机 Registry 与依赖审计（2026-11-18）

- Registry 为 Verdaccio `7.1.1`，只监听 `127.0.0.1:4873`；最大包体 `100mb`，以容纳约 `53.4 MB` 的 Craft npm 包。配置位于 `~/.config/craft-local-registry/config.yaml`，持久制品位于 `~/.local/share/craft-local-registry/storage/`，本地 npm 用户配置和令牌位于权限为 `600` 的 `~/.config/craft-local-registry/npmrc`。
- 当前服务以本机前台进程运行；启动命令为 `verdaccio --config "$HOME/.config/craft-local-registry/config.yaml"`，健康检查为 `curl -fsS http://127.0.0.1:4873/-/ping`。服务进程退出后需重新启动；尚未配置登录自启。
- npm 全局源仍是 `https://registry.npmmirror.com`。Craft 包安装和发布命令必须显式使用上述本地 `userconfig` 或 `--registry=http://127.0.0.1:4873`；仓库中不提交个人 Registry 地址、认证信息或 `.npmrc`。
- 本机 Registry 当前包含 12 个 npm 包：`craft@0.20.5`、`craft-eval@0.7.2`；`craft-common-store-local`、`craft-common-base`、`craft-common-log`、`craft-common-ontology` 均为 `0.20.4`；`@craft/capability-codebase`、`experience`、`file-dir-desc`、`knowledge`、`memory` 均为 `0.20.4`，`@craft/capability-datasec@0.1.6`。本地 Registry 的这些开发包只供本机安装，不代表它们已发布到公开 npm、团队镜像或远端 Git。
- `craft-common` 的跨包依赖使用普通 semver 版本并从 Registry 解析。`craft-capability` 的包间依赖也使用 semver；`linkWorkspacePackages: false`，锁文件保留 Registry 包的解析记录。
- `craft` 的 `pnpm-workspace.yaml` 只包含仓库内的适配器，不再包含 `../craft-common` 或 `../craft-capability`；`pnpm-lock.yaml` 不再有 `link:` 或 `file:` 的 Craft 运行时依赖。`build` 不再从兄弟仓库构建依赖。`craft-eval` 通过 `craft-eval@0.7.2` 安装，已移除 `vendor/*.tgz` override。
- `craft-eval/package-lock.json` 现包含 `craft-common-base` 和 `craft-common-store-local` 的精确版本与完整性摘要。私有包条目不记录本机 Registry URL；在 `craft-eval` 仓库使用本机 Registry 执行 `npm ci --ignore-scripts` 已成功。
- `craft-workbench` 的 `craft` 依赖已更新为 `0.20.5`，锁文件通过本机 Registry 补齐完整依赖图。Capability、Craft、Workbench 的 `node_modules` 均核验为 pnpm 虚拟存储路径，不再指向兄弟源码目录。
- `craft-marketplace` 没有 npm workspace 或 npm 锁文件；本次在其目录中未发现 npm `link:`、`workspace:` 或 `file:` 依赖。
- 发现并修复的问题：Craft 主仓库此前将两个兄弟仓库加入 pnpm workspace，导致普通 semver 依赖仍被锁成源码 `link:`；`craft-common` 曾用 `workspace:` 声明包间依赖；Capability 锁文件缺少 Craft 包记录；Workbench 清单的 Craft 版本与锁文件不一致。现有本地包安装、主仓库构建、Capability 构建和 Workbench CLI 均通过。

所有源码包的 manifest 应继续使用普通版本号（例如 `0.20.4`）。不要写 `workspace:`、`link:`、`file:`，也不要把兄弟仓库路径加入消费端的 workspace。开发者可在包各自仓库内改源码、构建并发布到本机 Registry；消费者只通过 npm 包名、版本和锁文件解析依赖。

本机安装命令：

```bash
NPM_CONFIG_USERCONFIG="$HOME/.config/craft-local-registry/npmrc" \
  pnpm install --frozen-lockfile --registry http://127.0.0.1:4873/
```

这条命令应在有 `pnpm-lock.yaml` 的消费端仓库执行。首次生成或更新锁文件时，也必须使用同一 Registry 和本地 npm 配置，然后检查锁文件中每个 Craft 包解析到精确版本及 `integrity`，不应出现 `link:`、`file:` 或 `workspace:`。

本机发布时先在对应源码仓库构建并生成 tarball，再发布 tarball；不要从消费者仓库解析兄弟源码：

```bash
mkdir -p "$TMPDIR/craft-local-pack"
pnpm pack --pack-destination "$TMPDIR/craft-local-pack"
npm publish "$TMPDIR/craft-local-pack/<包名>-<版本>.tgz" \
  --registry=http://127.0.0.1:4873 \
  --userconfig="$HOME/.config/craft-local-registry/npmrc" \
  --tag local --provenance=false
```

Verdaccio 绑定本机回环地址，本机账号以外的客户端无法访问；服务停止时，消费者安装应失败并提示 Registry 不可达，不能回退去链接兄弟仓库。需要跨机器或 CI 消费时，应部署可访问且有认证、TLS、备份的团队制品服务。

## 历史记录：2026-11-07 发布组

以下记录反映当时的 `0.18.0` 发布状态，不是当前本机 Registry 配置。Craft-Eval `0.5.0`、Craft `0.18.0`、其七个公共基础／能力包 `0.18.0` 已发布到本机私服；Workbench `0.16.0` 固定依赖 Craft `0.18.0` 并从私服安装。Craft-Eval 的 Craft 套件 `16/16`、Workbench 套件 `7/7` 通过，Workbench 全量测试 `203/203` 通过，安装 Runtime 协议检查及 Tauri 侧车预检通过。9 个制品的私服完整性均已核对，并备份与隔离恢复到 `~/.craft_data/package-registry/backups/craft-release-0.18.0-20261107/`。完整 Tauri 打包和渲染截图验收未运行。

## 目标与边界

```text
craft-eval → 发布固定版本 ┐
craft      → 发布固定版本 ├→ 本机 npm 兼容制品仓库 → 安装与构建 Workbench
                         └→ 公共依赖按需从上游获取
```

- Git 保存源码、版本、构建脚本与锁文件；生成的 npm 包不再反复提交到 Git。npm 的制品仍是压缩包，只是存储位置改为制品仓库。
- `craft-eval` 保持独立仓库和包。Craft 内核按实际运行需要声明 Eval 依赖；Workbench 使用固定的 Craft 版本，不引用开发机上相邻源码目录。
- 固定包名、版本和完整性摘要；同一版本对应同一组不可变字节。修复或重建使用新版本，不覆盖旧版本。发布记录绑定源码提交、构建环境、依赖锁、制品摘要及验证结果。
- 本机配置和认证文件放在 `~/.config/craft-local-registry/`，持久制品与服务日志放在 `~/.local/share/craft-local-registry/`。凭据不能写入源码仓库；临时打包目录不能作为制品的唯一副本。
- 只监听 `127.0.0.1` 时，另一台机器、远端 CI 和容器内的 `localhost` 无法访问本机仓库。另一台机器可各自部署并导入相同、已校验的制品；团队或 CI 共享时需要可访问的制品服务、认证、TLS 和备份。不要把个人机器的 `localhost` 地址作为所有环境通用的固定配置提交。
- 仓库是制品来源，包管理器缓存只是加速层。备份需包含已发布包及其元数据；清空缓存不能导致已发布版本丢失。

## 历史环境与验证记录（2026-11-07）

本机持久仓库在 `~/.craft_data/package-registry/`，使用 Verdaccio `6.11.1`，仅监听 `127.0.0.1:4874`。端口 `4873` 已被未能核实归属的进程占用，因此本机实例使用 `4874`。认证配置和 bcrypt 密码文件权限为 `600`，未改全局 npm 源；未登录不能读取内部包，普通认证用户也不能撤销已发布版本。公共依赖仅经只读上游镜像 `https://registry.npmmirror.com/` 获取。当前服务需手动在前台启动，不安装登录自启项。

本机当前版本组为 `craft-eval@0.5.0`、`craft@0.18.0`、三个 `craft-common-* @0.18.0` 和四个 `@craft/capability-* @0.18.0`。Craft 固定依赖 `craft-eval@0.5.0`，Workbench 固定依赖 `craft@0.18.0`。锁文件固定所有包版本和完整性；旧 Workbench `vendor/*.tgz` 仍由 Git 跟踪，作为回滚副本，不再是活动依赖。Craft `0.18.0` 的 npm 压缩包约 52 MB，包含 CLI、插件 bundle、OCR 资源和运行时代码；这与 Git 仓库体积是两个独立指标。

验收记录（2026-11-07）：Craft `0.18.0` 完整构建、类型检查、分层／接口／发布清单审计、CLI 与插件 smoke 通过；新增 Hook 诊断与运行包契约测试通过，Hook 诊断代码行／分支／函数覆盖率 `100%`。Craft-Eval 对 Craft `16/16`、对 Workbench `7/7`。Workbench 从私服冻结安装 `craft@0.18.0` 后协议检查、侧车预检及全量测试 `203/203` 通过，Hook 诊断面板行／分支／函数覆盖率 `100%`。Tauri 完整打包因缺少 `cargo` 未验证；Impeccable 静态检测仅报告未改动代码中的一个既有圆角 advisory，渲染视觉 QA 未运行。安装策略仅对本机私服中的精确内部版本设置最小发布时间豁免，公共依赖仍执行等待期校验。报告位于 `/private/tmp/craft-eval-018-release-final/285a8c2515024554a304204baedad267` 和 `/private/tmp/craft-eval-workbench-016-release/696a981dc99348a1bf791e34edc21c18`。这些确定性工程检查不证明真实用户收益；三个仓库的当前源码尚未提交或推送。

持久仓库按版本组保留独立备份；每次发布后须在隔离 storage 恢复，并逐包核对摘要。匿名私有包读取仍应被拒绝。服务自动启动、跨机器安装、远端 CI、离线构建和 Tauri 桌面打包未验证，因此这些不属于本轮已证明能力。旧 vendor 包暂不删除。部署应选择受支持且维护中的 Node 版本，并在目标机器重新验证 Verdaccio、认证、恢复与桌面构建；本次使用的 Node 版本不代表跨版本兼容。

### 当时使用的操作配置（已被上方 2026-11-18 配置取代）

2026-11-07 的服务使用 Verdaccio `6.11.1`、端口 `4874` 和 `~/.craft_data/package-registry/`。不要再按该旧路径启动当前服务。

## 本机仓库部署参考

以下是首次部署时的参考步骤，不是现成的 Craft 安装命令。当前机器安装 Verdaccio `7.1.1`；部署其他机器时先确认系统、Node 与依赖兼容。Node、npm 和安装源应由使用者自行安装并校验。

1. 确认 `node --version`、`npm --version`，检查选定的回环端口未被其他服务占用。不要终止未知服务或覆盖已有仓库；端口冲突时选用新的本地端口并同步本机配置。
2. 在 `~/.config/craft-local-registry/` 创建权限受限的配置和认证文件，在 `~/.local/share/craft-local-registry/` 创建持久存储。将 Verdaccio 安装在本机受控路径并记录准确版本。示例配置如下，其中上游地址须按所在网络替换：

   ```yaml
   storage: ./storage
   listen: 127.0.0.1:4873
   max_body_size: 100mb
   auth:
     htpasswd:
       file: ./htpasswd
       max_users: -1
       algorithm: bcrypt
       rounds: 10
   uplinks:
     npmjs:
       url: https://registry.npmjs.org/
   packages:
     '@craft/capability-codebase':
       access: $authenticated
       publish: $authenticated
       unpublish:
     '@craft/capability-experience':
       access: $authenticated
       publish: $authenticated
       unpublish:
     '@craft/capability-file-dir-desc':
       access: $authenticated
       publish: $authenticated
       unpublish:
     '@craft/capability-knowledge':
       access: $authenticated
       publish: $authenticated
       unpublish:
     '@craft/capability-memory':
       access: $authenticated
       publish: $authenticated
       unpublish:
     '@craft/capability-datasec':
       access: $authenticated
       publish: $authenticated
       unpublish:
     'craft':
       access: $authenticated
       publish: $authenticated
       unpublish:
     'craft-eval':
       access: $authenticated
       publish: $authenticated
       unpublish:
     'craft-common-store-local':
       access: $authenticated
       publish: $authenticated
       unpublish:
     'craft-common-base':
       access: $authenticated
       publish: $authenticated
       unpublish:
     'craft-common-log':
       access: $authenticated
       publish: $authenticated
       unpublish:
     'craft-common-ontology':
       access: $authenticated
       publish: $authenticated
       unpublish:
     '**':
       access: $all
       publish:
       proxy: npmjs
   ```

   内部包逐个列名且禁止撤销；不要使用宽泛前缀匹配，也不要允许已认证用户向任意公共包名发布。正式权限和网络边界须在部署环境验证；令牌只保存在权限受限的本机配置或密钥管理器中，不写进仓库、日志或命令记录。
3. 使用明确配置路径启动服务，验证本机健康检查和认证；再以普通、未认证身份验证不可发布内部包。需要自动启动时，使用系统服务管理器，并验证重启后存储仍可读取。服务停止、凭据失效和端口冲突要有明确错误，不能悄悄回落到公共仓库同名包。
4. 先备份持久化存储和元数据，再验证在隔离目录恢复。服务升级前再次备份；回滚服务版本前先核对存储格式兼容性。不要删除唯一的制品副本。

配置项和权限语义以 [Verdaccio 配置文档](https://www.verdaccio.org/docs/configuration/) 与 [包访问规则](https://www.verdaccio.org/docs/packages/) 为准。示例没有承诺跨主机访问或服务高可用。

## 发布与消费规范

1. **固定源码**：分别记录涉及的源码仓库提交与工作树状态。未提交的开发改动不能冒充干净提交；如需发布开发快照，必须使用独立版本并记录完整来源，不标记为正式版。
2. **构建 Eval**：在 `craft-eval` 独立构建、运行相关测试、打包并发布固定版本，记录包内容和摘要。不能覆盖已发布版本。
3. **构建内部依赖与 Craft**：按依赖顺序构建并发布 Common、Capability 包，再构建并发布 Craft。消费者 manifest 使用普通 semver 版本；Craft 的 Eval 依赖也使用已发布的固定版本。检查最终 tar 内的 `package.json`，确保没有指向发布机本地路径的依赖。
4. **切换 Workbench**：在 Workbench manifest 中写入要消费的 Craft semver 版本，通过本机 Registry 更新锁文件并执行 frozen install。锁文件须包含完整性摘要；不得加入兄弟源码目录、`file:` 覆盖或 workspace 注入。
5. **干净环境验证**：从新目录和目标仓库安装，运行 Craft CLI、MCP 协议检查、Workbench 运行时检查和目标平台桌面打包；检查版本、摘要及实际加载路径。还应验证仓库不可用、认证失败、缺包、摘要不符，以及没有上游同名包时的失败行为。
6. **移除 Git 产物**：只有新链路可复现并确认回滚可用后，才停止跟踪 `vendor/*.tgz`。普通删除不会抹去 Git 历史；若要清理历史，需单独备份、核对其他引用和外部固定 SHA 的影响，再按已授权的流程操作。

桌面安装包应在构建时带入已核验的 Craft 运行时，终端用户启动已安装应用不应依赖开发机私服。客户端安装依赖所用的仓库地址、认证和 TLS 由环境配置；不要提交口令或令牌。

## 验收与回滚

验收至少要求：新机器按文档启动仓库；能验证发布者身份；所有内部包版本和摘要可读回；相同锁文件在目标环境安装成功；运行时版本与协议一致；桌面打包通过；重启和备份恢复后制品仍可用。跨机器共享还须证明网络可达、权限隔离和 TLS。缺少其中一项时，不能宣称正式切换完成。

切换期间保留旧依赖配置和制品的可恢复备份。新安装或打包失败时，先将相关仓库恢复到切换前的已验证提交与锁文件，再按旧配置安装；不要覆盖或删除私服中的已发布版本。旧 Git 制品及备份何时清理，以独立恢复演练结果为准。
