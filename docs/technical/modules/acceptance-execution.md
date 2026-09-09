# 领域验收执行器：版本化 Evaluator 与租约 Job

v0.11.10 在 Acceptance Plan 与领域实现之间增加 Host 无关的执行契约。v0.11.11 增加通用 Adapter Tick、最大尝试次数、维护回收和首个真实文件成果检查器。v0.11.12 把该检查器接入常驻 CLI Worker 与 Workbench 的真实运行链路。Craft 保存验收条件、执行身份、版本、租约、回执和证据；研发测试器、视频探测器、模型 Judge、销售指标查询器等由独立 Adapter 实现。

`Acceptance Evaluator` 声明 `program`、`model` 或 `business_signal` 方法、Adapter 身份和不含密钥的配置。`Acceptance Evaluation Job` 将 Plan/Criterion 与 Evaluator 精确版本、输入摘要绑定。Worker 只能领取自身 Adapter 的 ready Job，租约过期后不能报告；结果只允许 passed、failed 或 blocked。

报告不会直接成为“真相”。Craft 将已授权 Adapter 的结构化 Receipt 摘要登记为 Evidence，再生成 Acceptance Check 并运行确定性汇总。报告重放必须与原摘要完全一致；配置版本、方法、Adapter、租约或 Artifact 引用不一致时失败关闭。真实 Secret、模型调用、命令执行、业务 API 鉴权和沙箱仍属于 Adapter、Egress 与 Runtime 的边界，不进入这一内核。

通用 SDK 的单次 Tick 会领取自身 Job、隔离单项异常并报告 blocked；Maintenance Worker 回收过期租约，超过 Evaluator 的最大尝试次数后生成 Operator Attention。Job 可以随 Work Launch 提前登记，但只有关联 Host Run 的真实状态为 `completed` 时才可领取，避免检查半成品。内置 `file_artifact` Evaluator 只读取声明工作空间内的相对路径，拒绝越界路径与链接，验证普通文件、大小、扩展名和可选 SHA-256。v0.11.16 又增加 `coverage_report` 与 `media_probe`：前者执行 Istanbul/nyc 指标阈值，后者验证 ffprobe JSON 中的媒体技术事实。三个 Adapter 分开领取 Job，但共享同一 Evidence 与 Outcome 协议；它们都不判断内容质量。

该协议使领域 Kit 可以组合通用控制面与专业 Evaluator：研发可以绑定覆盖率检查，视频可以绑定容器格式和人工审美，销售可以绑定 CRM 指标，教育可以绑定程序评分、模型 Rubric 与教师确认。Workbench 的逐行语法 `file:相对路径` 提供首个普通用户入口；MCP 的 `craft_acceptance_file_prepare` 可另外约束扩展名、最大字节数和摘要。当前内置 Worker 只覆盖文件结构真实性，下一阶段应增加经过真实领域任务验证的内容检查器与可生成的验收表单。
