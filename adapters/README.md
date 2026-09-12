# Host ecosystem adapters

These packages adapt the same Craft provider surface; they do not fork Craft state or its policy engine.

| Host | Package | Default MCP surface | Delivery state |
| --- | --- | --- | --- |
| TraeWork | [`trae-work/`](trae-work/README.md) | `craft-mcp` | Ready for route-first desktop import and Skill upload; `mcp-full.json` is the explicit advanced upgrade. |
| WorkBuddy | [`workbuddy-connector/`](workbuddy-connector/README.md) | `craft-mcp-full` | Explicit advanced Connector for complete compatibility; marketplace publication needs WorkBuddy review. |
| WorkBuddy Expert | [`workbuddy-expert/`](workbuddy-expert/README.md) | `craft-mcp` | Route-first Expert upload package; the Expert still needs its local MCP dependency connected. |

Use `craft-mcp` and the single `craft-route` Skill by default. `craft` and `craft-clarify` are separate opt-in packages, not a default suite. Use `craft-mcp-full` only for a user-approved administrative action or a host integration that explicitly needs complete Craft compatibility. Both processes use the same local `~/.craft_data` store unless `CRAFT_DATA_DIR` is set.
