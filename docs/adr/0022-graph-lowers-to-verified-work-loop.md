# ADR-0022：Graph 只降低为 Verified Work Loop Plan

状态：Accepted（v0.12.35）

Graph 负责表达依赖、条件、并行 Join、有限重试、补偿和人工暂停，并由 `GraphCompilerKernel` 做静态校验与成本/分支分析。输出只能是交给 `VerifiedWorkLoop` 的 Plan。Graph 不拥有权限、Runtime、Host 调用或发布权，避免出现第二套执行语义。

