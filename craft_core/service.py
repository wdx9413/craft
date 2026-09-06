from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from typing import Any

from .catalog import Catalog, utc_now
from .orchestrator import EXTERNAL_STATES, TERMINALS, external_request, next_cursor, normalize_steps, normalize_submission
from .store import CraftStore
from .workflow_runtime import execute_steps, failure_signature, resolve_inputs, substitute


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


class CraftService:
    def __init__(self, store: CraftStore | None = None) -> None:
        self.store = store or CraftStore()
        self.catalog = Catalog(self.store)

    def info(self) -> dict[str, Any]:
        with self.store.connect() as db:
            counts = {
                table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in (
                    "sources", "capabilities", "tasks", "workflows",
                    "workflow_runs", "workflow_sessions",
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
        planned = [*workflow.get("preconditions", []), *workflow["steps"], *criteria]
        steps = normalize_steps(substitute(planned, resolved))
        supported = {"command", "coverage_gate", "assertion", "agent", "judge", "human"}
        for step in steps:
            if step.get("type") not in supported:
                raise ValueError(f"Unsupported workflow step type: {step.get('type')}")
        return {
            "workflow_id": workflow_id,
            "workflow_version": loaded["version"],
            "project_root": str(root),
            "inputs": resolved,
            "steps": steps,
            "repair_policy": workflow.get("repair_policy", {}),
            "requires_execution_approval": any(step.get("type") == "command" for step in steps),
        }

    def workflow_run(
        self,
        workflow_id: str,
        project_root: str,
        version: int | None = None,
        inputs: dict[str, Any] | None = None,
        run_id: str | None = None,
        allow_execution: bool = False,
    ) -> dict[str, Any]:
        if not allow_execution:
            raise ValueError("allow_execution=true is required to run workflow commands")
        plan = self.workflow_plan(workflow_id, project_root, version, inputs)
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
        return self._workflow_advance(session_id, allow_execution)

    def workflow_continue(
        self, session_id: str, allow_execution: bool = False
    ) -> dict[str, Any]:
        session = self.workflow_session_get(session_id)
        if session["status"] not in {"running", "needs_execution_approval"}:
            raise ValueError(f"Workflow session cannot continue from status: {session['status']}")
        return self._workflow_advance(session_id, allow_execution)

    def workflow_submit(
        self,
        session_id: str,
        step_id: str,
        result: dict[str, Any],
        submitted_by: str = "host_agent",
        allow_execution: bool = False,
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
        return self._workflow_advance(session_id, allow_execution)

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
        return result

    def _workflow_advance(self, session_id: str, allow_execution: bool) -> dict[str, Any]:
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
                return self.workflow_session_get(session_id)
            if session["transition_count"] >= session["max_transitions"]:
                with self.store.transaction() as db:
                    db.execute(
                        "UPDATE workflow_sessions SET status='transition_limit',updated_at=? WHERE id=?",
                        (utc_now(), session_id),
                    )
                return self.workflow_session_get(session_id)
            step = plan["steps"][session["cursor"]]
            kind = str(step.get("type"))
            if kind in EXTERNAL_STATES:
                with self.store.transaction() as db:
                    db.execute(
                        "UPDATE workflow_sessions SET status=?,updated_at=? WHERE id=?",
                        (EXTERNAL_STATES[kind], utc_now(), session_id),
                    )
                return self.workflow_session_get(session_id)
            if kind == "command" and not allow_execution:
                with self.store.transaction() as db:
                    db.execute(
                        "UPDATE workflow_sessions SET status='needs_execution_approval',updated_at=? WHERE id=?",
                        (utc_now(), session_id),
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
        }
