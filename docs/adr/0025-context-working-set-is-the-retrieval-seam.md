# ADR-0025：Context Working Set 是唯一检索 Seam

状态：Accepted（v0.12.35）

Host 通过 `ContextWorkingSetKernel` 请求一次有界、可解释、无正文的 Context Receipt。`history` 由 Host 提供，`state` 来自当前任务；只有 knowledge、memory、experience 进入可评测 Retrieval Adapter。默认关键词/结构化索引，向量 Adapter 只有在召回、泄漏、延迟和成本评测通过后才可选用。

