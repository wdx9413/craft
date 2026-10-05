# @craft/capability-memory

Standalone memory kernel package. Depends on `craft-common-store-local`, `craft-common-base`, and `craft-common-log`; it does not depend on `craft-agent-harness`. Import the capability descriptor and register it with a `CraftStore` and optional `CraftTelemetry` via `CORE_KERNELS`. The existing Skill and MCP plugin remains the Host-facing surface.
