# Craft TypeScript / npm 迁移

## 决策

Craft 将迁移到 TypeScript，并最终以 npm 包和可打包的原生可执行文件交付，目标是让
CLI、MCP、未来桌面端与插件适配器共享类型和协议，同时取消最终用户对 Python 的依赖。

这个决策不是因为 Codex CLI 与 Claude Code 都采用 Node：当前 Codex CLI 的核心是原生
实现，本机安装也是独立 `codex.exe`；Claude Code 官方也已经把 npm 安装标为 deprecated，
推荐原生安装。Craft 采用 TypeScript 的理由是自己的产品形态和插件生态，而不是照搬竞品。

## 迁移原则

1. 不先删除已经通过完整测试的 Python Core。TypeScript 必须通过功能等价、数据迁移、MCP
   Contract、跨平台和覆盖率门禁后，才能成为默认入口。
2. 迁移期间不发布半成品 npm 包；根 `package.json` 保持 `private: true`。
3. TypeScript 源码不手写对应 JavaScript。开发环境可用 Node 24 原生 type stripping；正式 npm
   包由 CI 编译、生成声明文件并打包。
4. 旧 `~/.craft_data/craft.db` 只探测，不隐式移动。迁移命令必须先备份、校验 Schema、复制、
   对比行数与摘要，再原子切换。
5. Python 与 TypeScript 双栈期间共用 Contract 测试，不能靠重新解释旧数据实现“看似兼容”。

## 首次启动

无参数执行 `craft` 且尚未初始化时，进入向导：

```text
选择产品模式
├─ Agent：Craft 管理会话与模型循环
│  └─ 直接模型 API / Codex CLI / Claude Code / 稍后配置
├─ Supervisor：Craft 委派给一个或多个执行 Host
│  └─ Codex CLI / Claude Code / Generic MCP / 稍后配置
└─ Provider：Craft 作为插件、MCP 或 CLI 能力提供方
   └─ 不要求配置模型
```

模式不是永久安装类型，可以用 `craft mode agent|supervisor|provider` 切换。共享资产、任务、
证据和 Workflow 不随模式复制。API Key 只保存环境变量名称，实际值不写配置或数据库。

## `~/.craft_data` 目录契约

```text
~/.craft_data/
├─ config/config.json       # 模式、Provider 引用、Host 与用户设置
├─ db/craft.db              # Task、Workflow、Eval、Evidence 等事务状态
├─ index/capabilities.db    # 可重建的能力检索索引
├─ runtime/                 # PID、socket、临时会话交换文件
├─ logs/                    # 脱敏日志
├─ cache/                   # Hub manifest、下载与可删除缓存
├─ backups/                 # 迁移和用户触发的数据库备份
└─ craft.db                 # 旧 Python 版本数据库；迁移前只兼容读取
```

`config` 和 `db` 是不可随意删除的用户状态；`index` 与 `cache` 必须可重建；`runtime` 只能保存
短期协调状态；大视频、代码仓库和业务文件仍只登记 Artifact 引用，不复制到 Craft 数据目录。

## 完成门禁

- CLI、MCP、Catalog、Task/Memory、Workflow、Eval、Evidence/Lineage、Budget、Orchestration 和
  Agent Runtime 全部完成 TypeScript 等价实现。
- Python v14 数据库迁移前后逐表对账，故障可恢复。
- Windows、macOS、Linux CI；TypeScript 行、函数和分支覆盖率 100%。
- Codex、Claude、DSH 至少完成静态契约；有对应 Runtime 的 CI 完成真实安装与调用认证。
- npm 包取消 `private`，`craft` 与 `craft-mcp` 不再启动或下载 Python。
