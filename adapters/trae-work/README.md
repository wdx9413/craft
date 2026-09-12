# Craft for TraeWork

This is an integration package, not a TraeWork marketplace listing. It exposes Craft's route-first Core MCP by default, with an explicit Full-MCP upgrade, and small on-demand Skills without duplicating the Craft core.

## Local desktop MCP

1. Install Craft so its executables are on `PATH`:

   ```bash
   npm install -g github:wdx9413/craft
   craft init
   ```

2. In TraeWork Desktop, choose **Settings → MCP → Local → Create → Manual configuration**, then paste [`mcp.json`](mcp.json). It starts `craft-mcp`, the route-first Core surface.
3. [`mcp-core.json`](mcp-core.json) is a backward-compatible copy of the same Core setup. Import [`mcp-full.json`](mcp-full.json) only when a user-approved administrative operation needs complete Craft compatibility.

The local stdio process can serve only desktop-local tasks. TraeWork web/cloud tasks need a separately deployed HTTPS MCP adapter; do not point cloud work at a local path or claim the local database is shared with the cloud.

## Skills

Upload [`skills/craft-route/`](skills/craft-route/) as the default `.zip`/`.skill` package through the TraeWork Skills marketplace, or copy it under `.trae/skills/` in a local project. `craft` and `craft-clarify` remain separate optional packages for teams that deliberately want their longer governance or clarification contracts; do not install all three by default. None grants additional permissions.

## Safety and state

The MCP process writes to `~/.craft_data` by default. Set `CRAFT_DATA_DIR` before starting TraeWork if this host must use a separate Craft state directory. Craft never treats an unobserved completion claim as acceptance; host tool effects remain subject to TraeWork and user approval.
