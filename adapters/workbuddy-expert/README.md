# Craft WorkBuddy Expert

Upload this package only through WorkBuddy's **Expert** creation flow. It is deliberately separate from `workbuddy-connector/`: an Expert needs `.codebuddy-plugin/plugin.json`, an Agent definition, and a PNG avatar; a Connector instead starts with `connector-meta.json`.

## Before upload

Install Craft on the machine that will run the local MCP dependency:

```bash
npm install -g github:wdx9413/craft
craft init --mode provider
```

The Expert declares one local stdio dependency, `craft-mcp-full`. On first summon, WorkBuddy should present the connection dependency. This package does not embed a Craft binary or credentials.

## Boundaries

This is a local Expert package, not an assertion that Craft has passed WorkBuddy marketplace review. A cloud Expert needs a separately deployed HTTPS MCP adapter and tenant-safe state handling; do not use this local command for cloud-only work.
