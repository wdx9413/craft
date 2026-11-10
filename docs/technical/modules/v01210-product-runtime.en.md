# v0.12.10 Product Runtime Vertical Slice

v0.12.10 connects Project Brain, Work Session, Runtime Truth, the Workbench projection, and durable waits into one path shared by the CLI, MCP, and host adapters:

```text
goal → Project Brain → Session (knowledge/capability/workflow/model/host refs)
     → bounded Internal Host / external Host Dispatch
     → Trace / Evidence / Artifact → Acceptance → Outcome → experience candidate
```

The release adds or closes these entry points:

- `craft run --project <id>` creates or resumes a project task and binds the Session to a dispatch before execution;
- the Internal Host exposes only five low-token, non-shell syscalls by default: capability search, knowledge search, checkpoint, evidence, and artifact;
- Workbench exposes read-only `/api/project-brain`, `/api/workbench-experience`, `/api/traces`, and `/api/long-task-checkpoints` projections;
- MCP Registry sync pulls a bounded page over HTTPS and records version/digest-bound local entries. It does not install, enable, or certify a remote server;
- A2A Transport supports digest-only HTTPS task get/cancel operations and never grants remote execution authority by default;
- the long-task worker has a bounded tick for expired waits and wake requests; resume still revalidates the Session and requires a fresh Host;
- Work Session can bind a dispatch while recording the session version and context digest, preventing stale context reuse.

Compatibility: legacy `craft.trace.v1` remains readable; existing Store records are not overwritten and new fields are optional. Skills, plugins, WorkBuddy Expert/Connector, and the DeepSeek Harness are aligned to v0.12.10, with route-first and low-token syscall defaults.

This release does not pretend to be an OS sandbox, an official Registry moderation service, a remote A2A identity system, organization cloud sync, a system scheduler, or a signed native desktop installer. Those capabilities remain adapters and require deployment evidence before being marked production-ready.

