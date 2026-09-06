from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any


PLUGIN_ITEMS = (
    ".claude-plugin",
    ".codex-plugin",
    "craft_core",
    "scripts",
    "skills",
    ".mcp.json",
    "LICENSE",
    "README.md",
    "README.en.md",
    "docs",
    "pyproject.toml",
)


def resolved_python(executable: str | None = None) -> str:
    candidate = Path(executable or sys.executable).resolve()
    if not candidate.is_file():
        raise ValueError(f"Python executable does not exist: {candidate}")
    return str(candidate)


def mcp_config(executable: str | None = None) -> dict[str, Any]:
    return {
        "mcpServers": {
            "craft": {
                "command": resolved_python(executable),
                "args": ["./scripts/craft_mcp.py"],
                "cwd": ".",
            }
        }
    }


def install_plugin(
    source_root: Path,
    target_root: Path,
    executable: str | None = None,
) -> dict[str, str]:
    source_root = source_root.resolve()
    target_root = target_root.expanduser().resolve()
    protected = {Path.home().resolve(), Path(target_root.anchor).resolve()}
    if target_root in protected or source_root == target_root or source_root.is_relative_to(target_root):
        raise ValueError("Install target must be a dedicated directory outside the source tree")
    target_root.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".craft-install-", dir=target_root.parent) as temp:
        stage = Path(temp) / "craft"
        stage.mkdir()
        for name in PLUGIN_ITEMS:
            source = source_root / name
            if not source.exists():
                raise ValueError(f"Plugin item is missing: {source}")
            destination = stage / name
            if source.is_dir():
                shutil.copytree(
                    source,
                    destination,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".coverage"),
                )
            else:
                shutil.copy2(source, destination)
        (stage / ".mcp.json").write_text(
            json.dumps(mcp_config(executable), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        backup = Path(temp) / "previous"
        if target_root.exists():
            target_root.replace(backup)
        try:
            shutil.copytree(stage, target_root)
        except Exception:
            if target_root.exists():
                shutil.rmtree(target_root)
            if backup.exists():
                backup.replace(target_root)
            raise
    return {
        "plugin_root": str(target_root),
        "python": resolved_python(executable),
        "data_root": str((Path.home() / ".craft_data").resolve()),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Install a platform-resolved Craft plugin copy"
    )
    parser.add_argument(
        "--target",
        default=str(Path.home() / "plugins" / "craft"),
        help="Installed plugin directory (default: ~/plugins/craft)",
    )
    args = parser.parse_args()
    source_root = Path(__file__).resolve().parents[1]
    result = install_plugin(source_root, Path(args.target))
    print(json.dumps(result, ensure_ascii=False, indent=2))
