# v0.12.8 Runtime Boundaries

v0.12.8 turns the autonomous loop into an auditable runtime boundary:

- `InternalHostDriver` normalizes OpenAI/Anthropic Tool Calls, resumable sessions, context compaction, and a constrained action allowlist.
- `craft.trace` is the current write format; `craft.trace.v1` is read-only compatibility. Host runs, model turns, and tool calls share one trace and can be projected to OTLP/HTTP.
- The OS Security Kernel plans network, filesystem, Secret Broker, and fail-closed behavior for Windows, macOS, and Linux. It never claims isolation without evidence.
- The MCP Registry Kernel stores only HTTPS metadata, digests, health, and revocation records. Registry import is not trust or execution authority.
- A2A Transport sends a digest-only HTTPS envelope with no execution authority and returns a bounded receipt; remote raw context is not persisted.
- Organization Sync prepares a digest-pinned manifest and applies it only when the base digest matches, preserving conflicts and deletion tombstones.

These surfaces are shared by Codex, Claude, WorkBuddy, Trae, and the standalone CLI. Actual sandboxes, secret brokers, egress proxies, and encrypted sync remain adapter-provided and evidence-backed.
