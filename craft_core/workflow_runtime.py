from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any


PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
SENSITIVE = re.compile(
    r"(?i)((?:authorization\s*:\s*bearer|api[_-]?key|token|password|secret|cookie)\s*[=:]?\s*)\S+"
)


def resolve_inputs(definitions: list[dict[str, Any]], supplied: dict[str, Any]) -> dict[str, Any]:
    resolved = dict(supplied)
    for definition in definitions:
        name = definition.get("name")
        if not isinstance(name, str) or not name:
            raise ValueError("Each workflow input requires a non-empty name")
        if name not in resolved and "default" in definition:
            resolved[name] = definition["default"]
        if definition.get("required") and name not in resolved:
            raise ValueError(f"Missing required workflow input: {name}")
    return resolved


def substitute(value: Any, inputs: dict[str, Any]) -> Any:
    if isinstance(value, list):
        return [substitute(item, inputs) for item in value]
    if isinstance(value, dict):
        return {key: substitute(item, inputs) for key, item in value.items()}
    if not isinstance(value, str):
        return value
    full = PLACEHOLDER.fullmatch(value)
    if full:
        name = full.group(1)
        if name not in inputs:
            raise ValueError(f"Unknown workflow input: {name}")
        return inputs[name]

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in inputs:
            raise ValueError(f"Unknown workflow input: {name}")
        return str(inputs[name])

    return PLACEHOLDER.sub(replace, value)


def safe_path(root: Path, relative: str = ".") -> Path:
    candidate = (root / relative).resolve()
    if candidate != root and not candidate.is_relative_to(root):
        raise ValueError(f"Workflow path escapes project root: {relative}")
    return candidate


def redact_output(value: str, secrets: list[str] | None = None) -> str:
    result = SENSITIVE.sub(r"\1[REDACTED]", value)
    for secret in secrets or []:
        if len(secret) >= 4:
            result = result.replace(secret, "[REDACTED]")
    return result


def command_step(step: dict[str, Any], root: Path) -> dict[str, Any]:
    command = step.get("command")
    if not isinstance(command, list) or not command or not all(isinstance(item, str) for item in command):
        raise ValueError("Command steps require a non-empty string array in command")
    cwd = safe_path(root, str(step.get("cwd", ".")))
    if not cwd.is_dir():
        raise ValueError(f"Workflow command cwd does not exist: {cwd}")
    timeout = max(1, min(int(step.get("timeout_seconds", 300)), 3600))
    environment = os.environ.copy()
    secrets: list[str] = []
    for key, value in (step.get("env") or {}).items():
        environment[str(key)] = str(value)
        if any(marker in str(key).casefold() for marker in ("token", "password", "secret", "key", "cookie")):
            secrets.append(str(value))
    try:
        process = subprocess.run(
            command, cwd=cwd, env=environment, text=True, capture_output=True,
            timeout=timeout, check=False,
        )
        expected = int(step.get("expected_exit_code", 0))
        return {
            "passed": process.returncode == expected,
            "exit_code": process.returncode,
            "expected_exit_code": expected,
            "stdout": redact_output(process.stdout[-12000:], secrets),
            "stderr": redact_output(process.stderr[-12000:], secrets),
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "passed": False, "error": "timeout", "timeout_seconds": timeout,
            "stdout": redact_output((exc.stdout or "")[-12000:], secrets),
            "stderr": redact_output((exc.stderr or "")[-12000:], secrets),
        }


def _git_changed_lines(root: Path, baseline: str) -> dict[Path, set[int]]:
    diff = subprocess.run(
        ["git", "diff", "--unified=0", "--no-color", baseline, "--"],
        cwd=root, text=True, capture_output=True, timeout=60, check=False,
    )
    if diff.returncode:
        raise ValueError(f"Unable to diff baseline {baseline}: {diff.stderr.strip()}")
    changed: dict[Path, set[int]] = {}
    current: Path | None = None
    for line in diff.stdout.splitlines():
        if line.startswith("+++ b/"):
            current = (root / line[6:]).resolve()
        elif line.startswith("+++ /dev/null"):
            current = None
        elif current:
            match = HUNK.match(line)
            if match:
                start = int(match.group(1))
                count = int(match.group(2) or "1")
                changed.setdefault(current, set()).update(range(start, start + count))
    untracked = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard"],
        cwd=root, text=True, capture_output=True, timeout=60, check=False,
    )
    if untracked.returncode:
        raise ValueError(f"Unable to list untracked files: {untracked.stderr.strip()}")
    for name in untracked.stdout.splitlines():
        changed.setdefault((root / name).resolve(), set())
    return changed


def coverage_gate(step: dict[str, Any], root: Path) -> dict[str, Any]:
    report_path = safe_path(root, str(step.get("report", "coverage.json")))
    if not report_path.is_file():
        raise ValueError(f"Coverage report does not exist: {report_path}")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    baseline = str(step.get("baseline", "HEAD"))
    changed = _git_changed_lines(root, baseline)
    total_lines: set[tuple[str, int]] = set()
    covered_lines: set[tuple[str, int]] = set()
    total_branches: set[tuple[str, int, int]] = set()
    covered_branches: set[tuple[str, int, int]] = set()
    uncovered: list[dict[str, Any]] = []
    reported: set[Path] = set()
    for name, details in report.get("files", {}).items():
        path = Path(name)
        path = path.resolve() if path.is_absolute() else (root / path).resolve()
        reported.add(path)
        if path not in changed:
            continue
        executed = set(details.get("executed_lines", []))
        missing = set(details.get("missing_lines", []))
        relevant = executed | missing if not changed[path] else (executed | missing) & changed[path]
        relative = path.relative_to(root).as_posix() if path.is_relative_to(root) else str(path)
        total_lines.update((relative, line) for line in relevant)
        covered_lines.update((relative, line) for line in relevant & executed)
        executed_arcs = {tuple(arc) for arc in details.get("executed_branches", [])}
        missing_arcs = {tuple(arc) for arc in details.get("missing_branches", [])}
        arcs = executed_arcs | missing_arcs
        relevant_arcs = arcs if not changed[path] else {arc for arc in arcs if arc[0] in changed[path]}
        total_branches.update((relative, arc[0], arc[1]) for arc in relevant_arcs)
        covered_branches.update((relative, arc[0], arc[1]) for arc in relevant_arcs & executed_arcs)
        missed_lines = sorted(relevant - executed)
        missed_arcs = sorted(relevant_arcs - executed_arcs)
        if missed_lines or missed_arcs:
            uncovered.append({"file": relative, "lines": missed_lines, "branches": missed_arcs})
    for path, lines in changed.items():
        if path in reported or path.suffix.casefold() != ".py" or not path.is_file():
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
            statements = {node.lineno for node in ast.walk(tree) if isinstance(node, ast.stmt)}
        except (OSError, UnicodeError, SyntaxError):
            statements = set(lines)
        relevant = statements if not lines else statements & lines
        if relevant:
            relative = path.relative_to(root).as_posix()
            total_lines.update((relative, line) for line in relevant)
            uncovered.append({"file": relative, "lines": sorted(relevant), "branches": []})
    line_percent = 100.0 if not total_lines else 100.0 * len(covered_lines) / len(total_lines)
    branch_percent = 100.0 if not total_branches else 100.0 * len(covered_branches) / len(total_branches)
    line_threshold = float(step.get("line_threshold", 100))
    branch_threshold = float(step.get("branch_threshold", 100))
    return {
        "passed": line_percent >= line_threshold and branch_percent >= branch_threshold,
        "applicable": bool(total_lines or total_branches), "baseline": baseline,
        "line_coverage": round(line_percent, 4), "branch_coverage": round(branch_percent, 4),
        "line_threshold": line_threshold, "branch_threshold": branch_threshold,
        "covered_lines": len(covered_lines), "total_lines": len(total_lines),
        "covered_branches": len(covered_branches), "total_branches": len(total_branches),
        "uncovered": uncovered,
    }


def assertion_step(step: dict[str, Any], root: Path, results: dict[str, dict[str, Any]]) -> dict[str, Any]:
    evaluator = step.get("evaluator")
    if evaluator == "step_exit_code":
        target = results.get(str(step.get("step_id")))
        if target is None:
            raise ValueError(f"Unknown assertion step: {step.get('step_id')}")
        expected = int(step.get("expected", 0))
        actual = target.get("exit_code")
        return {"passed": actual == expected, "actual": actual, "expected": expected}
    if evaluator == "file_exists":
        path = safe_path(root, str(step.get("path", "")))
        expected = bool(step.get("expected", True))
        actual = path.exists()
        return {"passed": actual == expected, "actual": actual, "expected": expected, "path": str(path)}
    if evaluator == "json_value":
        path = safe_path(root, str(step.get("path", "")))
        value: Any = json.loads(path.read_text(encoding="utf-8"))
        field = str(step.get("field", ""))
        for part in field.split(".") if field else []:
            value = value[int(part)] if isinstance(value, list) else value[part]
        expected = step.get("expected")
        return {"passed": value == expected, "actual": value, "expected": expected, "field": field}
    raise ValueError(f"Unsupported assertion evaluator: {evaluator}")


def execute_steps(steps: list[dict[str, Any]], root: Path) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}
    for index, step in enumerate(steps):
        step_id = str(step.get("id") or f"step_{index + 1}")
        kind = step.get("type")
        try:
            if kind == "command":
                detail = command_step(step, root)
            elif kind == "coverage_gate":
                detail = coverage_gate(step, root)
            elif kind == "assertion":
                detail = assertion_step(step, root, by_id)
            else:
                raise ValueError(f"Unsupported workflow step type: {kind}")
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
            detail = {"passed": False, "error": type(exc).__name__, "message": str(exc)}
        result = {"id": step_id, "type": kind, **detail}
        results.append(result)
        by_id[step_id] = result
        if not result["passed"] and step.get("continue_on_failure") is not True:
            break
    return results


def failure_signature(results: list[dict[str, Any]]) -> str:
    failures = [
        {key: value for key, value in item.items() if key not in {"stdout", "stderr"}}
        for item in results if not item["passed"]
    ]
    encoded = json.dumps(failures, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
