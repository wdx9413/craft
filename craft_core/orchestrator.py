from __future__ import annotations

from typing import Any


EXTERNAL_STATES = {
    "agent": "awaiting_agent",
    "judge": "awaiting_model_judge",
    "human": "awaiting_human",
}
TERMINALS = {"passed", "failed", "transition_limit"}


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
        normalized.append(step)
    return normalized


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
        "context": context,
    }


def normalize_submission(step: dict[str, Any], result: dict[str, Any]) -> tuple[str, str]:
    kind = step.get("type")
    if kind == "human":
        if "approved" not in result:
            raise ValueError("Human submissions require approved=true or false")
        verdict = "passed" if result["approved"] is True else "rejected"
        return verdict, "human_approved" if verdict == "passed" else "human_rejected"
    verdict = result.get("verdict", "passed" if kind == "agent" else None)
    if verdict not in {"passed", "failed", "unknown"}:
        raise ValueError("Model submissions require verdict passed, failed, or unknown")
    return str(verdict), "model_judged" if kind == "judge" else "agent_reported"
