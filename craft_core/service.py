from __future__ import annotations

import hashlib
import json
import logging
import uuid
from pathlib import Path
from typing import Any

from .catalog import Catalog, utc_now
from .log import get_logger, log_event
from .multi_agent import PROVENANCE, normalize_orchestration_nodes, plan_status
from .orchestrator import (
    EXTERNAL_STATES, TERMINALS, approved_effects, compile_invariants,
    external_request, next_cursor, normalize_steps, normalize_submission,
)
from .store import CraftStore
from .workflow_runtime import execute_steps, failure_signature, resolve_inputs, substitute


EVAL_SUBJECT_KINDS = {
    "capability", "skill", "workflow", "tool", "mcp", "plugin",
    "agent", "model", "system", "combination",
}


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


class CraftService:
    def __init__(self, store: CraftStore | None = None) -> None:
        self.store = store or CraftStore()
        self.catalog = Catalog(self.store)
        self.logger = get_logger()

    def info(self) -> dict[str, Any]:
        with self.store.connect() as db:
            counts = {
                table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in (
                    "sources", "capabilities", "tasks", "workflows",
                    "workflow_runs", "workflow_sessions", "workflow_checkpoints",
                    "evaluation_suites", "evaluation_runs", "evaluation_results",
                    "agent_profiles", "orchestration_plans", "orchestration_leases",
                )
            }
        return {"version": "0.1.0", "data_root": str(self.store.root), "counts": counts}

    def source_add(self, path: str, label: str | None = None, scan: bool = True) -> dict[str, Any]:
        source = self.catalog.add_source(path, label)
        if scan:
            source["scan"] = self.catalog.scan_source(source["id"])
        return source

    def source_scan(self, source_id: str | None = None) -> dict[str, Any]:
        if source_id:
            return self.catalog.scan_source(source_id)
        with self.store.connect() as db:
            ids = [row["id"] for row in db.execute("SELECT id FROM sources WHERE enabled=1")]
        results = [self.catalog.scan_source(item) for item in ids]
        return {"sources": results, "count": len(results)}

    def source_list(self) -> dict[str, Any]:
        return {"sources": self.catalog.list_sources()}

    def source_update(
        self,
        source_id: str,
        enabled: bool | None = None,
        label: str | None = None,
    ) -> dict[str, Any]:
        return self.catalog.update_source(source_id, enabled=enabled, label=label)

    def source_remove(self, source_id: str) -> dict[str, Any]:
        return self.catalog.remove_source(source_id)

    def capability_search(
        self,
        query: str,
        limit: int = 6,
        kind: str | None = None,
        refresh: bool = True,
        stale_after_seconds: int = 300,
    ) -> dict[str, Any]:
        refreshed = self.catalog.scan_stale(stale_after_seconds) if refresh else []
        return {"query": query, "refreshed_sources": refreshed, "results": self.catalog.search(query, limit, kind)}

    def capability_get(self, asset_id: str) -> dict[str, Any]:
        return self.catalog.get(asset_id)

    def task_open(
        self,
        task_id: str | None = None,
        title: str | None = None,
        goal: str = "",
        project_id: str | None = None,
    ) -> dict[str, Any]:
        if task_id:
            return self._task_pack(task_id)
        if not title:
            raise ValueError("title is required when creating a task")
        task_id = new_id("task")
        now = utc_now()
        with self.store.transaction() as db:
            db.execute(
                "INSERT INTO tasks(id,project_id,title,goal,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (task_id, project_id, title, goal, now, now),
            )
        return self._task_pack(task_id)

    def task_list(
        self,
        limit: int = 10,
        status: str | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        limit = max(1, min(limit, 50))
        sql = "SELECT * FROM tasks WHERE 1=1"
        params: list[Any] = []
        if status:
            sql += " AND status=?"
            params.append(status)
        if project_id:
            sql += " AND project_id=?"
            params.append(project_id)
        sql += " ORDER BY updated_at DESC LIMIT ?"
        params.append(limit)
        with self.store.connect() as db:
            rows = db.execute(sql, params).fetchall()
        return {"tasks": [dict(row) for row in rows]}

    def task_checkpoint(
        self,
        task_id: str,
        summary: str,
        completed: list[str] | None = None,
        pending: list[str] | None = None,
        decisions: list[dict[str, Any]] | None = None,
        artifacts: list[dict[str, Any]] | None = None,
        status: str | None = None,
        source: str = "agent_reported",
    ) -> dict[str, Any]:
        if not summary.strip():
            raise ValueError("summary must not be empty")
        checkpoint_id = new_id("cp")
        now = utc_now()
        with self.store.transaction() as db:
            if not db.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                raise ValueError(f"Unknown task: {task_id}")
            db.execute(
                """INSERT INTO checkpoints(
                    id,task_id,summary,completed_json,pending_json,decisions_json,
                    artifacts_json,source,created_at) VALUES(?,?,?,?,?,?,?,?,?)""",
                (
                    checkpoint_id, task_id, summary,
                    json.dumps(completed or [], ensure_ascii=False),
                    json.dumps(pending or [], ensure_ascii=False),
                    json.dumps(decisions or [], ensure_ascii=False),
                    json.dumps(artifacts or [], ensure_ascii=False), source, now,
                ),
            )
            if status:
                if status not in {"active", "paused", "completed", "cancelled"}:
                    raise ValueError(f"Unsupported task status: {status}")
                db.execute("UPDATE tasks SET status=?,updated_at=? WHERE id=?", (status, now, task_id))
            else:
                db.execute("UPDATE tasks SET updated_at=? WHERE id=?", (now, task_id))
        return {"checkpoint_id": checkpoint_id, "task": self._task_pack(task_id)}

    def feedback_record(
        self,
        corrected: str,
        kind: str = "correction",
        scope: str = "task",
        task_id: str | None = None,
        original: str = "",
        applies_to: str = "",
        source: str = "user_explicit",
    ) -> dict[str, Any]:
        if not corrected.strip():
            raise ValueError("corrected must not be empty")
        if kind not in {"correction", "preference", "fact", "exception", "process"}:
            raise ValueError(f"Unsupported feedback kind: {kind}")
        if scope not in {"task", "project", "user"}:
            raise ValueError(f"Unsupported feedback scope: {scope}")
        if scope == "task" and not task_id:
            raise ValueError("task_id is required for task-scoped feedback")
        feedback_id = new_id("fb")
        with self.store.transaction() as db:
            if task_id and not db.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                raise ValueError(f"Unknown task: {task_id}")
            db.execute(
                """INSERT INTO feedback(
                    id,task_id,kind,scope,original,corrected,applies_to,source,created_at
                ) VALUES(?,?,?,?,?,?,?,?,?)""",
                (feedback_id, task_id, kind, scope, original, corrected, applies_to, source, utc_now()),
            )
        return {"feedback_id": feedback_id, "kind": kind, "scope": scope, "task_id": task_id}

    def eval_suite_save(
        self,
        name: str,
        cases: list[dict[str, Any]],
        description: str = "",
        scope: str = "user",
        suite_id: str | None = None,
    ) -> dict[str, Any]:
        if not name.strip() or not cases:
            raise ValueError("name and at least one case are required")
        if scope not in {"task", "project", "user"}:
            raise ValueError(f"Unsupported evaluation suite scope: {scope}")
        normalized_cases: list[dict[str, Any]] = []
        seen: set[str] = set()
        for index, item in enumerate(cases):
            if not isinstance(item, dict):
                raise ValueError(f"Evaluation case at index {index} must be an object")
            case_id = str(item.get("id", "")).strip()
            case_name = str(item.get("name", "")).strip()
            if not case_id or not case_name:
                raise ValueError(f"Evaluation case at index {index} requires id and name")
            if case_id in seen:
                raise ValueError(f"Duplicate evaluation case id: {case_id}")
            seen.add(case_id)
            weight = item.get("weight", 1.0)
            if isinstance(weight, bool) or not isinstance(weight, (int, float)) or weight <= 0:
                raise ValueError(f"Evaluation case {case_id} weight must be a positive number")
            tags = item.get("tags", [])
            graders = item.get("graders", [])
            if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
                raise ValueError(f"Evaluation case {case_id} tags must be strings")
            if not isinstance(graders, list) or not all(isinstance(grader, dict) for grader in graders):
                raise ValueError(f"Evaluation case {case_id} graders must be objects")
            normalized_cases.append({
                "id": case_id,
                "name": case_name,
                "input": item.get("input", {}),
                "expected": item.get("expected"),
                "graders": graders,
                "tags": tags,
                "weight": float(weight),
            })
        suite_id = suite_id or "eval_" + hashlib.sha256(
            f"{scope}:{name.casefold()}".encode("utf-8")
        ).hexdigest()[:20]
        definition = {"name": name, "description": description, "cases": normalized_cases}
        encoded = json.dumps(definition, ensure_ascii=False, sort_keys=True)
        digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
        with self.store.transaction() as db:
            version = db.execute(
                "SELECT COALESCE(MAX(version),0)+1 AS version FROM evaluation_suites WHERE id=?",
                (suite_id,),
            ).fetchone()["version"]
            db.execute(
                """INSERT INTO evaluation_suites(
                   id,version,name,description,scope,definition_json,digest,created_at
                   ) VALUES(?,?,?,?,?,?,?,?)""",
                (suite_id, version, name, description, scope, encoded, digest, utc_now()),
            )
        log_event(
            self.logger, "eval_suite_saved", suite_id=suite_id, version=version,
            cases=len(normalized_cases), level=logging.DEBUG,
        )
        return {
            "id": suite_id, "version": version, "scope": scope,
            "digest": digest, "suite": definition,
        }

    def eval_suite_get(self, suite_id: str, version: int | None = None) -> dict[str, Any]:
        with self.store.connect() as db:
            if version is None:
                row = db.execute(
                    "SELECT * FROM evaluation_suites WHERE id=? ORDER BY version DESC LIMIT 1",
                    (suite_id,),
                ).fetchone()
            else:
                row = db.execute(
                    "SELECT * FROM evaluation_suites WHERE id=? AND version=?",
                    (suite_id, version),
                ).fetchone()
        if not row:
            raise ValueError(f"Unknown evaluation suite: {suite_id}")
        result = dict(row)
        result["suite"] = json.loads(result.pop("definition_json"))
        return result

    def eval_suite_list(
        self, limit: int = 20, query: str | None = None, scope: str | None = None
    ) -> dict[str, Any]:
        limit = max(1, min(limit, 50))
        if scope is not None and scope not in {"task", "project", "user"}:
            raise ValueError(f"Unsupported evaluation suite scope: {scope}")
        sql = """SELECT suite.* FROM evaluation_suites suite
                 JOIN (SELECT id, MAX(version) AS version FROM evaluation_suites GROUP BY id) latest
                 ON suite.id=latest.id AND suite.version=latest.version WHERE 1=1"""
        params: list[Any] = []
        if query and query.strip():
            sql += " AND (LOWER(suite.name) LIKE ? OR LOWER(suite.description) LIKE ?)"
            needle = f"%{query.strip().lower()}%"
            params.extend([needle, needle])
        if scope:
            sql += " AND suite.scope=?"
            params.append(scope)
        sql += " ORDER BY suite.created_at DESC LIMIT ?"
        params.append(limit)
        with self.store.connect() as db:
            rows = db.execute(sql, params).fetchall()
        suites = []
        for row in rows:
            item = dict(row)
            definition = json.loads(item.pop("definition_json"))
            item["case_count"] = len(definition["cases"])
            suites.append(item)
        return {"suites": suites}

    def eval_run_start(
        self,
        suite_id: str,
        subject_kind: str,
        subject_id: str,
        suite_version: int | None = None,
        subject_version: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if subject_kind not in EVAL_SUBJECT_KINDS:
            raise ValueError(f"Unsupported evaluation subject kind: {subject_kind}")
        if not subject_id.strip():
            raise ValueError("subject_id must not be empty")
        suite = self.eval_suite_get(suite_id, suite_version)
        run_id = new_id("evalrun")
        now = utc_now()
        with self.store.transaction() as db:
            db.execute(
                """INSERT INTO evaluation_runs(
                   id,suite_id,suite_version,subject_kind,subject_id,subject_version,
                   metadata_json,status,created_at,updated_at
                   ) VALUES(?,?,?,?,?,?,?,'running',?,?)""",
                (
                    run_id, suite_id, suite["version"], subject_kind, subject_id,
                    subject_version, json.dumps(metadata or {}, ensure_ascii=False), now, now,
                ),
            )
        log_event(
            self.logger, "eval_run_started", run_id=run_id, suite_id=suite_id,
            subject_kind=subject_kind, subject_id=subject_id,
        )
        return self.eval_run_get(run_id)

    def eval_result_submit(
        self,
        run_id: str,
        case_id: str,
        verdict: str,
        score: float | None = None,
        metrics: dict[str, Any] | None = None,
        evidence: list[dict[str, Any]] | None = None,
        notes: str = "",
        provenance: str = "agent_reported",
    ) -> dict[str, Any]:
        if verdict not in {"passed", "failed", "blocked", "skipped"}:
            raise ValueError(f"Unsupported evaluation verdict: {verdict}")
        if score is None and verdict in {"passed", "failed"}:
            score = 1.0 if verdict == "passed" else 0.0
        if score is not None and (
            isinstance(score, bool) or not isinstance(score, (int, float)) or not 0 <= score <= 1
        ):
            raise ValueError("score must be between 0 and 1")
        allowed_provenance = {
            "agent_reported", "model_judged", "program_verified",
            "human_approved", "human_rejected",
        }
        if provenance not in allowed_provenance:
            raise ValueError(f"Unsupported evaluation provenance: {provenance}")
        run = self.eval_run_get(run_id)
        if run["status"] == "completed":
            raise ValueError("Evaluation run is already completed")
        case_ids = {item["id"] for item in run["suite"]["cases"]}
        if case_id not in case_ids:
            raise ValueError(f"Unknown evaluation case for this run: {case_id}")
        if case_id in {item["case_id"] for item in run["results"]}:
            raise ValueError(f"Evaluation result already exists for case: {case_id}")
        now = utc_now()
        with self.store.transaction() as db:
            db.execute(
                """INSERT INTO evaluation_results(
                   run_id,case_id,verdict,score,metrics_json,evidence_json,notes,provenance,created_at
                   ) VALUES(?,?,?,?,?,?,?,?,?)""",
                (
                    run_id, case_id, verdict, score,
                    json.dumps(metrics or {}, ensure_ascii=False),
                    json.dumps(evidence or [], ensure_ascii=False),
                    notes, provenance, now,
                ),
            )
            submitted = db.execute(
                "SELECT COUNT(*) FROM evaluation_results WHERE run_id=?", (run_id,)
            ).fetchone()[0]
            status = "completed" if submitted == len(case_ids) else "running"
            db.execute(
                "UPDATE evaluation_runs SET status=?,updated_at=? WHERE id=?",
                (status, now, run_id),
            )
        log_event(
            self.logger, "eval_result_submitted", run_id=run_id, case_id=case_id,
            verdict=verdict, provenance=provenance, level=logging.DEBUG,
        )
        return self.eval_run_get(run_id)

    def eval_run_get(self, run_id: str) -> dict[str, Any]:
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM evaluation_runs WHERE id=?", (run_id,)).fetchone()
            if not row:
                raise ValueError(f"Unknown evaluation run: {run_id}")
            results = db.execute(
                "SELECT * FROM evaluation_results WHERE run_id=? ORDER BY case_id", (run_id,)
            ).fetchall()
        run = dict(row)
        run["metadata"] = json.loads(run.pop("metadata_json"))
        suite = self.eval_suite_get(run["suite_id"], run["suite_version"])
        run["suite"] = suite["suite"]
        run["results"] = []
        for item in results:
            result = dict(item)
            result["metrics"] = json.loads(result.pop("metrics_json"))
            result["evidence"] = json.loads(result.pop("evidence_json"))
            run["results"].append(result)
        run["summary"] = self._eval_summary(run["suite"]["cases"], run["results"])
        return run

    def eval_run_list(
        self,
        limit: int = 20,
        suite_id: str | None = None,
        subject_kind: str | None = None,
        subject_id: str | None = None,
        status: str | None = None,
    ) -> dict[str, Any]:
        limit = max(1, min(limit, 50))
        if subject_kind is not None and subject_kind not in EVAL_SUBJECT_KINDS:
            raise ValueError(f"Unsupported evaluation subject kind: {subject_kind}")
        if status is not None and status not in {"running", "completed"}:
            raise ValueError(f"Unsupported evaluation run status: {status}")
        sql = "SELECT id FROM evaluation_runs WHERE 1=1"
        params: list[Any] = []
        for column, value in (
            ("suite_id", suite_id), ("subject_kind", subject_kind),
            ("subject_id", subject_id), ("status", status),
        ):
            if value:
                sql += f" AND {column}=?"
                params.append(value)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        with self.store.connect() as db:
            ids = [row["id"] for row in db.execute(sql, params).fetchall()]
        return {"runs": [self.eval_run_get(run_id) for run_id in ids]}

    def eval_compare(self, run_ids: list[str]) -> dict[str, Any]:
        if len(run_ids) < 2:
            raise ValueError("At least two evaluation runs are required")
        if len(set(run_ids)) != len(run_ids):
            raise ValueError("Evaluation run IDs must be unique")
        runs = [self.eval_run_get(run_id) for run_id in run_ids]
        first = runs[0]
        for run in runs[1:]:
            if (run["suite_id"], run["suite_version"]) != (
                first["suite_id"], first["suite_version"]
            ):
                raise ValueError("Evaluation runs must use the same suite version")
        baseline = first["summary"]
        comparisons = []
        for run in runs:
            summary = run["summary"]
            comparisons.append({
                "run_id": run["id"],
                "subject": {
                    "kind": run["subject_kind"], "id": run["subject_id"],
                    "version": run["subject_version"],
                },
                "status": run["status"],
                "summary": summary,
                "delta": {
                    "pass_rate": self._metric_delta(summary["pass_rate"], baseline["pass_rate"]),
                    "weighted_score": self._metric_delta(
                        summary["weighted_score"], baseline["weighted_score"]
                    ),
                },
            })
        return {
            "suite_id": first["suite_id"], "suite_version": first["suite_version"],
            "baseline_run_id": first["id"], "runs": comparisons,
        }

    @staticmethod
    def _metric_delta(value: float | None, baseline: float | None) -> float | None:
        if value is None or baseline is None:
            return None
        return round(value - baseline, 6)

    @staticmethod
    def _eval_summary(
        cases: list[dict[str, Any]], results: list[dict[str, Any]]
    ) -> dict[str, Any]:
        by_id = {item["case_id"]: item for item in results}
        counts = {key: 0 for key in ("passed", "failed", "blocked", "skipped")}
        weighted_total = 0.0
        weighted_score = 0.0
        for case in cases:
            result = by_id.get(case["id"])
            if not result:
                continue
            counts[result["verdict"]] += 1
            if result["score"] is not None:
                weighted_total += case["weight"]
                weighted_score += case["weight"] * result["score"]
        evaluated = counts["passed"] + counts["failed"]
        return {
            "total_cases": len(cases),
            "submitted_cases": len(results),
            "completion_rate": round(len(results) / len(cases), 6),
            "counts": counts,
            "pass_rate": round(counts["passed"] / evaluated, 6) if evaluated else None,
            "weighted_score": round(weighted_score / weighted_total, 6) if weighted_total else None,
        }

    def agent_profile_save(
        self,
        name: str,
        role: str,
        host: str,
        provider: str,
        model: str,
        reasoning_effort: str | None = None,
        capabilities: list[str] | None = None,
        allowed_side_effects: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        enabled: bool = True,
        profile_id: str | None = None,
    ) -> dict[str, Any]:
        values = {"name": name, "role": role, "host": host, "provider": provider, "model": model}
        for field, value in values.items():
            if not value.strip():
                raise ValueError(f"{field} must not be empty")
        capabilities = capabilities or []
        effects = ["read_only"] if allowed_side_effects is None else allowed_side_effects
        if not all(isinstance(item, str) and item for item in capabilities):
            raise ValueError("capabilities must contain non-empty strings")
        from .orchestrator import SIDE_EFFECTS
        if not effects or any(item not in SIDE_EFFECTS for item in effects):
            raise ValueError("allowed_side_effects contains an unsupported value")
        profile_id = profile_id or "profile_" + hashlib.sha256(
            f"{role.casefold()}:{name.casefold()}".encode("utf-8")
        ).hexdigest()[:20]
        with self.store.transaction() as db:
            version = db.execute(
                "SELECT COALESCE(MAX(version),0)+1 AS version FROM agent_profiles WHERE id=?",
                (profile_id,),
            ).fetchone()["version"]
            db.execute(
                """INSERT INTO agent_profiles(
                   id,version,name,role,host,provider,model,reasoning_effort,
                   capabilities_json,allowed_side_effects_json,metadata_json,enabled,created_at
                   ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    profile_id, version, name, role, host, provider, model, reasoning_effort,
                    json.dumps(capabilities, ensure_ascii=False),
                    json.dumps(effects, ensure_ascii=False),
                    json.dumps(metadata or {}, ensure_ascii=False), int(enabled), utc_now(),
                ),
            )
        return self.agent_profile_get(profile_id, version)

    def agent_profile_get(self, profile_id: str, version: int | None = None) -> dict[str, Any]:
        with self.store.connect() as db:
            if version is None:
                row = db.execute(
                    "SELECT * FROM agent_profiles WHERE id=? ORDER BY version DESC LIMIT 1",
                    (profile_id,),
                ).fetchone()
            else:
                row = db.execute(
                    "SELECT * FROM agent_profiles WHERE id=? AND version=?", (profile_id, version)
                ).fetchone()
        if not row:
            raise ValueError(f"Unknown agent profile: {profile_id}")
        return self._agent_profile_card(row)

    def agent_profile_list(
        self,
        limit: int = 20,
        role: str | None = None,
        host: str | None = None,
        enabled: bool | None = True,
    ) -> dict[str, Any]:
        limit = max(1, min(limit, 50))
        sql = """SELECT profile.* FROM agent_profiles profile
                 JOIN (SELECT id, MAX(version) AS version FROM agent_profiles GROUP BY id) latest
                 ON profile.id=latest.id AND profile.version=latest.version WHERE 1=1"""
        params: list[Any] = []
        for column, value in (("role", role), ("host", host)):
            if value:
                sql += f" AND profile.{column}=?"
                params.append(value)
        if enabled is not None:
            sql += " AND profile.enabled=?"
            params.append(int(enabled))
        sql += " ORDER BY profile.created_at DESC LIMIT ?"
        params.append(limit)
        with self.store.connect() as db:
            rows = db.execute(sql, params).fetchall()
        return {"profiles": [self._agent_profile_card(row) for row in rows]}

    @staticmethod
    def _agent_profile_card(row: Any) -> dict[str, Any]:
        result = dict(row)
        result["enabled"] = bool(result["enabled"])
        result["capabilities"] = json.loads(result.pop("capabilities_json"))
        result["allowed_side_effects"] = json.loads(result.pop("allowed_side_effects_json"))
        result["metadata"] = json.loads(result.pop("metadata_json"))
        return result

    def orchestration_plan_create(
        self,
        goal: str,
        nodes: list[dict[str, Any]],
        task_id: str | None = None,
        max_concurrency: int = 4,
        policy: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not goal.strip():
            raise ValueError("goal must not be empty")
        if isinstance(max_concurrency, bool) or not 1 <= max_concurrency <= 32:
            raise ValueError("max_concurrency must be between 1 and 32")
        normalized = normalize_orchestration_nodes(nodes)
        resolved: list[dict[str, Any]] = []
        for node in normalized:
            routes = []
            for profile_id in node["profile_ids"]:
                profile = self.agent_profile_get(profile_id)
                if not profile["enabled"]:
                    raise ValueError(f"Agent profile is disabled: {profile_id}")
                if profile["role"] != node["role"]:
                    raise ValueError(
                        f"Agent profile {profile_id} has role {profile['role']}, expected {node['role']}"
                    )
                if node["side_effect"] not in profile["allowed_side_effects"]:
                    raise ValueError(
                        f"Agent profile {profile_id} does not allow {node['side_effect']}"
                    )
                routes.append({"profile_id": profile["id"], "profile_version": profile["version"]})
            resolved.append({**node, "routes": routes})
        plan_id = new_id("orch")
        now = utc_now()
        with self.store.transaction() as db:
            if task_id and not db.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                raise ValueError(f"Unknown task: {task_id}")
            db.execute(
                """INSERT INTO orchestration_plans(
                   id,task_id,goal,status,max_concurrency,policy_json,created_at,updated_at
                   ) VALUES(?,?,?,'running',?,?,?,?)""",
                (plan_id, task_id, goal, max_concurrency, json.dumps(policy or {}, ensure_ascii=False), now, now),
            )
            for position, node in enumerate(resolved):
                db.execute(
                    """INSERT INTO orchestration_nodes(
                       plan_id,node_id,position,role,objective,depends_on_json,routes_json,
                       input_json,output_schema_json,evidence_required_json,
                       side_effect,status,result_json,updated_at
                       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending','{}',?)""",
                    (
                        plan_id, node["id"], position, node["role"], node["objective"],
                        json.dumps(node["depends_on"], ensure_ascii=False),
                        json.dumps(node["routes"], ensure_ascii=False),
                        json.dumps(node["input"], ensure_ascii=False),
                        json.dumps(node["output_schema"], ensure_ascii=False),
                        json.dumps(node["evidence_required"], ensure_ascii=False),
                        node["side_effect"], now,
                    ),
                )
        log_event(self.logger, "orchestration_plan_created", plan_id=plan_id, nodes=len(resolved))
        return self.orchestration_plan_get(plan_id)

    def orchestration_plan_get(self, plan_id: str) -> dict[str, Any]:
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM orchestration_plans WHERE id=?", (plan_id,)).fetchone()
            if not row:
                raise ValueError(f"Unknown orchestration plan: {plan_id}")
            nodes = db.execute(
                "SELECT * FROM orchestration_nodes WHERE plan_id=? ORDER BY position", (plan_id,)
            ).fetchall()
            leases = db.execute(
                "SELECT * FROM orchestration_leases WHERE plan_id=? ORDER BY created_at", (plan_id,)
            ).fetchall()
        result = dict(row)
        result["policy"] = json.loads(result.pop("policy_json"))
        result["nodes"] = []
        for raw in nodes:
            node = dict(raw)
            node["depends_on"] = json.loads(node.pop("depends_on_json"))
            node["routes"] = json.loads(node.pop("routes_json"))
            node["input"] = json.loads(node.pop("input_json"))
            node["output_schema"] = json.loads(node.pop("output_schema_json"))
            node["evidence_required"] = json.loads(node.pop("evidence_required_json"))
            node["result"] = json.loads(node.pop("result_json"))
            result["nodes"].append(node)
        result["leases"] = []
        for raw in leases:
            lease = dict(raw)
            lease["request"] = json.loads(lease.pop("request_json"))
            lease["result"] = json.loads(lease.pop("result_json"))
            result["leases"].append(lease)
        return result

    def orchestration_plan_list(
        self,
        limit: int = 20,
        task_id: str | None = None,
        status: str | None = None,
    ) -> dict[str, Any]:
        limit = max(1, min(limit, 50))
        if status is not None and status not in {"running", "completed", "failed"}:
            raise ValueError(f"Unsupported orchestration plan status: {status}")
        sql = "SELECT id FROM orchestration_plans WHERE 1=1"
        params: list[Any] = []
        if task_id:
            sql += " AND task_id=?"
            params.append(task_id)
        if status:
            sql += " AND status=?"
            params.append(status)
        sql += " ORDER BY updated_at DESC LIMIT ?"
        params.append(limit)
        with self.store.connect() as db:
            ids = [row["id"] for row in db.execute(sql, params).fetchall()]
        return {"plans": [self.orchestration_plan_get(plan_id) for plan_id in ids]}

    def orchestration_dispatch(
        self, plan_id: str, claimed_by: str, limit: int | None = None
    ) -> dict[str, Any]:
        if not claimed_by.strip():
            raise ValueError("claimed_by must not be empty")
        dispatched: list[dict[str, Any]] = []
        now = utc_now()
        with self.store.transaction() as db:
            plan = db.execute("SELECT * FROM orchestration_plans WHERE id=?", (plan_id,)).fetchone()
            if not plan:
                raise ValueError(f"Unknown orchestration plan: {plan_id}")
            if plan["status"] != "running":
                raise ValueError(f"Orchestration plan cannot dispatch from status: {plan['status']}")
            self._refresh_orchestration(db, plan_id, now)
            active = db.execute(
                "SELECT COUNT(*) FROM orchestration_leases WHERE plan_id=? AND status='leased'",
                (plan_id,),
            ).fetchone()[0]
            requested = plan["max_concurrency"] if limit is None else max(1, min(limit, 32))
            capacity = max(0, min(requested, plan["max_concurrency"] - active))
            rows = db.execute(
                "SELECT * FROM orchestration_nodes WHERE plan_id=? AND status='pending' ORDER BY position",
                (plan_id,),
            ).fetchall()
            state_rows = db.execute(
                "SELECT node_id,status,result_json FROM orchestration_nodes WHERE plan_id=?",
                (plan_id,),
            ).fetchall()
            statuses = {item["node_id"]: item["status"] for item in state_rows}
            dependency_results = {
                item["node_id"]: json.loads(item["result_json"]) for item in state_rows
            }
            for row in rows:
                if len(dispatched) >= capacity:
                    break
                dependencies = json.loads(row["depends_on_json"])
                if not all(statuses[item] == "passed" for item in dependencies):
                    continue
                routes = json.loads(row["routes_json"])
                attempt = row["attempt"] + 1
                route = routes[attempt - 1]
                profile = self._profile_from_db(db, route["profile_id"], route["profile_version"])
                lease_id = new_id("lease")
                request = {
                    "lease_id": lease_id, "plan_id": plan_id, "node_id": row["node_id"],
                    "objective": row["objective"], "role": row["role"],
                    "side_effect": row["side_effect"], "profile": profile,
                    "input": json.loads(row["input_json"]),
                    "output_schema": json.loads(row["output_schema_json"]),
                    "evidence_required": json.loads(row["evidence_required_json"]),
                    "goal": plan["goal"], "policy": json.loads(plan["policy_json"]),
                    "dependency_results": {
                        item: dependency_results[item] for item in dependencies
                    },
                }
                db.execute(
                    """INSERT INTO orchestration_leases(
                       id,plan_id,node_id,attempt,profile_id,profile_version,status,claimed_by,
                       request_json,created_at,updated_at
                       ) VALUES(?,?,?,?,?,?,'leased',?,?,?,?)""",
                    (
                        lease_id, plan_id, row["node_id"], attempt, profile["id"], profile["version"],
                        claimed_by, json.dumps(request, ensure_ascii=False), now, now,
                    ),
                )
                db.execute(
                    "UPDATE orchestration_nodes SET status='leased',attempt=?,updated_at=? WHERE plan_id=? AND node_id=?",
                    (attempt, now, plan_id, row["node_id"]),
                )
                statuses[row["node_id"]] = "leased"
                dispatched.append(request)
            self._refresh_orchestration(db, plan_id, now)
        log_event(self.logger, "orchestration_dispatched", plan_id=plan_id, leases=len(dispatched))
        return {"dispatched": dispatched, "plan": self.orchestration_plan_get(plan_id)}

    def orchestration_submit(
        self,
        lease_id: str,
        verdict: str,
        result: dict[str, Any] | None = None,
        evidence: list[dict[str, Any]] | None = None,
        provenance: str = "agent_reported",
    ) -> dict[str, Any]:
        if verdict not in {"passed", "failed", "blocked"}:
            raise ValueError(f"Unsupported orchestration verdict: {verdict}")
        if provenance not in PROVENANCE:
            raise ValueError(f"Unsupported orchestration provenance: {provenance}")
        now = utc_now()
        with self.store.transaction() as db:
            lease = db.execute("SELECT * FROM orchestration_leases WHERE id=?", (lease_id,)).fetchone()
            if not lease:
                raise ValueError(f"Unknown orchestration lease: {lease_id}")
            if lease["status"] != "leased":
                raise ValueError(f"Orchestration lease is already closed: {lease_id}")
            node = db.execute(
                "SELECT * FROM orchestration_nodes WHERE plan_id=? AND node_id=?",
                (lease["plan_id"], lease["node_id"]),
            ).fetchone()
            required_evidence = json.loads(node["evidence_required_json"])
            if required_evidence and not evidence:
                raise ValueError("This orchestration node requires evidence references")
            routes = json.loads(node["routes_json"])
            receipt = {"verdict": verdict, "result": result or {}, "evidence": evidence or []}
            db.execute(
                """UPDATE orchestration_leases SET status='completed',result_json=?,provenance=?,updated_at=?
                   WHERE id=?""",
                (json.dumps(receipt, ensure_ascii=False), provenance, now, lease_id),
            )
            if verdict == "passed":
                node_status = "passed"
            elif node["attempt"] < len(routes):
                node_status = "pending"
            else:
                node_status = verdict
            db.execute(
                """UPDATE orchestration_nodes SET status=?,result_json=?,updated_at=?
                   WHERE plan_id=? AND node_id=?""",
                (
                    node_status, json.dumps(receipt, ensure_ascii=False), now,
                    lease["plan_id"], lease["node_id"],
                ),
            )
            self._refresh_orchestration(db, lease["plan_id"], now)
            plan_id = lease["plan_id"]
        log_event(
            self.logger, "orchestration_submitted", plan_id=plan_id,
            node_id=lease["node_id"], verdict=verdict, provenance=provenance,
        )
        return self.orchestration_plan_get(plan_id)

    @staticmethod
    def _profile_from_db(db: Any, profile_id: str, version: int) -> dict[str, Any]:
        row = db.execute(
            "SELECT * FROM agent_profiles WHERE id=? AND version=?", (profile_id, version)
        ).fetchone()
        if not row:
            raise ValueError(f"Unknown agent profile: {profile_id}")
        return CraftService._agent_profile_card(row)

    @staticmethod
    def _refresh_orchestration(db: Any, plan_id: str, now: str) -> None:
        changed = True
        while changed:
            changed = False
            rows = db.execute(
                "SELECT * FROM orchestration_nodes WHERE plan_id=? ORDER BY position", (plan_id,)
            ).fetchall()
            statuses = {row["node_id"]: row["status"] for row in rows}
            for row in rows:
                dependencies = json.loads(row["depends_on_json"])
                if row["status"] == "pending" and any(
                    statuses[item] in {"failed", "blocked"} for item in dependencies
                ):
                    db.execute(
                        "UPDATE orchestration_nodes SET status='blocked',updated_at=? WHERE plan_id=? AND node_id=?",
                        (now, plan_id, row["node_id"]),
                    )
                    changed = True
        rows = db.execute(
            "SELECT status FROM orchestration_nodes WHERE plan_id=?", (plan_id,)
        ).fetchall()
        status = plan_status([dict(row) for row in rows])
        db.execute(
            "UPDATE orchestration_plans SET status=?,updated_at=? WHERE id=?",
            (status, now, plan_id),
        )

    def workflow_save(
        self,
        name: str,
        goal: str,
        steps: list[dict[str, Any]],
        scope: str = "user",
        status: str = "candidate",
        source_task_id: str | None = None,
        workflow_id: str | None = None,
        inputs: list[dict[str, Any]] | None = None,
        success_criteria: list[Any] | None = None,
        preconditions: list[dict[str, Any]] | None = None,
        repair_policy: dict[str, Any] | None = None,
        artifacts: list[dict[str, Any]] | None = None,
        invariants: list[dict[str, Any]] | None = None,
        permission_policy: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not name.strip() or not goal.strip() or not steps:
            raise ValueError("name, goal, and at least one step are required")
        if scope not in {"task", "project", "user"}:
            raise ValueError(f"Unsupported workflow scope: {scope}")
        if status not in {"candidate", "tested", "reusable", "deprecated"}:
            raise ValueError(f"Unsupported workflow status: {status}")
        workflow_id = workflow_id or "wf_" + hashlib.sha256(
            f"{scope}:{name.casefold()}".encode("utf-8")
        ).hexdigest()[:20]
        workflow = {
            "name": name, "goal": goal, "inputs": inputs or [], "steps": steps,
            "success_criteria": success_criteria or [],
            "preconditions": preconditions or [],
            "repair_policy": repair_policy or {"enabled": False, "max_attempts": 1},
            "artifacts": artifacts or [],
            "invariants": invariants or [],
            "permission_policy": permission_policy or {},
        }
        encoded = json.dumps(workflow, ensure_ascii=False, sort_keys=True)
        digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
        with self.store.transaction() as db:
            if source_task_id and not db.execute(
                "SELECT 1 FROM tasks WHERE id=?", (source_task_id,)
            ).fetchone():
                raise ValueError(f"Unknown task: {source_task_id}")
            row = db.execute(
                "SELECT COALESCE(MAX(version),0)+1 AS version FROM workflows WHERE id=?",
                (workflow_id,),
            ).fetchone()
            version = row["version"]
            db.execute(
                """INSERT INTO workflows(
                    id,version,name,goal,scope,status,workflow_json,source_task_id,digest,created_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (workflow_id, version, name, goal, scope, status, encoded, source_task_id, digest, utc_now()),
            )
        log_event(
            self.logger, "workflow_saved", workflow_id=workflow_id, version=version,
            steps=len(steps), level=logging.DEBUG,
        )
        return {"id": workflow_id, "version": version, "status": status, "digest": digest, "workflow": workflow}

    def workflow_plan(
        self,
        workflow_id: str,
        project_root: str,
        version: int | None = None,
        inputs: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        loaded = self.workflow_get(workflow_id, version)
        workflow = loaded["workflow"]
        root = Path(project_root).expanduser().resolve()
        if not root.is_dir():
            raise ValueError(f"Project root does not exist: {root}")
        resolved = resolve_inputs(workflow.get("inputs", []), inputs or {})
        criteria = workflow.get("success_criteria", [])
        if any(not isinstance(item, dict) for item in criteria):
            raise ValueError("Executable workflows require structured success_criteria objects")
        invariants = compile_invariants(workflow.get("invariants", []))
        planned = [*workflow.get("preconditions", []), *workflow["steps"], *invariants, *criteria]
        steps = normalize_steps(substitute(planned, resolved))
        supported = {"command", "coverage_gate", "assertion", "agent", "judge", "human"}
        permission_policy = workflow.get("permission_policy", {})
        declared_effects = set(permission_policy.get(
            "allowed_side_effects",
            ["read_only", "local_write", "external_write", "destructive"],
        ))
        for step in steps:
            if step.get("type") not in supported:
                raise ValueError(f"Unsupported workflow step type: {step.get('type')}")
            if step["side_effect"] not in declared_effects:
                raise ValueError(
                    f"Workflow permission policy forbids {step['side_effect']} at {step['id']}"
                )
        return {
            "workflow_id": workflow_id,
            "workflow_version": loaded["version"],
            "project_root": str(root),
            "inputs": resolved,
            "steps": steps,
            "repair_policy": workflow.get("repair_policy", {}),
            "permission_policy": permission_policy,
            "invariants": workflow.get("invariants", []),
            "required_approvals": sorted({
                step["side_effect"] for step in steps if step["side_effect"] != "read_only"
            }),
            "requires_execution_approval": any(step["side_effect"] != "read_only" for step in steps),
        }

    def workflow_run(
        self,
        workflow_id: str,
        project_root: str,
        version: int | None = None,
        inputs: dict[str, Any] | None = None,
        run_id: str | None = None,
        allow_execution: bool = False,
        approved_side_effects: list[str] | None = None,
    ) -> dict[str, Any]:
        if not allow_execution:
            raise ValueError("allow_execution=true is required to run workflow commands")
        plan = self.workflow_plan(workflow_id, project_root, version, inputs)
        allowed = approved_effects(allow_execution, approved_side_effects)
        blocked = sorted({
            step["side_effect"] for step in plan["steps"]
            if step["side_effect"] not in allowed
        })
        if blocked:
            raise ValueError(f"Workflow requires unapproved side effects: {', '.join(blocked)}")
        policy = plan["repair_policy"]
        max_attempts = max(1, min(int(policy.get("max_attempts", 1)), 20))
        no_progress_limit = max(1, min(int(policy.get("no_progress_limit", 2)), 10))
        now = utc_now()
        with self.store.transaction() as db:
            if run_id:
                row = db.execute("SELECT * FROM workflow_runs WHERE id=?", (run_id,)).fetchone()
                if not row:
                    raise ValueError(f"Unknown workflow run: {run_id}")
                if row["workflow_id"] != workflow_id or row["workflow_version"] != plan["workflow_version"]:
                    raise ValueError("run_id belongs to a different workflow version")
                if Path(row["project_root"]) != Path(plan["project_root"]):
                    raise ValueError("run_id belongs to a different project root")
                if json.loads(row["inputs_json"]) != plan["inputs"]:
                    raise ValueError("run_id belongs to different resolved inputs")
                if row["status"] != "needs_repair":
                    raise ValueError(f"Workflow run cannot resume from status: {row['status']}")
                attempt = row["attempt"] + 1
                previous_signature = row["last_signature"]
                previous_no_progress = row["no_progress_count"]
                max_attempts = row["max_attempts"]
            else:
                run_id = new_id("run")
                attempt = 1
                previous_signature = None
                previous_no_progress = 0
                db.execute(
                    """INSERT INTO workflow_runs(id,workflow_id,workflow_version,project_root,
                       inputs_json,status,attempt,max_attempts,created_at,updated_at)
                       VALUES(?,?,?,?,?,'running',0,?,?,?)""",
                    (run_id, workflow_id, plan["workflow_version"], plan["project_root"],
                     json.dumps(plan["inputs"], ensure_ascii=False), max_attempts, now, now),
                )
        results = execute_steps(plan["steps"], Path(plan["project_root"]))
        passed = len(results) == len(plan["steps"]) and all(item["passed"] for item in results)
        signature = "passed" if passed else failure_signature(results)
        no_progress = previous_no_progress + 1 if signature == previous_signature and not passed else 0
        if passed:
            status = "passed"
        elif no_progress >= no_progress_limit:
            status = "no_progress"
        elif policy.get("enabled") and attempt < max_attempts:
            status = "needs_repair"
        else:
            status = "failed"
        receipt = {
            "run_id": run_id, "workflow_id": workflow_id,
            "workflow_version": plan["workflow_version"], "attempt": attempt,
            "max_attempts": max_attempts, "status": status, "results": results,
            "next_action": "repair_then_resume" if status == "needs_repair" else None,
        }
        with self.store.transaction() as db:
            db.execute(
                """INSERT INTO workflow_attempts(run_id,attempt,status,result_json,signature,created_at)
                   VALUES(?,?,?,?,?,?)""",
                (run_id, attempt, status, json.dumps(receipt, ensure_ascii=False), signature, now),
            )
            db.execute(
                """UPDATE workflow_runs SET status=?,attempt=?,no_progress_count=?,
                   last_signature=?,updated_at=? WHERE id=?""",
                (status, attempt, no_progress, signature, now, run_id),
            )
            if passed:
                db.execute(
                    "UPDATE workflows SET status='tested' WHERE id=? AND version=? AND status='candidate'",
                    (workflow_id, plan["workflow_version"]),
                )
        log_event(
            self.logger, "workflow_run_finished", run_id=run_id, status=status,
            attempt=attempt, verified_steps=len(results),
        )
        return receipt

    def workflow_run_get(self, run_id: str) -> dict[str, Any]:
        with self.store.connect() as db:
            run = db.execute("SELECT * FROM workflow_runs WHERE id=?", (run_id,)).fetchone()
            if not run:
                raise ValueError(f"Unknown workflow run: {run_id}")
            attempts = db.execute(
                "SELECT result_json FROM workflow_attempts WHERE run_id=? ORDER BY attempt",
                (run_id,),
            ).fetchall()
        result = dict(run)
        result["inputs"] = json.loads(result.pop("inputs_json"))
        result["attempts"] = [json.loads(row["result_json"]) for row in attempts]
        return result

    def workflow_start(
        self,
        workflow_id: str,
        project_root: str,
        version: int | None = None,
        inputs: dict[str, Any] | None = None,
        allow_execution: bool = False,
        approved_side_effects: list[str] | None = None,
    ) -> dict[str, Any]:
        plan = self.workflow_plan(workflow_id, project_root, version, inputs)
        policy = plan["repair_policy"]
        default_limit = max(20, len(plan["steps"]) * 3)
        max_transitions = max(1, min(int(policy.get("max_transitions", default_limit)), 200))
        session_id = new_id("session")
        now = utc_now()
        with self.store.transaction() as db:
            db.execute(
                """INSERT INTO workflow_sessions(
                   id,workflow_id,workflow_version,project_root,inputs_json,context_json,
                   cursor,status,max_transitions,created_at,updated_at)
                   VALUES(?,?,?,?,?,'{}',0,'running',?,?,?)""",
                (session_id, workflow_id, plan["workflow_version"], plan["project_root"],
                 json.dumps(plan["inputs"], ensure_ascii=False), max_transitions, now, now),
            )
        log_event(self.logger, "workflow_session_started", session_id=session_id, workflow_id=workflow_id)
        return self._workflow_advance(
            session_id, approved_effects(allow_execution, approved_side_effects)
        )

    def workflow_continue(
        self, session_id: str, allow_execution: bool = False,
        approved_side_effects: list[str] | None = None,
    ) -> dict[str, Any]:
        session = self.workflow_session_get(session_id)
        if session["status"] not in {"running", "needs_execution_approval"}:
            raise ValueError(f"Workflow session cannot continue from status: {session['status']}")
        return self._workflow_advance(
            session_id, approved_effects(allow_execution, approved_side_effects)
        )

    def workflow_submit(
        self,
        session_id: str,
        step_id: str,
        result: dict[str, Any],
        submitted_by: str = "host_agent",
        allow_execution: bool = False,
        approved_side_effects: list[str] | None = None,
    ) -> dict[str, Any]:
        session = self.workflow_session_get(session_id)
        if session["status"] not in set(EXTERNAL_STATES.values()):
            raise ValueError(f"Workflow session is not awaiting external input: {session['status']}")
        plan = self.workflow_plan(
            session["workflow_id"], session["project_root"], session["workflow_version"], session["inputs"]
        )
        step = plan["steps"][session["cursor"]]
        if step["id"] != step_id:
            raise ValueError(f"Workflow session is awaiting step: {step['id']}")
        expected_state = EXTERNAL_STATES.get(str(step.get("type")))
        if expected_state != session["status"]:
            raise ValueError("Workflow session state does not match its pending step")
        verdict, provenance = normalize_submission(step, result)
        recorded = {**result, "submitted_by": submitted_by}
        context = dict(session["context"])
        context[step_id] = recorded
        cursor, terminal = next_cursor(plan["steps"], session["cursor"], verdict)
        self._record_session_event(
            session, step, verdict, provenance, recorded, context, cursor, terminal or "running"
        )
        if terminal:
            return self.workflow_session_get(session_id)
        return self._workflow_advance(
            session_id, approved_effects(allow_execution, approved_side_effects)
        )

    def workflow_session_get(self, session_id: str) -> dict[str, Any]:
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM workflow_sessions WHERE id=?", (session_id,)).fetchone()
            if not row:
                raise ValueError(f"Unknown workflow session: {session_id}")
            events = db.execute(
                "SELECT * FROM workflow_events WHERE session_id=? ORDER BY sequence", (session_id,)
            ).fetchall()
        result = dict(row)
        result["inputs"] = json.loads(result.pop("inputs_json"))
        result["context"] = json.loads(result.pop("context_json"))
        result["events"] = [
            {**dict(event), "result": json.loads(event["result_json"])} for event in events
        ]
        for event in result["events"]:
            event.pop("result_json")
        if result["status"] in {*EXTERNAL_STATES.values(), "needs_execution_approval"}:
            plan = self.workflow_plan(
                result["workflow_id"], result["project_root"], result["workflow_version"], result["inputs"]
            )
            step = plan["steps"][result["cursor"]]
            result["pending"] = (
                external_request(step, result["context"])
                if step["type"] in EXTERNAL_STATES else step
            )
            if result["status"] == "needs_execution_approval":
                result["approval"] = {
                    "required_side_effect": step["side_effect"],
                    "grant_with": "approved_side_effects",
                }
        return result

    def _workflow_advance(
        self, session_id: str, allowed_effects: set[str] | bool
    ) -> dict[str, Any]:
        if isinstance(allowed_effects, bool):
            allowed_effects = approved_effects(allowed_effects, None)
        while True:
            session = self.workflow_session_get(session_id)
            if session["status"] in TERMINALS:
                return session
            plan = self.workflow_plan(
                session["workflow_id"], session["project_root"], session["workflow_version"], session["inputs"]
            )
            if session["cursor"] >= len(plan["steps"]):
                with self.store.transaction() as db:
                    db.execute(
                        "UPDATE workflow_sessions SET status='passed',updated_at=? WHERE id=?",
                        (utc_now(), session_id),
                    )
                log_event(self.logger, "workflow_session_finished", session_id=session_id, status="passed")
                return self.workflow_session_get(session_id)
            if session["transition_count"] >= session["max_transitions"]:
                with self.store.transaction() as db:
                    db.execute(
                        "UPDATE workflow_sessions SET status='transition_limit',updated_at=? WHERE id=?",
                        (utc_now(), session_id),
                    )
                log_event(self.logger, "workflow_session_finished", session_id=session_id, status="transition_limit")
                return self.workflow_session_get(session_id)
            step = plan["steps"][session["cursor"]]
            kind = str(step.get("type"))
            if step["side_effect"] not in allowed_effects:
                with self.store.transaction() as db:
                    db.execute(
                        "UPDATE workflow_sessions SET status='needs_execution_approval',updated_at=? WHERE id=?",
                        (utc_now(), session_id),
                    )
                log_event(
                    self.logger, "workflow_approval_required", session_id=session_id,
                    step_id=step["id"], side_effect=step["side_effect"],
                )
                return self.workflow_session_get(session_id)
            if kind in EXTERNAL_STATES:
                with self.store.transaction() as db:
                    db.execute(
                        "UPDATE workflow_sessions SET status=?,updated_at=? WHERE id=?",
                        (EXTERNAL_STATES[kind], utc_now(), session_id),
                    )
                log_event(
                    self.logger, "workflow_external_wait", session_id=session_id,
                    step_id=step["id"], step_type=kind, level=logging.DEBUG,
                )
                return self.workflow_session_get(session_id)
            detail = execute_steps([step], Path(session["project_root"]))[0]
            verdict = "passed" if detail["passed"] else "failed"
            context = dict(session["context"])
            context[step["id"]] = detail
            cursor, terminal = next_cursor(plan["steps"], session["cursor"], verdict)
            self._record_session_event(
                session, step, verdict, "program_verified", detail,
                context, cursor, terminal or "running",
            )
            if terminal:
                return self.workflow_session_get(session_id)

    def _record_session_event(
        self,
        session: dict[str, Any],
        step: dict[str, Any],
        verdict: str,
        provenance: str,
        result: dict[str, Any],
        context: dict[str, Any],
        cursor: int,
        status: str,
    ) -> None:
        sequence = session["transition_count"] + 1
        now = utc_now()
        with self.store.transaction() as db:
            db.execute(
                """INSERT INTO workflow_events(
                   session_id,sequence,step_id,step_type,verdict,provenance,result_json,created_at)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (session["id"], sequence, step["id"], step["type"], verdict, provenance,
                 json.dumps(result, ensure_ascii=False), now),
            )
            db.execute(
                """UPDATE workflow_sessions SET context_json=?,cursor=?,status=?,
                   transition_count=?,updated_at=? WHERE id=?""",
                (json.dumps(context, ensure_ascii=False), cursor, status, sequence, now, session["id"]),
            )
        log_event(
            self.logger, "workflow_transition", session_id=session["id"],
            sequence=sequence, step_id=step["id"], verdict=verdict,
            provenance=provenance, status=status, level=logging.DEBUG,
        )
        if verdict == "passed" and provenance in {"program_verified", "human_approved"}:
            self._create_workflow_checkpoint(
                session, sequence, context, cursor, provenance, f"trusted:{step['id']}"
            )

    def workflow_checkpoint_list(self, session_id: str) -> dict[str, Any]:
        self.workflow_session_get(session_id)
        with self.store.connect() as db:
            rows = db.execute(
                """SELECT id,session_id,sequence,workflow_id,workflow_version,cursor,
                   provenance,reason,digest,created_at FROM workflow_checkpoints
                   WHERE session_id=? ORDER BY sequence DESC""",
                (session_id,),
            ).fetchall()
        return {"session_id": session_id, "checkpoints": [dict(row) for row in rows]}

    def workflow_restore(
        self,
        checkpoint_id: str,
        allow_execution: bool = False,
        approved_side_effects: list[str] | None = None,
    ) -> dict[str, Any]:
        with self.store.connect() as db:
            checkpoint = db.execute(
                "SELECT * FROM workflow_checkpoints WHERE id=?", (checkpoint_id,)
            ).fetchone()
            if not checkpoint:
                raise ValueError(f"Unknown workflow checkpoint: {checkpoint_id}")
            parent = db.execute(
                "SELECT max_transitions FROM workflow_sessions WHERE id=?",
                (checkpoint["session_id"],),
            ).fetchone()
        session_id = new_id("session")
        now = utc_now()
        with self.store.transaction() as db:
            db.execute(
                """INSERT INTO workflow_sessions(
                   id,workflow_id,workflow_version,project_root,inputs_json,context_json,
                   cursor,status,max_transitions,restored_from_checkpoint,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,'running',?,?,?,?)""",
                (
                    session_id, checkpoint["workflow_id"], checkpoint["workflow_version"],
                    checkpoint["project_root"], checkpoint["inputs_json"],
                    checkpoint["context_json"], checkpoint["cursor"],
                    parent["max_transitions"], checkpoint_id, now, now,
                ),
            )
        log_event(
            self.logger, "workflow_session_restored", session_id=session_id,
            checkpoint_id=checkpoint_id,
        )
        return self._workflow_advance(
            session_id, approved_effects(allow_execution, approved_side_effects)
        )

    def _create_workflow_checkpoint(
        self,
        session: dict[str, Any],
        sequence: int,
        context: dict[str, Any],
        cursor: int,
        provenance: str,
        reason: str,
    ) -> None:
        snapshot = {
            "workflow_id": session["workflow_id"],
            "workflow_version": session["workflow_version"],
            "project_root": session["project_root"],
            "inputs": session["inputs"],
            "context": context,
            "cursor": cursor,
        }
        encoded = json.dumps(snapshot, ensure_ascii=False, sort_keys=True)
        with self.store.transaction() as db:
            checkpoint_id = new_id("wcp")
            db.execute(
                """INSERT INTO workflow_checkpoints(
                   id,session_id,sequence,workflow_id,workflow_version,project_root,
                   inputs_json,context_json,cursor,provenance,reason,digest,created_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    checkpoint_id, session["id"], sequence, session["workflow_id"],
                    session["workflow_version"], session["project_root"],
                    json.dumps(session["inputs"], ensure_ascii=False),
                    json.dumps(context, ensure_ascii=False), cursor, provenance, reason,
                    hashlib.sha256(encoded.encode("utf-8")).hexdigest(), utc_now(),
                ),
            )
        log_event(
            self.logger, "workflow_checkpoint_created", session_id=session["id"],
            checkpoint_id=checkpoint_id, sequence=sequence, provenance=provenance,
        )

    def workflow_search(
        self,
        query: str,
        limit: int = 6,
        scope: str | None = None,
    ) -> dict[str, Any]:
        if not query.strip():
            raise ValueError("query must not be empty")
        limit = max(1, min(limit, 20))
        pattern = f"%{query.strip()}%"
        sql = """SELECT w.* FROM workflows w
                 JOIN (SELECT id, MAX(version) version FROM workflows GROUP BY id) latest
                   ON latest.id=w.id AND latest.version=w.version
                 WHERE w.status != 'deprecated'
                   AND (w.name LIKE ? OR w.goal LIKE ? OR w.workflow_json LIKE ?)"""
        params: list[Any] = [pattern, pattern, pattern]
        if scope:
            sql += " AND w.scope=?"
            params.append(scope)
        sql += " ORDER BY w.created_at DESC LIMIT ?"
        params.append(limit)
        with self.store.connect() as db:
            rows = db.execute(sql, params).fetchall()
        return {"query": query, "results": [self._workflow_card(row) for row in rows]}

    def workflow_get(self, workflow_id: str, version: int | None = None) -> dict[str, Any]:
        with self.store.connect() as db:
            if version is None:
                row = db.execute(
                    "SELECT * FROM workflows WHERE id=? ORDER BY version DESC LIMIT 1",
                    (workflow_id,),
                ).fetchone()
            else:
                row = db.execute(
                    "SELECT * FROM workflows WHERE id=? AND version=?", (workflow_id, version)
                ).fetchone()
        if not row:
            raise ValueError(f"Unknown workflow version: {workflow_id}@{version or 'latest'}")
        result = self._workflow_card(row)
        result["workflow"] = json.loads(row["workflow_json"])
        return result

    @staticmethod
    def _workflow_card(row: Any) -> dict[str, Any]:
        return {
            "id": row["id"], "version": row["version"], "name": row["name"],
            "goal": row["goal"], "scope": row["scope"], "status": row["status"],
            "source_task_id": row["source_task_id"], "digest": row["digest"],
            "created_at": row["created_at"],
        }

    def _task_pack(self, task_id: str) -> dict[str, Any]:
        with self.store.connect() as db:
            task = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not task:
                raise ValueError(f"Unknown task: {task_id}")
            checkpoints = db.execute(
                "SELECT * FROM checkpoints WHERE task_id=? ORDER BY created_at DESC LIMIT 10", (task_id,)
            ).fetchall()
            feedback = db.execute(
                "SELECT * FROM feedback WHERE task_id=? ORDER BY created_at DESC LIMIT 20", (task_id,)
            ).fetchall()
            plans = db.execute(
                """SELECT id,goal,status,max_concurrency,created_at,updated_at
                   FROM orchestration_plans WHERE task_id=? ORDER BY updated_at DESC LIMIT 10""",
                (task_id,),
            ).fetchall()
        return {
            "task": dict(task),
            "checkpoints": [
                {
                    "id": row["id"], "summary": row["summary"],
                    "completed": json.loads(row["completed_json"]),
                    "pending": json.loads(row["pending_json"]),
                    "decisions": json.loads(row["decisions_json"]),
                    "artifacts": json.loads(row["artifacts_json"]),
                    "source": row["source"], "created_at": row["created_at"],
                }
                for row in checkpoints
            ],
            "feedback": [dict(row) for row in feedback],
            "orchestration_plans": [dict(row) for row in plans],
        }
