# Multi-Agent runtime

An Agent Profile is versioned host/model metadata. A Plan node references one or more Profile IDs in fallback order and declares `id`, `role`, `objective`, `depends_on`, and `side_effect`. Craft resolves and pins each Profile version when the Plan is created; a later Profile edit cannot change an in-flight route.

Plans must be acyclic. Dispatch returns leases only for pending nodes whose dependencies passed and only within requested capacity. Submit `passed`, `failed`, or `blocked` with provenance. A failed node advances to its next Profile when available; a terminal failure blocks dependent pending nodes.

The host remains responsible for launching its native Agent and enforcing permissions. Craft coordinates and records; it does not impersonate Codex, Claude, or another runtime.

Use `craft_orchestration_trial_start` when the Plan should be evaluated. Trial-backed Plans append dispatch and node-submission events, including fallback attempts, provenance, numeric costs, and supplied Artifact/Evidence references. On `completed` or `failed`, Craft records an immutable receipt and Outcome automatically. If finalization was interrupted, call `craft_orchestration_trial_finalize`; repeated calls return the existing Outcome without duplicating it. Use ordinary Plan creation for transient coordination that should not become evaluation data.
