from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class UsageMode:
    id: str
    name: str
    owns_agent_loop: bool
    relationship: str
    available_surfaces: tuple[str, ...]
    planned_surfaces: tuple[str, ...]
    status: str
    boundary: str

    def card(self) -> dict[str, Any]:
        result = asdict(self)
        result["available_surfaces"] = list(self.available_surfaces)
        result["planned_surfaces"] = list(self.planned_surfaces)
        return result


USAGE_MODES = {
    "standalone": UsageMode(
        "standalone", "Craft Agent", True, "Craft owns the conversation and agent loop",
        ("management-cli",), ("interactive-cli", "desktop"), "foundation",
        "Provider execution, streaming tool loop, credentials, and end-user UI are not implemented yet.",
    ),
    "supervisor": UsageMode(
        "supervisor", "Craft Supervisor", True,
        "Craft owns the task experience and delegates execution to Codex, Claude, DSH, or custom hosts",
        ("cli", "mcp"), ("desktop", "automatic-host-drivers"), "protocol-available",
        "Host-mediated leases work; native host process drivers still require compatibility certification.",
    ),
    "capability-provider": UsageMode(
        "capability-provider", "Craft Provider", False,
        "Another Agent owns the loop and calls Craft as a capability and state provider",
        ("codex-plugin", "claude-plugin", "mcp", "cli", "dsh-adapter"), (), "available",
        "The consuming host retains its own sandbox, approval, model, context, and execution policy.",
    ),
}


def usage_modes(mode: str | None = None) -> dict[str, Any]:
    if mode is not None:
        selected = USAGE_MODES.get(mode)
        if selected is None:
            raise ValueError(f"Unknown Craft usage mode: {mode}")
        return selected.card()
    return {"modes": [item.card() for item in USAGE_MODES.values()]}
