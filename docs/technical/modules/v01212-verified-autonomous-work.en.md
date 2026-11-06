# v0.12.12 Verified Autonomous Work

v0.12.12 joins the existing kernels into one verifiable autonomous-work path:

```text
Context Manifest
  → Verified Work Prepare
  → Action Authorization
  → Tool/Host Receipt
  → State Re-observation
  → Independent Acceptance
  → Delivery Gate
  → Outcome / Handoff / Resume
```

`VerifiedAutonomousWorkKernel` does not replace Codex, Claude, or another Host. It turns their actions into authorized, idempotent, re-observable facts. Write effects require explicit approval and a verified platform boundary; drift enters `needs_replan` instead of continuing with stale state.

`SandboxConformanceKernel` admits only conformance records with a verifier, isolation state, network state, and declared capabilities. It does not pretend to be an OS sandbox; real Windows/macOS/Linux backends must submit evidence from deployment adapters.

`TraceExplorerKernel` returns event metadata and digests only, never prompts, business bodies, or sensitive tool output. It is intended for Workbench filtering by task, host, state, and failure step.

Model self-reports, process exit codes, and Host `completed` receipts never create an Outcome by themselves; independent Acceptance, Artifacts, and Evidence remain required.
