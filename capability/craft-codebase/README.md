# @craft/capability-codebase

Standalone codebase kernel package. Depends on `craft-common-store-local`, `craft-common-base`, and `craft-common-log`; it does not depend on `craft-agent-harness`. Import the capability descriptor and register it with a `CraftStore` and optional `CraftTelemetry` via `CORE_KERNELS`. The existing Skill and MCP plugin remains the Host-facing surface.

`./repository-onboarding` exports `ensureRepository` and its host-neutral Workspace/checkpoint ports. Source discovery runs before the publication transaction; unchanged include paths are not rewritten. A task query prioritizes bounded file selection. `./context-search` provides ranked path/symbol candidates and explicit Chinese intent aliases. These are lexical hints, not a completeness guarantee.

`node scripts/codebase/adapter-preflight.ts` reports Python/Jedi, Java LSP and Go LSP availability separately from semantic conformance. Use checkpoint-pinned analyzer fixtures and `analysis_import` to accept language facts; merely having a language executable is insufficient.

`CodebaseIndexKernel.contextProjection` owns index eligibility, bounded lexical/dependency candidates, required-node completion and normalized snapshot-pinned references. `assertContextProjectionCurrent` rechecks index/workspace/activation revisions and selected file digests after Context awaits. Context consumes candidates through these SDK methods and keeps shared budget/receipt selection; it no longer reads `codebase_index` or assembles node references. Codebase remains a task projection, not an accumulated Memory/Knowledge/Experience member.
