# Craft Codex Plugin

This is the complete Craft composition plugin. Install `craft` when the user wants the whole product: Core, Knowledge, Memory, Capability discovery, Skill Quality, and Workflow Evolution are all included in the same bundled runtime and share one Craft data store.

On a fresh data store, call `craft_knowledge_bootstrap_install` once from the
primary plugin to register the built-in Craft Evidence Wiki and the bounded
Serena project-knowledge descriptor. The operation is idempotent. It does not
scan Serena, ingest external files, or save conversation content: durable
knowledge and memories still require their normal evidence-aware operations.

Its default MCP remains small on purpose: it exposes the route contract plus a fixed syscall vocabulary, rather than hundreds of schemas. `craft_describe` resolves an exact resource and operation, then the syscall verb reaches the corresponding built-in capability. This means that installing `craft` is sufficient to use memory, knowledge, capability discovery, evaluation, and Workflow Evolution; installing a sibling plugin is not a prerequisite.

The sibling plugins are optional standalone projections of the same runtime. Install `craft-knowledge`, `craft-memory`, `craft-capability`, `craft-skill-quality`, or `craft-workflow-evolution` *instead of* the complete plugin when a Host needs only one bounded domain surface. `craft-knowledge` and `craft-memory` both expose the same safe bootstrap for their shared built-in provenance. Avoid enabling an overlapping sibling alongside `craft` unless the Host explicitly needs the duplicate direct tool surface.

Run `pnpm run pack:plugin` from the repository root after building the MCP bundles. Desktop applications, host-adapter archives, source maps, and general CLI build output belong in GitHub Releases or build artifacts, never in this package.
