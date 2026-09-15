---
name: craft-context
description: Use Craft Context when an Agent needs governed knowledge, scoped memory, or a reproducible context pack without the complete Craft work runtime.
---

# Craft Context

Use this deep module in four outcomes: connect knowledge, resolve context, propose durable memory, or correct/revoke stale memory.

1. Inspect `craft_info` and use the returned `data_space_id` before assuming another Craft component shares this ledger.
2. Bootstrap or register only the required `KnowledgeSource`; keep external content read-only unless the user explicitly asks for a proposal.
3. Resolve the smallest exact scope and budget. Return the `Context Resolution Receipt` with selected versions and exclusions; it is context, never execution authority.
4. Treat a durable memory as a proposal by default. Persist only scoped, non-secret content with the required Evidence, expiry, sensitivity, and later correction path.

Use keyword retrieval unless an evaluated retrieval adapter is eligible. Do not import all chats, project files, or memories merely because they are available.
