# Craft

Craft is a local-first capability catalog and task continuity layer for AI agents. Version 0.1 indexes user-selected `SKILL.md` libraries, stores explicit task checkpoints and feedback, and saves versioned workflow candidates. It ships as a Codex plugin, a Claude Code-compatible plugin, an MCP server, and a Python CLI.

The bundled `skills/craft` directory is Craft's own Codex entry skill. User or work skills stay in any external directories the user registers. Craft supports multiple sources, resolves source symlinks and Windows junctions to real paths, follows nested directory links with cycle detection, and stores the real file path for each indexed Skill.

Runtime data defaults to `~/.craft_data` and is never stored in the active project. `CRAFT_DATA_DIR` is available for isolated tests and managed deployments.

## Requirements

- Python 3.11 or newer.
- Windows for the bundled Codex MCP launcher in v0.1.
- Claude Code can load the same plugin on systems where `python` resolves to Python 3.11+.

## Python CLI

Install in an isolated environment:

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

The source commands also support `list-sources`, `scan`, `update-source`, and `remove-source`. Removing a source deletes only Craft's index entries, never the source files.

## Codex

The Codex manifest is `.codex-plugin/plugin.json`; it loads the Craft Skill and `.mcp.json`. Install the plugin from a local marketplace, start a new Codex conversation, then ask Craft to add a Skill directory or continue a saved task. The v0.1 Codex launcher uses the Windows `py` command.

## Claude Code

The Claude manifest is `.claude-plugin/plugin.json`; it selects `.mcp.claude.json`, which uses `${CLAUDE_PLUGIN_ROOT}` so the MCP process keeps working after plugin installation or caching. For local development:

```powershell
claude --plugin-dir .
```

Then inspect `/mcp` and invoke `/craft:craft`, or let Claude select the Skill from the task context.

## Test and coverage

```powershell
py -3 -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
.venv\Scripts\python -m coverage run -m unittest discover -s tests
.venv\Scripts\python -m coverage report
```

The repository enforces branch coverage with `fail_under = 90`.

`craft_capability_search` refreshes sources older than five minutes by default, then searches SQLite. It does not send the full library to Codex; only compact matches are returned, and the selected Skill is loaded separately.

## v0.1 boundary

Craft v0.1 is a local technical alpha. It does not yet synchronize remote Skill hubs, run vector retrieval, automatically promote workflows without user-visible agent calls, or provide a graphical interface. SQLite keyword search is the default; embedding providers remain an optional later adapter.
