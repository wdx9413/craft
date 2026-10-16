# Knowledge 与 Experience 场景分类契约

## 目标

把相似工作归并到可复用场景，同时让边界能解释、能纠正。模型负责从可用证据中提出场景名称、父子关系和分类理由；规则层负责校验稳定标识、证据独立性、冲突和晋升，不让模型直接把一次猜测变成正式分类。

## 分类层级

- **粗场景**共享目标或验收边界，例如“仓库代码变更”；它可包含多个实现路径，不能作为具体流程自动执行的充分条件。
- **细场景**还要区分任务类型、关键输入和验证器，例如“修复 TypeScript 回归并运行目标测试”。独立调用、产出和验证结果以细场景聚合。
- **未分类**是合法状态。模型置信度不足、候选父项不唯一、验证信号互相冲突时保留未分类，等待新证据。
- 深度默认限制为两层。只有独立证据证明稳定的新子类，才允许把某个细场景拆成更细的版本化叶节点。
- 细场景可以先独立存在，后续证据足够时再补一个粗父项；后续分类省略父项不代表撤销关系。只有同一细场景被明确指向两个不同父项时才进入冲突，粗父项不改变细场景身份。

## 场景识别规则

1. 先解析项目 canonical ID，再读取对应能力自己的 Catalog；Knowledge 与 Experience 不共享场景 ID 命名空间。
2. 磁盘布局和 Schema 由 Craft 固定；模型设计的是 Catalog 内的语义分类，不得创建任意目录。场景定义用 `summary`、`applies_when`、`excludes` 三个有界字段，记录模型归纳的适用边界；原始任务正文、命令输出和业务文档正文不进入 Catalog。
3. Experience 以任务目标、变更区域、工具/副作用类别和终端 verifier 共同辨认细场景。精确 verifier 映射是强证据；同一条命令单独不足以合并场景。多个叶场景只有在共同目标和验收边界经独立结果支持时才归入同一粗场景。
4. Knowledge 以 Source、文档路径/标题/结构和 Claim 的证据关系辨认场景。场景只给 Claim/Source 加分类引用，不把受治理的正文搬到场景目录。检索可以结合场景过滤，但仍须满足 scope、Source 信任、Claim 状态和时效策略。
5. 模型提出的新分类先进入候选。Experience 至少需要两个独立验证任务才可生成 Procedure Candidate；粗场景晋升还需多个细场景的重复证据。Knowledge 场景归属至少由两个独立可信来源支持，单一来源可保留候选标签但不得成为跨来源事实。
6. Catalog 状态变更必须使用预期版本和稳定请求 ID，避免并发覆盖和重放。退出保留 Evidence/Claim 引用及摘要审计记录，但不再参与分类、场景过滤或晋升；粗场景必须先退出全部子场景。细场景合并/拆分通过 `craft_knowledge_scenario_migration_propose` 或 `craft_experience_scenario_migration_propose` 提交模型建议：合并至少两个来源到一个新 key；拆分一个来源为两个以上新 key。每个目标都要给出有界定义，目标先成为候选，源场景继续可读/可路由，直到新目标各自达到原能力的独立证据阈值；提案本身不搬 Claim/Observation，也不把旧证据计入新 key。达到阈值后，再用版本化退出操作淘汰旧细场景。粗场景继续通过子场景归组和退出治理，不在本版做粗场景迁移。

## 数据布局

```text
~/.craft_data/
  knowledge/
    knowledge.db
    md/                                  # Knowledge 正文与来源投影
    projects/{project-id}/knowledge-scenarios.json
  memory/
    memory.db
    memory.md
  experience/
    experience.db
    graph/                               # Experience 可执行定义版本
    md/                                  # Experience 审阅投影
    projects/{project-id}/experience-scenarios.json
```

Catalog 是控制面元数据，不是逐场景复制正文的目录。项目 ID 使用 Craft 的 canonical `project:` identity 去掉前缀所得值，不使用仓库内的 `.craft` 目录或路径别名。

粗细分类和模型提出的语义定义保存在 JSON Catalog 的 `tier`、`parent_scenario_key` 与 `definition` 字段中，不为每个场景创建操作系统目录：

```json
{
  "schema": "craft.experience-scenario-catalog.v1",
  "catalog_version": 1,
  "scenarios": [
    { "scenario_key": "engineering.change", "tier": "coarse", "definition": {
        "summary": "在项目中交付经过验证的代码或配置变更",
        "applies_when": "目标是改变仓库产物且有可观察验收边界",
        "excludes": "仅查询说明、无项目变更的建议"
      }, "verification_commands": [] },
    { "scenario_key": "engineering.change.typescript-tests", "tier": "fine",
      "parent_scenario_key": "engineering.change", "definition": {
        "summary": "修改 TypeScript 并以目标测试验证行为",
        "applies_when": "改动涉及 TypeScript 源码且有对应测试验收",
        "excludes": "只改文档或仅执行发布验证"
      }, "verification_commands": ["pnpm test:focused"] }
  ]
}
```

Knowledge Catalog 条目另外保存 `claim_refs`，每个引用包含 Claim ID、Source ID、Evidence IDs 和候选/已审核/失效状态；不会保存 Claim 正文。分类前模型可调用 `craft_knowledge_scenario_list` 读取项目已有粗/细 key 与激活状态，再在 `craft_knowledge_claim_save` 提交项目 Claim 的 `scenario_key` 和可选 `coarse_scenario_key`。目录路径与 ID 校验由 Craft 固定处理。一个细场景至少有两个独立 Source 的已审核 Claim 才成为 active；一个粗场景至少有两个 active 细场景才成为 active。Source 撤销、Claim 失效或争议会从独立来源计数中退出。检索传入 `scenario_key` 时只返回 active 目录下匹配的受治理 Claim；普通检索仍受 Scope、Source 信任、Claim 状态和时效约束。

Experience Catalog 保存语义定义、验证器摘要、观察引用和场景层级；定义来自模型对已验证任务目标、变更区域、副作用和验收路径的归纳，不从 Knowledge 或 Memory 复制。Experience 与 Knowledge 分开保存 Catalog，不能跨能力复用分类 ID。Host 在分类前调用 `craft_experience_scenario_list` 读取当前项目的 active/candidate/conflicted 粗细场景、已有定义、验证器映射和独立观察计数。复用已有场景时沿用其定义；新场景由 Host 模型提出 key 与定义。细场景按目标或验收路径区分；粗场景要求多个细场景具有共同目标/验收边界，不能仅凭同一工具或命令合并。Hook 只可用唯一精确映射读取已存在场景，不得用命令摘要造语义 ID。

Experience Catalog 自身治理晋升：目录只保存最多两个不同已验证任务 ID 的 SHA-256 摘要，不保存原始任务 ID；同一任务重试或重复 finalization 不增加独立计数。细场景在两个不同任务后自动 active，粗场景在两个 active 细场景后自动 active。晋升不接受调用方布尔开关，避免上游误报或重放导致提前激活。完整 Observation 和 Evidence 引用仍由 Experience Ledger 保留。

Knowledge Catalog 同样保存模型提出的语义定义。分类 Worker 将 Claim 与当前项目 Catalog 一起交给模型；模型根据主题及适用范围/来源证据边界复用现有定义，或提出新的细场景定义，只有存在多个不同细场景时才建议粗父项。对已有 key 的定义采用首次写入固定，模型不能在普通分类调用中覆盖既有定义；定义修订需要单独的版本化迁移，以免分类漂移被静默吸收。

## 本轮验收

- Experience Catalog 可表达 coarse/fine 父子关系，并兼容当前平铺条目。
- 相同 verifier 映射到多个细场景时必须判歧义，不得静默聚合。
- Knowledge 与 Experience Catalog 物理隔离且都落在各自 `.craft_data` 子目录。
- Experience 按项目维护粗/细场景 Catalog；模型分类只形成候选，细场景需两个独立验证任务晋升，粗场景需两个已晋升细场景。
- Knowledge 按项目维护独立 Catalog；Claim 保存、手动或自动审核、Source 退出都更新目录引用，场景检索只接受 active 分类。
- 测试证明父子关系校验、旧 Catalog 兼容、歧义拒绝、路径隔离、冲突保持和并发写入串行化。
- 新增 Knowledge 与 Experience Catalog 的行、函数和分支覆盖率均为 100%。

## 退出操作

Knowledge 和 Experience 通过 `craft_knowledge_scenario_retire` / `craft_experience_scenario_retire` 退出一个项目场景。调用必须绑定当前 `catalog_version`、稳定 `request_id` 和简短原因；只持久化原因摘要，不存原因正文。请求重放返回同一迁移结果；版本过期要求重新读取 Catalog。退出不会删除 Claim、Observation 或 Evidence 历史，后续误用该 key 会被拒绝或降为未分类。粗场景只有在所有子场景都已退出后才可退出。模型发现细场景边界变化时先提交合并/拆分候选；候选目标积累独立证据并自动晋升后，再退出旧 key。旧 Claim/Observation 与 Procedure 保留原场景引用，迁移不会伪造历史事实。

## 尚未达到的运行验收

Experience 目录由 Learning Cycle 根据模型提交的粗/细分类及验证 digest 更新，分类身份贯穿 Hook 观察；同一项目的目录更新经独占锁串行化，遗留平铺目录仍兼容。Knowledge 目录由项目 Claim 保存与审核调用更新，独立可信 Source 达阈值后激活；失效 Source 会撤销对应引用，场景检索要求目录仍 active。两套 Catalog 均有本地边界测试和 100% 增量覆盖。尚未完成的验收是运行中的 `.43` Host：本地测试与 smoke 不能证明真实 Host 已发送模型分类并持续迭代。
