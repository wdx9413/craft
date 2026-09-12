---
name: craft
display_name: Craft 工作治理
display_name_en: Craft Work Governance
description: Use Craft for substantial work that needs durable goals, evidence, verification, or reusable workflows.
description_zh: 为复杂工作建立可续接目标、证据和验证边界。
description_en: Establish durable goals, evidence, and verification boundaries for substantial work.
category: productivity
version: 0.11.61
author: wdx9413
---

# Craft Work Governance

For substantial work, call `craft_default_route` first. Follow only the returned next action and load only its selected Capability context.

At material boundaries, record observed results with `craft_task_checkpoint`, `craft_artifact_register`, or `craft_evidence_record`. A model statement is not acceptance evidence. For a known task, use `craft_default_route_resume`; for a natural-language continuation, use `craft_default_route_find` and do not guess among multiple matches.

Do not use Craft for a short answer or a trivial read. Do not execute an external write, disclose credentials, or widen permissions without the host and user approval path.
