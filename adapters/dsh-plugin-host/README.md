# craft-dsh-plugin-host

This package is a Cordis bridge, not a second DSH runtime. Craft starts it with an
isolated `DSH_HOME` profile and talks to it over newline-delimited JSON-RPC stdio.

Supported methods:

- `initialize`
- `tools/list`
- `tools/call`
- `shutdown`

## What this bridge actually does

1. It keeps a resident DSH Cordis process for the isolated profile
   (`craft-plugin-host`) so DSH tool plugins installed through
   `POST /api/workbench/plugins/install` are registered on disk and visible to
   future DSH ACP sessions.
2. `tools/list` reflects tools registered in *this* plugin fiber. Because DSH
   scopes tool registration to each plugin's fiber, base DSH tools (pwsh, fs,
   web, …) live in a different fiber and are **not** reachable from here. The
   bridge therefore cannot call them, and it reports that honestly instead of
   pretending to be a tool proxy.
3. To execute a tool the model must run it **inside a DSH ACP session** (the
   `dsh` provider in the Workbench). Those sessions use the real `ctx.tools`
   runtime with full approval and policy gates.

UI-only Cordis services such as `slots`, `locale`, `webServer` and LLM provider
registration are intentionally outside this bridge. LLM provider plugins remain
usable inside a DSH ACP session.
