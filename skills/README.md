# Bundled Skills

Craft exposes one deliberately small default baseline:

- `craft-route`: decide whether Craft is needed, then select the smallest safe route and MCP surface.

`craft` (durable governance) and `craft-clarify` (a bounded clarification contract) remain independent opt-in packages. Do not load them with `craft-route` by default: the route Skill already handles the short ambiguity decision and delegates all substantive capability to MCP.

These are policy-light primitives, not a permanent collection of elaborate prompts. Hosts should progressively disclose a Skill only when its description matches the task. A model or host can skip a Skill when the task is clear, and a verified user-, team-, or domain-provided Capability can replace it.

Additional Skills, MCP servers, templates, and expert services enter through the same Source → scan → activation → evaluation → certification pipeline. Discovery never equals execution permission, and a remote registry listing is not a trust decision.
