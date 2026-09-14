# Craft Codex Plugin

This is the complete Craft composition plugin. It is the composition root: its bundled MCP already contains Core, Knowledge, Memory, Capability, Skill Quality, and Workflow Evolution surfaces. It intentionally contains only the manifest, the route-first Skill, icon assets, and the core/full bundled MCP entry points. In Codex the current app is the embedded execution host; it does not start a second Codex CLI.

The sibling plugins are optional projections of the same runtime, not dependencies that the complete plugin downloads or installs. Install `craft-knowledge`, `craft-memory`, `craft-capability`, `craft-skill-quality`, or `craft-workflow-evolution` instead when only one bounded component is needed.

Run `pnpm run pack:plugin` from the repository root after building the MCP bundles. Desktop applications, host-adapter archives, source maps, and general CLI build output belong in GitHub Releases or build artifacts, never in this package.
