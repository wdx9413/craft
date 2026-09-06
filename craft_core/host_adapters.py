from __future__ import annotations

import shutil
from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class HostCapabilities:
    skills: bool
    mcp: bool
    subagents: bool
    hooks: bool
    session_resume: bool
    artifact_input: bool
    approval: bool


@dataclass(frozen=True)
class HostAdapter:
    host: str
    executable: str | None
    integration: str
    capabilities: HostCapabilities

    def probe(self) -> dict[str, Any]:
        resolved = shutil.which(self.executable) if self.executable else None
        return {
            "host": self.host,
            "available": self.executable is None or resolved is not None,
            "executable": resolved,
            "integration": self.integration,
            "capabilities": asdict(self.capabilities),
        }


ADAPTERS = {
    "codex": HostAdapter(
        "codex", "codex", "plugin+mcp",
        HostCapabilities(True, True, True, True, True, True, True),
    ),
    "claude-code": HostAdapter(
        "claude-code", "claude", "plugin+mcp",
        HostCapabilities(True, True, True, True, True, True, True),
    ),
    "deepseek-harness": HostAdapter(
        "deepseek-harness", "dsh", "cordis-plugin",
        HostCapabilities(True, False, True, True, True, True, True),
    ),
    "generic-mcp": HostAdapter(
        "generic-mcp", None, "mcp",
        HostCapabilities(False, True, False, False, False, True, False),
    ),
}


def probe_adapters(host: str | None = None) -> dict[str, Any]:
    if host is not None:
        adapter = ADAPTERS.get(host)
        if adapter is None:
            raise ValueError(f"Unknown host adapter: {host}")
        return adapter.probe()
    return {"adapters": [adapter.probe() for adapter in ADAPTERS.values()]}
