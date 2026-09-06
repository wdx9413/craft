from __future__ import annotations

import logging
import os
import sys
from typing import Any


LOGGER_NAME = "craft"


def get_logger() -> logging.Logger:
    """Return Craft's stderr logger without touching MCP stdout."""
    logger = logging.getLogger(LOGGER_NAME)
    if not any(getattr(handler, "_craft_handler", False) for handler in logger.handlers):
        handler = logging.StreamHandler(sys.stderr)
        handler._craft_handler = True  # type: ignore[attr-defined]
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s craft %(message)s"))
        logger.addHandler(handler)
        logger.propagate = False
    level_name = os.environ.get("CRAFT_LOG_LEVEL", "INFO").upper()
    logger.setLevel(getattr(logging, level_name, logging.INFO))
    return logger


def log_event(
    logger: logging.Logger, event: str, *, level: int = logging.INFO, **fields: Any
) -> None:
    """Log only caller-selected metadata; never serialize request bodies implicitly."""
    suffix = " ".join(f"{key}={value}" for key, value in fields.items() if value is not None)
    logger.log(level, "event=%s%s", event, f" {suffix}" if suffix else "")
