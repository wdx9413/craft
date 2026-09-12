# Host ecosystem adapters

These packages adapt the same Craft provider surface; they do not fork Craft state or its policy engine.

| Host | Package | Default MCP surface | Delivery state |
| --- | --- | --- | --- |
| TraeWork | [`trae-work/`](trae-work/README.md) | `craft-mcp-full` | Ready for local desktop import and Skill upload; cloud needs HTTPS deployment. |
| WorkBuddy | [`workbuddy-connector/`](workbuddy-connector/README.md) | `craft-mcp-full` | Ready as a local Connector submission package; marketplace publication needs WorkBuddy review. |

Use `craft-mcp-full` only where the host can progressively select tools well and the user needs compatibility with the complete Craft API. The smaller `craft-mcp` is available as an explicit alternative. Both processes use the same local `~/.craft_data` store unless `CRAFT_DATA_DIR` is set.
