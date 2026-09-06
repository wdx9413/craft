from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from .catalog import Catalog, utc_now
from .store import CraftStore


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
                for table in ("sources", "capabilities", "tasks", "workflows")
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
        success_criteria: list[str] | None = None,
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
