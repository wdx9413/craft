from __future__ import annotations

from typing import Any

from .orchestrator import SIDE_EFFECTS


PROVENANCE = {
    "agent_reported", "model_judged", "program_verified",
    "human_approved", "human_rejected",
}


def normalize_orchestration_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not nodes:
        raise ValueError("At least one orchestration node is required")
    normalized: list[dict[str, Any]] = []
    identifiers: set[str] = set()
    for position, original in enumerate(nodes):
        if not isinstance(original, dict):
            raise ValueError(f"Orchestration node at index {position} must be an object")
        node_id = str(original.get("id", "")).strip()
        role = str(original.get("role", "")).strip()
        objective = str(original.get("objective", "")).strip()
        if not node_id or not role or not objective:
            raise ValueError(f"Orchestration node at index {position} requires id, role, and objective")
        if node_id in identifiers:
            raise ValueError(f"Duplicate orchestration node id: {node_id}")
        identifiers.add(node_id)
        dependencies = original.get("depends_on", [])
        routes = original.get("profile_ids", [])
        if not isinstance(dependencies, list) or not all(isinstance(item, str) for item in dependencies):
            raise ValueError(f"Node {node_id} depends_on must contain strings")
        if not isinstance(routes, list) or not routes or not all(isinstance(item, str) and item for item in routes):
            raise ValueError(f"Node {node_id} profile_ids must contain at least one profile ID")
        if len(set(routes)) != len(routes):
            raise ValueError(f"Node {node_id} profile_ids must be unique")
        effect = str(original.get("side_effect", "read_only"))
        if effect not in SIDE_EFFECTS:
            raise ValueError(f"Unsupported side effect for {node_id}: {effect}")
        normalized.append({
            "id": node_id,
            "role": role,
            "objective": objective,
            "depends_on": dependencies,
            "profile_ids": routes,
            "side_effect": effect,
            "input": original.get("input", {}),
            "output_schema": original.get("output_schema", {}),
            "evidence_required": original.get("evidence_required", []),
        })
    for node in normalized:
        for dependency in node["depends_on"]:
            if dependency == node["id"]:
                raise ValueError(f"Node {node['id']} cannot depend on itself")
            if dependency not in identifiers:
                raise ValueError(f"Node {node['id']} has unknown dependency: {dependency}")
    _reject_cycles(normalized)
    return normalized


def _reject_cycles(nodes: list[dict[str, Any]]) -> None:
    dependencies = {node["id"]: node["depends_on"] for node in nodes}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node_id: str) -> None:
        if node_id in visiting:
            raise ValueError(f"Orchestration plan contains a dependency cycle at: {node_id}")
        if node_id in visited:
            return
        visiting.add(node_id)
        for dependency in dependencies[node_id]:
            visit(dependency)
        visiting.remove(node_id)
        visited.add(node_id)

    for identifier in dependencies:
        visit(identifier)


def plan_status(nodes: list[dict[str, Any]]) -> str:
    statuses = {node["status"] for node in nodes}
    if statuses == {"passed"}:
        return "completed"
    if "leased" in statuses or "pending" in statuses:
        return "running"
    return "failed"
