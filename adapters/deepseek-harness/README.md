# Craft adapter for DeepSeek Harness

This Cordis bundle exposes Craft's MCP tools through one `craft_call` tool while
keeping Craft's Python core and `~/.craft_data` store independent of DSH.

Prerequisites: Node.js, DeepSeek Harness, `uv`, and a published
`craft-agent-harness==0.1.0` package.

Install the repository bundle directly from Git, preferably pinned to a tag or
commit:

```bash
dsh plugin --profile default add github:wdx9413/craft#main
```

During development, the standalone adapter directory can also be installed:

```bash
dsh plugin --profile default add ./adapters/deepseek-harness
```
