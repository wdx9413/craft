# Craft 本地 npm 制品仓库规范

状态（2026-11-07）：Craft-Eval `0.5.0`、Craft `0.18.0`、其七个公共基础／能力包 `0.18.0` 已发布到本机私服；Workbench `0.16.0` 固定依赖 Craft `0.18.0` 并从私服安装。Craft-Eval 的 Craft 套件 `16/16`、Workbench 套件 `7/7` 通过，Workbench 全量测试 `203/203` 通过，安装 Runtime 协议检查及 Tauri 侧车预检通过。9 个制品的私服完整性均已核对，并备份与隔离恢复到 `~/.craft_data/package-registry/backups/craft-release-0.18.0-20261107/`。三个仓库的代码提交仍需推送远端 main；完整 Tauri 打包未运行，因为当前机器没有 `cargo`；渲染截图验收也未运行。本规范适用于三个独立仓库：`craft-eval`、`craft`、`craft-workbench`。

## 目标与边界

```text
craft-eval → 发布固定版本 ┐
craft      → 发布固定版本 ├→ 本机 npm 兼容制品仓库 → 安装与构建 Workbench
                         └→ 公共依赖按需从上游获取
```

- Git 保存源码、版本、构建脚本与锁文件；生成的 npm 包不再反复提交到 Git。npm 的制品仍是压缩包，只是存储位置改为制品仓库。
- `craft-eval` 保持独立仓库和包。Craft 内核按实际运行需要声明 Eval 依赖；Workbench 使用固定的 Craft 版本，不引用开发机上相邻源码目录。
- 固定包名、版本和完整性摘要；同一版本对应同一组不可变字节。修复或重建使用新版本，不覆盖旧版本。发布记录绑定源码提交、构建环境、依赖锁、制品摘要及验证结果。
- 仓库、配置、认证文件、日志和持久化制品统一放在 `~/.craft_data/package-registry/`。临时实验可以放在系统临时目录，不能当作唯一备份。
- 只监听 `127.0.0.1` 时，另一台机器、远端 CI 和容器内的 `localhost` 无法访问本机仓库。另一台机器可各自部署并导入相同、已校验的制品；团队或 CI 共享时需要可访问的制品服务、认证、TLS 和备份。不要把个人机器的 `localhost` 地址作为所有环境通用的固定配置提交。
- 仓库是制品来源，包管理器缓存只是加速层。备份需包含已发布包及其元数据；清空缓存不能导致已发布版本丢失。

## 当前事实与验证范围

本机持久仓库在 `~/.craft_data/package-registry/`，使用 Verdaccio `6.11.1`，仅监听 `127.0.0.1:4874`。端口 `4873` 已被未能核实归属的进程占用，因此本机实例使用 `4874`。认证配置和 bcrypt 密码文件权限为 `600`，未改全局 npm 源；未登录不能读取内部包，普通认证用户也不能撤销已发布版本。公共依赖仅经只读上游镜像 `https://registry.npmmirror.com/` 获取。当前服务需手动在前台启动，不安装登录自启项。

本机当前版本组为 `craft-eval@0.5.0`、`craft@0.18.0`、三个 `craft-common-* @0.18.0` 和四个 `@craft/capability-* @0.18.0`。Craft 固定依赖 `craft-eval@0.5.0`，Workbench 固定依赖 `craft@0.18.0`。锁文件固定所有包版本和完整性；旧 Workbench `vendor/*.tgz` 仍由 Git 跟踪，作为回滚副本，不再是活动依赖。Craft `0.18.0` 的 npm 压缩包约 52 MB，包含 CLI、插件 bundle、OCR 资源和运行时代码；这与 Git 仓库体积是两个独立指标。

验收记录（2026-11-07）：Craft `0.18.0` 完整构建、类型检查、分层／接口／发布清单审计、CLI 与插件 smoke 通过；新增 Hook 诊断与运行包契约测试通过，Hook 诊断代码行／分支／函数覆盖率 `100%`。Craft-Eval 对 Craft `16/16`、对 Workbench `7/7`。Workbench 从私服冻结安装 `craft@0.18.0` 后协议检查、侧车预检及全量测试 `203/203` 通过，Hook 诊断面板行／分支／函数覆盖率 `100%`。Tauri 完整打包因缺少 `cargo` 未验证；Impeccable 静态检测仅报告未改动代码中的一个既有圆角 advisory，渲染视觉 QA 未运行。安装策略仅对本机私服中的精确内部版本设置最小发布时间豁免，公共依赖仍执行等待期校验。报告位于 `/private/tmp/craft-eval-018-release-final/285a8c2515024554a304204baedad267` 和 `/private/tmp/craft-eval-workbench-016-release/696a981dc99348a1bf791e34edc21c18`。这些确定性工程检查不证明真实用户收益；三个仓库的当前源码尚未提交或推送。

持久仓库按版本组保留独立备份；每次发布后须在隔离 storage 恢复，并逐包核对摘要。匿名私有包读取仍应被拒绝。服务自动启动、跨机器安装、远端 CI、离线构建和 Tauri 桌面打包未验证，因此这些不属于本轮已证明能力。旧 vendor 包暂不删除。部署应选择受支持且维护中的 Node 版本，并在目标机器重新验证 Verdaccio、认证、恢复与桌面构建；本次使用的 Node 版本不代表跨版本兼容。

### 当前本机操作

```bash
# 在终端前台启动本机服务；退出终端即停止，不配置系统自启
umask 077
node "$HOME/.craft_data/package-registry/app/node_modules/verdaccio/bin/verdaccio" \
  --config "$HOME/.craft_data/package-registry/conf/config.yaml"

# 另一个终端检查服务并按锁文件安装
curl --noproxy '*' http://127.0.0.1:4874/-/ping
NPM_CONFIG_USERCONFIG="$HOME/.craft_data/package-registry/conf/npmrc" \
  CI=true pnpm install --frozen-lockfile --registry http://127.0.0.1:4874/
```

凭据只在 `~/.craft_data/package-registry/conf/npmrc` 与 `htpasswd` 中保存，不复制到仓库或命令参数。其他机器应在自己的 `~/.craft_data/` 初始化认证仓库并导入通过摘要校验的包；本机 `127.0.0.1` 不可供远程机器或 CI 使用。

## 本机仓库部署参考

以下是首次部署时的参考步骤，不是现成的 Craft 安装命令。示例使用固定版本 Verdaccio 6.11.1；部署前先确认当前系统、Node 和依赖兼容。Node、npm 和安装源应由使用者自行安装并校验。

1. 确认 `node --version`、`npm --version`，检查选定的回环端口未被其他服务占用。不要终止未知服务或覆盖已有仓库；端口冲突时选用新的本地端口并同步本机配置。
2. 在 `~/.craft_data/package-registry/` 下创建权限受限的服务目录、存储目录和配置。将 Verdaccio 安装在该目录或由机器的受控包管理器安装；记录准确版本。示例配置如下，其中上游地址须按所在网络替换：

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
     '@craft/capability-knowledge':
       access: $authenticated
       publish: $authenticated
       unpublish:
     '@craft/capability-memory':
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

1. **固定源码**：分别记录三个仓库的提交与工作树状态。未提交的开发改动不能冒充干净提交；如需发布开发快照，必须使用独立版本并记录完整来源，不标记为正式版。
2. **构建 Eval**：在 `craft-eval` 独立构建、运行相关测试、打包并发布固定版本，记录包内容和摘要。不能覆盖已发布版本。
3. **构建内部依赖与 Craft**：按依赖顺序构建并发布公共基础包、能力包，再发布 Craft。将 Craft 中的 `file:vendor/...` 改为可解析的固定 Eval 版本；检查最终 tar 内的 `package.json`，确保没有指向发布机本地路径的依赖。
4. **切换 Workbench**：先确认 Craft 包与所有传递依赖可在目标仓库解析，再修改 Workbench 的依赖与锁文件，删除不再需要的 `file:vendor` 覆盖。必须锁定完整性摘要，避免不同机器安装出不同字节。
5. **干净环境验证**：从新目录和目标仓库安装，运行 Craft CLI、MCP 协议检查、Workbench 运行时检查和目标平台桌面打包；检查版本、摘要及实际加载路径。还应验证仓库不可用、认证失败、缺包、摘要不符，以及没有上游同名包时的失败行为。
6. **移除 Git 产物**：只有新链路可复现并确认回滚可用后，才停止跟踪 `vendor/*.tgz`。普通删除不会抹去 Git 历史；若要清理历史，需单独备份、核对其他引用和外部固定 SHA 的影响，再按已授权的流程操作。

桌面安装包应在构建时带入已核验的 Craft 运行时，终端用户启动已安装应用不应依赖开发机私服。客户端安装依赖所用的仓库地址、认证和 TLS 由环境配置；不要提交口令或令牌。

## 验收与回滚

验收至少要求：新机器按文档启动仓库；能验证发布者身份；所有内部包版本和摘要可读回；相同锁文件在目标环境安装成功；运行时版本与协议一致；桌面打包通过；重启和备份恢复后制品仍可用。跨机器共享还须证明网络可达、权限隔离和 TLS。缺少其中一项时，不能宣称正式切换完成。

切换期间保留旧依赖配置和制品的可恢复备份。新安装或打包失败时，先将相关仓库恢复到切换前的已验证提交与锁文件，再按旧配置安装；不要覆盖或删除私服中的已发布版本。旧 Git 制品及备份何时清理，以独立恢复演练结果为准。
