# Craft for TraeWork

This is an integration package, not a TraeWork marketplace listing. It exposes Craft's complete MCP API and two small, on-demand Skills without duplicating the Craft core.

## Local desktop MCP

1. Install Craft so its executables are on `PATH`:

   ```bash
   npm install -g github:wdx9413/craft
   craft init
   ```

2. In TraeWork Desktop, choose **Settings → MCP → Local → Create → Manual configuration**, then paste [`mcp.json`](mcp.json). It starts `craft-mcp-full`, the complete compatibility surface.
3. If the host has limited tool selection or the task only needs routing, search, Task, Evidence, and Activation operations, import [`mcp-core.json`](mcp-core.json) instead.

The local stdio process can serve only desktop-local tasks. TraeWork web/cloud tasks need a separately deployed HTTPS MCP adapter; do not point cloud work at a local path or claim the local database is shared with the cloud.

## Skills

Upload either folder in [`skills/`](skills/) as a `.zip`/`.skill` package through the TraeWork Skills marketplace, or copy it under `.trae/skills/` in a local project. `craft` is a light routing entry point; `craft-clarify` only triggers for decision-changing ambiguity. Neither grants additional permissions.

## Safety and state

The MCP process writes to `~/.craft_data` by default. Set `CRAFT_DATA_DIR` before starting TraeWork if this host must use a separate Craft state directory. Craft never treats an unobserved completion claim as acceptance; host tool effects remain subject to TraeWork and user approval.
