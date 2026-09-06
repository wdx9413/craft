from __future__ import annotations

from typing import Any


EXTERNAL_STATES = {
    "agent": "awaiting_agent",
    "judge": "awaiting_model_judge",
    "human": "awaiting_human",
}
TERMINALS = {"passed", "failed", "transition_limit"}
SIDE_EFFECTS = ("read_only", "local_write", "external_write", "destructive")


def normalize_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    identifiers: set[str] = set()
    for index, original in enumerate(steps):
        step = dict(original)
        step_id = str(step.get("id") or f"step_{index + 1}")
        if step_id in identifiers:
            raise ValueError(f"Duplicate workflow step id: {step_id}")
        identifiers.add(step_id)
        step["id"] = step_id
        effect = str(step.get("side_effect") or ("local_write" if step.get("type") == "command" else "read_only"))
        if effect not in SIDE_EFFECTS:
            raise ValueError(f"Unsupported side effect for {step_id}: {effect}")
        step["side_effect"] = effect
        normalized.append(step)
    return normalized


def compile_invariants(invariants: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Compile declarative outcome properties into ordinary workflow steps."""
    compiled: list[dict[str, Any]] = []
    for index, original in enumerate(invariants):
        if not isinstance(original, dict):
            raise ValueError("Workflow invariants must be objects")
        invariant = dict(original)
        invariant_id = str(invariant.get("id") or f"invariant_{index + 1}")
        statement = str(invariant.get("statement") or "").strip()
        enforcement = str(invariant.get("enforcement") or "model")
        if not statement:
            raise ValueError(f"Invariant {invariant_id} requires a statement")
        if enforcement == "program":
            validator = invariant.get("validator")
            if not isinstance(validator, dict):
                raise ValueError(f"Program invariant {invariant_id} requires a validator")
            step = {**validator, "id": invariant_id}
        elif enforcement == "model":
            step = {
                "id": invariant_id,
                "type": "judge",
                "objective": f"Determine whether this invariant holds: {statement}",
                "rubric": invariant.get("rubric") or [statement],
            }
        elif enforcement == "human":
            step = {"id": invariant_id, "type": "human", "objective": statement}
        else:
            raise ValueError(f"Unsupported invariant enforcement: {enforcement}")
        step["invariant"] = statement
        step["evidence_required"] = invariant.get("evidence_required", [])
        step["side_effect"] = invariant.get("side_effect", "read_only")
        compiled.append(step)
    return compiled


def approved_effects(allow_execution: bool, effects: list[str] | None) -> set[str]:
    approved = {"read_only"}
    if allow_execution:
        approved.add("local_write")
    for effect in effects or []:
        if effect not in SIDE_EFFECTS:
            raise ValueError(f"Unsupported approved side effect: {effect}")
        approved.add(effect)
    return approved


def next_cursor(
    steps: list[dict[str, Any]], cursor: int, verdict: str
) -> tuple[int, str | None]:
    step = steps[cursor]
    mapping = step.get("on_result") or {}
    target = mapping.get(verdict, step.get("next"))
    if target in {"end", "passed"}:
        return len(steps), "passed"
    if target in {"fail", "failed"}:
        return cursor, "failed"
    if target is None:
        if verdict in {"failed", "rejected", "unknown"}:
            return cursor, "failed"
        return cursor + 1, None
    for index, candidate in enumerate(steps):
        if candidate["id"] == target:
            return index, None
    raise ValueError(f"Unknown workflow transition target: {target}")


def external_request(step: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    kind = str(step.get("type"))
    if kind not in EXTERNAL_STATES:
        raise ValueError(f"Step is not externally executed: {kind}")
    return {
        "step_id": step["id"],
        "type": kind,
        "objective": step.get("objective", ""),
        "rubric": step.get("rubric", []),
        "tools": step.get("tools", []),
        "output_schema": step.get("output_schema", {}),
        "evidence_required": step.get("evidence_required", []),
        "side_effect": step.get("side_effect", "read_only"),
        "context": context,
    }


def normalize_submission(step: dict[str, Any], result: dict[str, Any]) -> tuple[str, str]:
    kind = step.get("type")
    if step.get("evidence_required") and not result.get("evidence"):
        raise ValueError("This step requires evidence references")
    if kind == "human":
        if "approved" not in result:
            raise ValueError("Human submissions require approved=true or false")
        verdict = "passed" if result["approved"] is True else "rejected"
        return verdict, "human_approved" if verdict == "passed" else "human_rejected"
    verdict = result.get("verdict", "passed" if kind == "agent" else None)
    if verdict not in {"passed", "failed", "unknown"}:
        raise ValueError("Model submissions require verdict passed, failed, or unknown")
    return str(verdict), "model_judged" if kind == "judge" else "agent_reported"
