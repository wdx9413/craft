---
name: craft-runtime
description: 使用独立 Craft Runtime 管理任务、执行证据、工作区和 Trace。
---

# Craft Runtime

先读取当前 MCP 工具列表，确认本次任务的工作区、作用域和允许副作用。使用相应 task、workspace、execution 或 trace 工具建立和推进运行，保存原生执行结果与退出状态。

运行中、取消或缺终态的调用不能记为成功。重试沿用原任务或操作身份；恢复后先查询现有状态，避免重复执行。验证应绑定当前工作区版本及最后一次编辑。

Runtime 只维护本域任务和运行资产。Knowledge、Memory、Experience、Codebase、Notes 或 Eval 缺失时，报告该所有者不可用；不要在 Runtime 库创建它们的替代资产。
