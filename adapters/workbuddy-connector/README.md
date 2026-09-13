# Craft WorkBuddy Connector

This directory is a WorkBuddy **MCP + Skill** Connector submission package. It is the explicit advanced entry point: it exposes one local stdio server, `craft-mcp-full`, so complete Craft compatibility remains available through one controlled provider endpoint. It packages exactly one default Skill, `craft-route`, so the model still begins with the smallest governed route.

## Self-contained MCP entry

The archive ships the bundled, dependency-free Full MCP at `bin/craft-mcp-full.cjs` and points at it through the plugin root variable:

```json
"command": "node",
"args": ["${CODEBUDDY_PLUGIN_ROOT}/bin/craft-mcp-full.cjs"]
```

Keep [`mcp.json`](mcp.json) unchanged and import/package this directory through WorkBuddy's Connector workflow. Nothing has to be installed beforehand: no globally installed `craft-mcp-full` on `PATH`, and no `node_modules` beside the archive. State uses the local `~/.craft_data` directory by default.

Use the separate Expert package for normal route-first work; use this Connector only when the approved task truly needs the complete administrative surface.

## Rebuilding this archive

```bash
pnpm run build:plugin && pnpm run pack:adapters
```

`scripts/pack-adapters.ts` re-reads `mcp.json` and fails when it points anywhere other than the entry the script packages, so the config and the archive cannot drift apart.

## Marketplace boundary

This package is submission-ready metadata, not a claim of marketplace availability. WorkBuddy still reviews a submitted Connector. Because the archive now carries its own MCP entry, no controlled installer is required for local stdio use; a cloud deployment still needs a separately deployed HTTPS MCP adapter, since a local stdio Connector cannot serve cloud-only tasks.

No credentials are bundled. Craft's existing policy, evidence, and approval checks remain in force; this connector neither auto-approves effects nor grants access to third-party sources.
