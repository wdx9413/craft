# Craft for DeepSeek Harness

Build generates one self-contained Cordis plugin for each of `craft-context`, `craft-knowledge`, `craft-memory`, `craft-experience` and `craft-codebase` under `dist/adapters/dsh/` and `plugins/<product>/dsh/`.

Install the desired generated directory:

```sh
dsh plugin --profile default add /absolute/path/plugins/craft-context/dsh
```

Each product registers `craft_<product>_tools` for schema and Skill discovery, and `craft_<product>_call` for validated MCP calls. The bundled local runtime requires Node.js 23+ and works without Hooks or npm downloads. All products honor `CRAFT_DATA_DIR`, otherwise they share the normal Craft local data space.

The generic development adapter retains configurable `product`, `npxCommand`, `packageSpec`, `bundlePath` and `dataDir`. Choose a pinned packageSpec when using the npx fallback. Use the generated product directory for an offline installation.

The sibling `craft-common-use` installer also supports direct DSH Skill + MCP registration using its existing MCP loader. Local protocol tests do not prove a DSH model session loaded and used these tools; verify that in the target Host.
