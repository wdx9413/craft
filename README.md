# Craft

Craft is a local-first capability catalog and task continuity layer for AI agents. Version 0.1 indexes user-selected `SKILL.md` libraries, stores explicit task checkpoints and feedback, and saves versioned workflow candidates. It ships as a Codex plugin, a Claude Code-compatible plugin, an MCP server, and a Python CLI.

The bundled `skills/craft` directory is Craft's own Codex entry skill. User or work skills stay in any external directories the user registers. Craft supports multiple sources, resolves source symlinks and Windows junctions to real paths, follows nested directory links with cycle detection, and stores the real file path for each indexed Skill.

Runtime data defaults to `~/.craft_data` and is never stored in the active project. `CRAFT_DATA_DIR` is available for isolated tests and managed deployments.

## Requirements

- Python 3.11 or newer.
- Windows, macOS, or Linux.
- [`uv`](https://docs.astral.sh/uv/getting-started/installation/) when installing the MCP server through a marketplace.

## Python CLI

Install in an isolated environment on Windows:

```powershell
py -3 -m venv .venv
.venv\Scripts\python -m pip install -e .
```

Then run:

```powershell
craft info
craft add-source D:\path\to\skills
craft search "diagnose service failure"
```

On macOS or Linux:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/craft info
```

The source commands also support `list-sources`, `scan`, `update-source`, and `remove-source`. Removing a source deletes only Craft's index entries, never the source files.

## Codex

The Codex manifest is `.codex-plugin/plugin.json`; it loads the Craft Skill and `.mcp.json`. The GitHub repository is also a Codex marketplace through `.agents/plugins/marketplace.json`.

After `craft-agent-harness==0.1.0` is published to PyPI:

1. Install `uv` and make sure `uvx --version` succeeds in the environment that launches Codex.
2. Open `/plugins` in Codex and choose **Add Marketplace**.
3. Enter `https://github.com/wdx9413/craft` as the source, leave the path empty, and select `main` while testing or a release tag for a reproducible install.
4. Install Craft and start a new Codex session.

The marketplace MCP configuration runs `uvx --from craft-agent-harness==0.1.0 craft-mcp`. `uvx` creates and caches an isolated Python environment, while Craft continues to store runtime data under `~/.craft_data`.

For source development, create a platform-resolved local plugin copy instead. The installer records the exact Python executable that ran it, so the generated MCP config does not depend on `py`, `python`, or `python3` being present in a GUI application's `PATH`.

Windows:

```powershell
py -3 scripts/install_plugin.py
```

macOS or Linux:

```bash
python3 scripts/install_plugin.py
```

The default target is `~/plugins/craft`; `--target` can select another directory. Add that installed copy to a local marketplace, install Craft, and start a new Codex conversation before using its Skill and MCP tools.

## Claude Code

The Claude manifest is `.claude-plugin/plugin.json` and uses the same generated `.mcp.json`. Point Claude Code at the installed copy:

```bash
claude --plugin-dir ~/plugins/craft
```

Then inspect `/mcp` and invoke `/craft:craft`, or let Claude select the Skill from the task context.

## Test and coverage

```powershell
py -3 -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
.venv\Scripts\python -m coverage run -m unittest discover -s tests
.venv\Scripts\python -m coverage report
```

Use `.venv/bin/python` instead on macOS or Linux. GitHub Actions is configured to run the same coverage gate on Windows, macOS, and Linux with Python 3.11 and 3.13.

The repository enforces 100% statement and branch coverage with `fail_under = 100`.

## Marketplace sources

The repository includes a Codex marketplace at `.agents/plugins/marketplace.json`. It currently follows `main` for prerelease testing. Before announcing a stable release, change its `ref` to the corresponding Git tag after the exact Python package version is available on PyPI. A full commit `sha` can be used when installations must remain immutable.

`craft_capability_search` refreshes sources older than five minutes by default, then searches SQLite. It does not send the full library to Codex; only compact matches are returned, and the selected Skill is loaded separately.

## v0.1 boundary

Craft v0.1 is a local technical alpha. It does not yet synchronize remote Skill hubs, run vector retrieval, automatically promote workflows without user-visible agent calls, or provide a graphical interface. SQLite keyword search is the default; embedding providers remain an optional later adapter.
