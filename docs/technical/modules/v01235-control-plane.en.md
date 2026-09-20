# v0.12.35 Control Plane Closure

Craft keeps `VerifiedWorkLoop` as the only public orchestrator. This release adds a runtime-fact seam, an explained Context Working Set, versioned Workbench commands, capability intake governance, and analysis-only Graph compilation. No new executor is introduced.

`RuntimeExecutionAttemptKernel` binds task, loop, run, host, environment, effect, and idempotency facts. `effect_unknown` is reconciled and never replayed automatically. `ContextWorkingSetKernel` keeps host history and current state distinct from accumulated knowledge, memory, and experience. `CapabilityIntakeKernel` treats discovered, scanned, approved, and active as different states. `GraphCompilerKernel` lowers a validated graph to a `VerifiedWorkLoop` plan only.

The module test group reaches 100% incremental line, function, and branch coverage. Host and business-value claims still require real Reference Pilot evidence.
