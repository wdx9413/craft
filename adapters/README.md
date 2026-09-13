# Host ecosystem adapters

These packages adapt the same Craft provider surface; they do not fork Craft state or its policy engine.

| Host | Package | Default MCP surface | Delivery state |
| --- | --- | --- | --- |
| TraeWork | [`trae-work/`](trae-work/README.md) | `craft-mcp` | Ready for route-first desktop import and Skill upload; `mcp-full.json` is the explicit advanced upgrade. |
| WorkBuddy | [`workbuddy-connector/`](workbuddy-connector/README.md) | `craft-mcp-full` | Explicit advanced Connector for complete compatibility; the archive carries its own bundled MCP entry, so no global install is required. Marketplace publication needs WorkBuddy review. |
| WorkBuddy Expert | [`workbuddy-expert/`](workbuddy-expert/README.md) | `craft-mcp` | Route-first Expert upload package; the archive carries its own bundled Core MCP entry, and the Expert still asks the user to connect that dependency on first summon. |

The two WorkBuddy packages resolve their MCP entry through the host's plugin-root variable (`${CODEBUDDY_PLUGIN_ROOT}/bin/...`), mirroring the `${CLAUDE_PLUGIN_ROOT}` convention the Claude adapter already uses. `pnpm run pack:adapters` builds both archives from `dist/plugin/` and fails when a package config points anywhere other than the entry it ships, so the archive and its config cannot drift apart.

Use `craft-mcp` and the single `craft-route` Skill by default. `craft` and `craft-clarify` are separate opt-in packages, not a default suite. Use `craft-mcp-full` only for a user-approved administrative action or a host integration that explicitly needs complete Craft compatibility. Both processes use the same local `~/.craft_data` store unless `CRAFT_DATA_DIR` is set.

## Registering a WorkBuddy MCP by hand

WorkBuddy desktop launches every CLI session with `--strict-mcp-config`, which makes the CLI ignore **file-based** MCP configuration — the user-level `mcp.json` and a project `.mcp.json` are both skipped. Only what the host injects into `--mcp-config` is live. Two files therefore matter:

| Role | Path |
| --- | --- |
| Declaration | `~/.workbuddy-ai/mcp.json` — the entry the host offers as a custom connector |
| Trust | `~/.workbuddy-ai/mcp-approvals.json` — an empty `{}` means nothing is trusted yet |

A declaration alone activates nothing. Open WorkBuddy → Connector management → **Custom connectors** (top right) → click **Trust** on `craft`. The host then injects the server, and the Core tools appear in the next session. `craft-route` can be installed independently under `~/.workbuddy-ai/skills/craft-route/`, but a Skill on its own never starts an MCP server.

Two consequences worth knowing before editing the entry:

- Trust is bound to a SHA-256 of `command` plus the sorted `args`, so changing either invalidates the approval and forces a re-trust. Keep the entry stable and point it at the bundled `dist/plugin/craft-mcp.cjs` rather than at a globally installed binary.
- The one-time auto-trust migration for previously enabled servers has already run (`~/.workbuddy-ai/connectors/<user>/connector-states.json` → `"mcpSecurityMigrated": true`), so a newly declared server is never trusted implicitly.

To start the server by hand, run the same entry point the config points at; it speaks MCP JSON-RPC on stdin/stdout and stays quiet until it receives a request:

```bash
node dist/plugin/craft-mcp.cjs
```
