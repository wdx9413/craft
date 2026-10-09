# @craft/capability-memory

Standalone memory kernel package. Depends on `craft-common-store-local`, `craft-common-base`, and `craft-common-log`; it does not depend on `craft-agent-harness`. Import the capability descriptor and register it with a `CraftStore` and optional `CraftTelemetry` via `CORE_KERNELS`. The existing Skill and MCP plugin remains the Host-facing surface.

`./memory-governance` exposes policy, proposals, Evidence-backed review, conflicts, approved commit, expiry, topic suggestions, pinned user confirmations and scoped governance tasks. `./memory-capture` exposes consented user statement capture with explicit source-bootstrap/Evidence ports. Topic suggestions require confirmation and never overwrite a remembered preference. Corrections use the existing conflict selection and approved supersession pipeline.

Unclassified preference capture checks related, scoped entries before automatic commit. Lexical and programming-language hints require topic or explicit replacement confirmation; hints never assign a durable topic or supersede an old entry. Governed mode also blocks conflicts with Ledger entries created without a candidate. Repeated approved captures can report already-retained active entries without writing them again.
