# Craft WorkBuddy Connector

This directory is a WorkBuddy **MCP + Skill** Connector submission package. It exposes one local stdio server, `craft-mcp-full`, so all Craft compatibility tools are available through one controlled provider endpoint.

## Local validation

Install Craft first:

```bash
npm install -g github:wdx9413/craft
craft init
```

Keep [`mcp.json`](mcp.json) unchanged and import/package this directory through WorkBuddy's Connector workflow. The connector assumes `craft-mcp-full` is on `PATH` and uses the local `~/.craft_data` state directory by default.

## Marketplace boundary

This package is submission-ready metadata, not a claim of marketplace availability. WorkBuddy still reviews a submitted Connector. Before broad distribution, provide either a controlled installer that makes `craft-mcp-full` available on supported machines, or a separately deployed HTTPS MCP adapter. A local stdio Connector cannot serve cloud-only tasks.

No credentials are bundled. Craft's existing policy, evidence, and approval checks remain in force; this connector neither auto-approves effects nor grants access to third-party sources.
