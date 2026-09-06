from __future__ import annotations

import os
from pathlib import Path


def data_root() -> Path:
    """Return Craft's user data root.

    CRAFT_DATA_DIR exists for isolated tests and managed deployments. Normal
    users always get ~/.craft_data, independent of the active project.
    """
    override = os.environ.get("CRAFT_DATA_DIR")
    root = Path(override).expanduser() if override else Path.home() / ".craft_data"
    return root.resolve()


def ensure_layout() -> Path:
    root = data_root()
    for child in (root, root / "artifacts", root / "logs", root / "cache"):
        child.mkdir(parents=True, exist_ok=True)
    return root
