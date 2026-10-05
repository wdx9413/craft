# 公共包与接入验收

## 依赖和职责

宿主 `craft-agent-harness` 依赖四个子能力；子能力依赖 `craft-common-base`、`craft-common-store-local`、`craft-common-log`，不反向依赖宿主。`craft-common-base` 承担注册协议与不属于持久化/可观测性的共享算法，避免把能力协议硬塞进日志或存储包。`craft-common-store-local` 持有 `CraftStore`、路径、迁移及 Markdown 内容存储。`craft-common-log` 定义无内容日志、Trace、指标、用量/成本和评测记录的 SDK，以及本地存储 Sink 和 OTLP 导出。

日志写入通过 `CraftTelemetry.record()` 返回独立 receipt；Sink 失败不会伪装成业务调用失败。调用方应给每次操作稳定且唯一的 event ID，重试可幂等；同一 Trace 下的不同操作不得复用 event ID。属性只允许有界标量，不记录提示词、工具参数/结果或凭据。第三方能力可以依赖三个公共包并注册自己的 `CraftCapability`，也可以替换 `TelemetrySink`，无须导入宿主包。

评测契约区分 `reported_stage` 和 `verified_stage`：写入普通结果只改变报告状态；绑定的合格 `verification_assessment` 才能推进已验证阶段。路由门槛读取 `verified_stage`。这证明了本地状态机不会仅凭自报进度放行，但独立的 Host 身份与远程证据来源仍需部署环境验收，不能用本地测试替代。

## 构建与接入

`node --experimental-strip-types scripts/release/build-common-packages.ts` 先生成七个可发布包的 `dist` JS 与声明，再由根包和插件构建消费。各包 `exports` 指向自身 `dist`，不引用工作区源码。`tests/common-packages.test.ts` 把产物复制到隔离目录，仅安装子包及其声明的依赖，验证四个能力能注册且不需要 `craft-agent-harness`。`scripts/ci/audit-layering.ts` 和 `scripts/ci/check-version.ts` 阻止逆向依赖。

MCP 与 Skill 可以独立使用，Hook 仅是可选的事件接入面。Codex、Claude、dsh 和独立 Skill + MCP 的配置及本地冒烟测试仍沿用各自适配器/插件目录。插件包要在公共包构建后重新打包；旧 `core` 导入路径暂时通过再导出兼容。已有 Craft 数据目录保持原 schema 和迁移备份行为，无需搬迁用户数据。

`.github/workflows/publish.yml` 按公共包、子能力、宿主的方向定义发布顺序；每个新 npm 包还需配置可信发布身份。这里交付的是可部署配置和本地验收脚本，没有执行 npm 发布或远程部署。真实 Codex/Claude/dsh Host 会话、远程身份系统和团队隔离必须分别用目标环境验收。
