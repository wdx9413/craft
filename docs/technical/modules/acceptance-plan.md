# 领域验收计划：执行成功与业务正确分层

v0.11.9 为 Work Launch 增加独立的 Acceptance Plan。计划由一组具名条件组成，每项明确使用 `program`、`model`、`human` 或 `business_signal`，并声明是否为必需项。它不是 Prompt 中的一句模糊要求，而是带版本和摘要的持久对象。

每条 Acceptance Check 必须匹配条件声明的评审方法，记录评审者、结果、摘要和至少一条真实 Evidence。系统不会询问模型“覆盖率是多少”后把回答当作程序证据：程序条件应引用测试或检查器回执；模型条件保留模型身份；人工条件保留确认者；业务信号引用可观察指标。

汇总规则是确定性的：缺少必需项为 `pending`，必需项明确失败为 `failed`，依赖无法验证为 `blocked`，全部必需项通过才是 `passed`。可选项保留证据但不否决整体。Acceptance Trial 与 Host Execution Trial 分离，因此界面可以同时显示“执行完成、业务待验收”，也能分别比较执行可靠性和成果质量。

当前 Workbench 支持在创建工作时逐行输入条件，可用 `program:`、`model:`、`human:`、`business_signal:` 前缀；无前缀按人工验收处理。Host 执行完成后，用户可以直接对尚未判断的人工条件作出 `passed`、`failed` 或 `blocked` 判断并写下依据，Craft 会把确认者、结论和依据保存为 Evidence，再按相同规则重新汇总。界面不会替用户确认程序、模型或业务信号条件。自动运行具体领域检查器、生成行业专用表单和绑定外部业务指标仍由后续领域 Worker 与生成式界面完成。

失败、取消或中断的 Work Launch 重试时会复制原计划定义到新的 Acceptance Plan 和 Trial，而不是复用旧检查或旧 Outcome。这样验收标准保持一致，每次尝试的证据和结论仍彼此隔离。
