# Current Capability Matrix (v0.12.11)

| Area | State | Boundary |
|---|---|---|
| Project Brain / Work Session | implemented and tested locally | editable goal/decision/material kernels plus a digest-pinned Context Manifest; Markdown remains source of truth |
| Default Internal Host tools | implemented and tested | five bounded syscall actions; external tools remain explicitly routed through MCP/Host adapters |
| CLI `run` vertical slice | implemented and tested locally | creates/continues Project Brain + Work Session and records outcome; model/provider credentials remain deployment configuration |
| Workbench project experience | implemented locally | read-only projection routes for Brain, sessions, traces and checkpoints; native desktop shell is separate packaging work |
| Context selection | implemented | exact references and digests; vector search remains optional |
| Trace / Workbench projection | implemented locally | controlled Replay Runner now revalidates the terminal Trace and records step receipts; external effect executors remain deployment adapters |
| Long-task recovery | implemented protocol | fresh Host dispatch is required after process release |
| OTel / OTLP | implemented adapter contract | deployment collector is external |
| OS sandbox / Secret Broker | local contracts and probes | production isolation requires a platform adapter |
| A2A / organization sync | digest-only transport and local conflict rules | remote identity, storage, and policy require deployment evidence |
| MCP Registry sync | implemented adapter | HTTPS pull and local ingest only; signature, moderation, health scheduling and official registry policy remain deployment governance |
| Durable checkpoint tick | implemented locally | expiry/wake processing is bounded; v0.12.11 adds persistent local runtime service state, while OS scheduler and notification delivery remain adapters |
| Project Bundle / Handoff | implemented locally | digest-verified portable references preserve project continuity without copying raw business content |
| Feedback / Domain Evaluation / Cost | implemented locally | scoped feedback, metric-based domain evaluator contracts, and provider price/usage attribution are recorded; business-specific scorers remain external |
| Automatic experience publication | not automatic | Evaluation, Signoff, Canary, and human publication remain mandatory |
