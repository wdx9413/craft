# ADR-0026：场景分类按能力分域、按项目分层

Knowledge 与 Experience 各自在 `~/.craft_data/{knowledge,experience}/projects/{project-id}/` 保存版本化 Scenario Catalog；Memory 继续按 Session、Project、Global 管理事实，不被场景目录吞并。Catalog 用稳定 ID 表示粗场景与细场景的父子关系，内容记录仍由对应能力的 Ledger/内容库管理，Catalog 只保存分类、映射和 provenance。模型可以提出、命名、合并或拆分场景；正式归类必须满足该能力的独立 Evidence 晋升阈值，含糊或冲突的结果保持候选/未分类，不能靠新建文件夹或相似命令自动合并。
