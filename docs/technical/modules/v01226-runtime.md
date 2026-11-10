# v0.12.26 Generic Adapter Runtime

v0.12.26 adds the first shared execution layer for CLI, GUI, MCP, and host plugins.

## Adapter contract

Every adapter is described by a versioned `Adapter Manifest`. It declares its kind,
platforms, capabilities, permissions, effects, transport, integrity, sandbox profile,
and receipt contract. Registration, health, conformance, quarantine, rollback, and
installation are controlled by `V01226Runtime`; an adapter package is not executable
authority until its policy and health checks pass.

## Cross-platform commands

`craft command plan/run/observe/cancel/retry` normalizes Windows, macOS, and Linux
process execution. Direct `argv` execution is the default (`shell: false`). Shell
execution is explicit and destructive shell commands require an approval reference.
Every run produces a bounded stdout/stderr digest, exit status, adapter reference, and
Craft event receipt.

## Durable work and context

Durable runs use persisted queue state, leases, heartbeats, recovery, cancellation,
and completion. Context Manifest binds the goal, project, knowledge, capabilities,
workflows, host, model, budget, and acceptance reference. Capability Projection loads
only the capabilities needed by the current step and token budget.

## Trust, acceptance, and portability

Delivery is independent of model or process self-report. Artifacts and Evidence must
pass a delivery gate before an Outcome is accepted. Trust curves turn scoped evidence
into an autonomy suggestion; they never grant authority. Project Bundle and Task
Handoff manifests allow a project to move between hosts without losing provenance.

## OpenAPI and third-party packages

OpenAPI documents can be imported into a governed read/write adapter contract. GET and
HEAD operations are read effects; write operations remain external effects and must be
approved by the host policy. JavaScript/TypeScript packages must ship their locked,
self-contained dependencies; runtime installation is refused. MCP remains the
model-facing tool protocol, while Plugin is the distribution layer and Adapter is the
execution boundary.
