# Craft Codex Plugin

This is the complete Craft composition plugin. It intentionally contains only the manifest, the route-first Skill, and the core/full bundled MCP entry points. In Codex the current app is the embedded execution host; it does not start a second Codex CLI.

Install `craft-knowledge`, `craft-memory`, `craft-capability`, or `craft-skill-quality` instead when only one bounded component is needed.

Run `pnpm run pack:plugin` from the repository root after building the MCP bundles. Desktop applications, host-adapter archives, source maps, and general CLI build output belong in GitHub Releases or build artifacts, never in this package.
