# @craft/capability-knowledge

Standalone knowledge kernel package. Depends on `craft-common-store-local`, `craft-common-base`, and `craft-common-log`; it does not depend on `craft-agent-harness`. Import the capability descriptor and register it with a `CraftStore` and optional `CraftTelemetry` via `CORE_KERNELS`. The existing Skill and MCP plugin remains the Host-facing surface.

`./claim-governance` exposes Claim save/get/list/review and synchronization. Candidate review requires bounded or confirmed Evidence and an explicit active Source; synchronization marks expired, changed-source/document or bounded contradiction cases for revalidation. Existing source ingestion still handles incremental revisions, deleted files and stale cursors.
