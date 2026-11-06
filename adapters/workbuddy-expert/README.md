# Craft WorkBuddy Expert

Upload this package only through WorkBuddy's **Expert** creation flow. It is deliberately separate from `workbuddy-connector/`: an Expert needs `.codebuddy-plugin/plugin.json`, an Agent definition, and a PNG avatar; a Connector instead starts with `connector-meta.json`.

## Self-contained MCP entry

The archive ships the bundled, dependency-free syscall MCP at `bin/craft-mcp.cjs` and points at it through the plugin root variable:

```json
"command": "node",
"args": ["${CODEBUDDY_PLUGIN_ROOT}/bin/craft-mcp.cjs"]
```

Nothing has to be installed beforehand: no globally installed `craft-mcp` on `PATH`, and no `node_modules` beside the archive. The only assumption is a `node` executable on `PATH`, which is the same assumption WorkBuddy's own bundled plugins make.

The Expert declares one local stdio dependency, `craft-mcp`, the route-first syscall surface. On first summon, WorkBuddy should present the connection dependency. It packages exactly one default Skill, `craft-route`, which chooses the smallest governed path; a separately configured `craft-mcp-full` remains available only for user-approved capability administration.

## Optional: CLI and state

Installing Craft separately is only needed to drive it from a shell or to prepare the state directory:

```bash
npm install -g github:wdx9413/craft
craft init --mode provider
```

State lives in `~/.craft_data` unless `CRAFT_DATA_DIR` overrides it. The MCP server itself starts without this step.

## Rebuilding this archive

```bash
pnpm run build:plugin && pnpm run pack:adapters
```

`scripts/pack-adapters.ts` re-reads `.mcp.json` and fails when it points anywhere other than the entry the script packages, so the config and the archive cannot drift apart.

## Boundaries

This is a local Expert package, not an assertion that Craft has passed WorkBuddy marketplace review. A cloud Expert needs a separately deployed HTTPS MCP adapter and tenant-safe state handling; do not use this local command for cloud-only work.
