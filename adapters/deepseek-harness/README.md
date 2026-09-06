# Craft adapter for DeepSeek Harness

This Cordis bundle exposes Craft's MCP tools through one `craft_call` tool while
keeping Craft's TypeScript core and `~/.craft_data` store independent of DSH.

Prerequisites: Node.js 24+ and DeepSeek Harness. Craft is resolved as an npm package.

Install the repository bundle directly from Git, preferably pinned to a tag or
commit:

```bash
dsh plugin --profile default add github:wdx9413/craft#main
```

During development, the standalone adapter directory can also be installed:

```bash
dsh plugin --profile default add ./adapters/deepseek-harness
```
