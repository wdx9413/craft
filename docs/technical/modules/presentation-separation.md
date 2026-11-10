# Workbench / Desktop 展示层拆分

2026-10-08 起，展示源码迁到工作区同级 `craft-workbench/`。核心仓库没有指向展示目录的软链接，不需要该目录即可构建、测试和发布。

| 所有者 | 内容 |
| --- | --- |
| `craft` | Runtime、四个子能力、Skill/MCP/CLI、受鉴权保护的本地 HTTP API、通用运行包构建 |
| `craft-workbench/workbench` | HTML、CSS、浏览器 JavaScript 页面 |
| `craft-workbench/desktop` | Tauri 桌面壳、原生桥接、sidecar 准备 |
| `craft-workbench/tests` | 原页面单测、静态资源集成测试、桌面契约测试 |
| `craft-workbench/ci` | 已禁用的原桌面发布工作流，文件后缀为 `.disabled` |
| `craft-workbench/legacy` | 保留的旧 Windows 启动器源码，不参与构建 |

`craft serve` 默认只提供本地 API：`/health` 可读，业务 `/api/*` 保持 token 与同源检查；`/`、`/workbench` 和页面资源返回 404。启动输出为 `Craft API: ...`。不再自动向上寻找页面目录。

只有显式传入 `--workbench-dir <目录>` 才挂载页面；`craft gui` 未传该参数时返回迁移提示，不打开浏览器。新展示项目的 `pnpm start` / `pnpm serve` 已包含该参数。

核心 npm 文件白名单、workspace、版本检查、覆盖率分组和自动发布均不再包含页面与桌面壳。通用运行包清单使用 `runtime-artifacts.json.runtime_copies`，默认 staging 为 `dist/runtime/app`；展示项目显式指定自身为 staging 所有者，Tauri 从其 `dist/runtime/app` 打包核心运行时。Tauri 页面来自自身 `workbench/`，通过原生桥接访问核心 API。

`craft_distribution_plan_get` 保留接口，但返回 `presentation_status: paused`、`channel: separate_project`、空桌面资产列表。调用方传入旧的 `release_assets_available` 不会恢复已暂停的下载宣传。

Windows UIA、OCR、浏览器自动化、cognitive-workbench 等业务能力仍属于核心，名称中的 desktop/workbench 不代表展示源码。四个子能力的业务规则没有因本次拆分而调整。

展示项目目前是工作区中的独立目录，尚未初始化或发布独立 Git 仓库。提交核心仓库不会把同级新目录一并提交；需要保管两边源码。恢复 UI 使用新项目的显式命令，不应把目录软链接回核心或重新加入核心发布流程。

## 本次验证记录

- 核心 TypeScript 编译、类型检查通过；7 个 common/capability 包构建通过。
- 核心定向回归 46 项通过，包含真实回环 HTTP 与 CLI、鉴权、默认禁用、显式挂载和暂停桌面下载。
- UI 测试 30 项通过；迁出的 10 个页面逻辑模块行/分支/函数覆盖率均为 100%。`app.js` 保持原有未纳入该门槛的边界。
- 本次 5 个变更的 TypeScript 运行逻辑文件，按 Git 增量与 c8 执行映射核对：35/35 增量可执行行、22/22 增量分支臂覆盖。不是整个核心代码库 100% 的声明。
- 运行包与发布检查 4 项通过（其中覆盖率清单测试与前述 46 项有重叠），包括独立目录启动 CLI/API、页面缺省 404、npm dry-run 不包含 Workbench/Desktop、核心不再自动发布桌面。
- 展示项目的 `desktop/scripts/prepare-sidecar.mjs` 实际执行成功，产物归展示目录。
- 分层审计 392 个模块、0 违规；文档链接、版本检查、协议一致性检查通过。覆盖率清单无新增欠账，原有基线欠账仍在。
- 当前没有可用 Rust 工具链，未编译或运行 Tauri 原生壳、未构建 DMG/Windows 安装包，未做 UI 视觉验收；桌面部分只有迁移路径及权限契约检查。
- pnpm 的自动依赖核对曾触发外网访问并因网络不可达失败；编译/测试使用已有依赖直接执行，未下载或升级依赖。新展示项目启用 Tauri 前需按锁文件安装依赖。

Craft Context 开始回执：`context_resolution_6a5871c9fdae4ee59bc91f3676fcb254`，pack：`context_pack_905b4f1582e9ce693b1c62cb`。编辑后索引：`repository_index_50d1ec2c3ddeb7a73321d9e6`，checkpoint：`workspace_checkpoint_579ae9d21535452098d16c462564e7c3`；基础索引是部分覆盖，省略 211 个文件，不作为完整调用关系证明。
