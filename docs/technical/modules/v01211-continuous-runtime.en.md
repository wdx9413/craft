# v0.12.11 Continuous Work Runtime

v0.12.11 closes the product gap between Project Brain, Work Session, Trace, durable waits, and host adapters:

```text
Project Brain
  → Context Manifest
  → Work Session / Host
  → Trace / Evidence / Outcome
  → Replay / Resume / Handoff
  → Project Bundle / Feedback / Cost
```

The release adds a digest-pinned Context Manifest, a revalidation-gated Replay Runner, persistent local runtime service state, portable Project Bundles, scoped Feedback Signals, user-defined metric Domain Evaluators, host-neutral Handoff Manifests, and provider price/usage Cost Ledger attribution.

Replay without a registered executor is explicitly a dry-run receipt. Existing Store records remain readable, `craft.trace.v1` remains accepted for compatibility, and no automatic experience publication is introduced. OS-level isolation, system schedulers, notifications, remote object storage, and business-quality scorers remain deployment adapters.
