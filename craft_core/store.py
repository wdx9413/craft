from __future__ import annotations

import sqlite3
import uuid
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from .paths import ensure_layout


SCHEMA_VERSION = 12


class ClosingConnection(sqlite3.Connection):
    """A sqlite connection whose context manager also releases the file handle."""

    def __exit__(self, exc_type, exc_value, traceback):  # type: ignore[no-untyped-def]
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


class CraftStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or ensure_layout()).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db_path = self.root / "craft.db"
        self.initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=15, factory=ClosingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 15000")
        return connection

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def backup(self, destination: Path | None = None) -> dict[str, str]:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        generated = self.root / "backups" / f"craft-{stamp}-{uuid.uuid4().hex[:8]}.db"
        target = (destination or generated).expanduser().resolve()
        if target == self.db_path:
            raise ValueError("Backup destination must differ from the active database")
        target.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as source, closing(sqlite3.connect(target)) as output:
            source.backup(output)
        return {"database": str(self.db_path), "backup": str(target)}

    def doctor(self) -> dict[str, object]:
        issues: list[dict[str, object]] = []
        with self.connect() as db:
            quick = [row[0] for row in db.execute("PRAGMA quick_check").fetchall()]
            if quick != ["ok"]:
                issues.append({"check": "quick_check", "details": quick})
            foreign_keys = [dict(row) for row in db.execute("PRAGMA foreign_key_check").fetchall()]
            if foreign_keys:
                issues.append({"check": "foreign_keys", "details": foreign_keys})
            dangling = db.execute(
                """SELECT COUNT(*) FROM workflow_sessions s
                   LEFT JOIN workflow_executions e ON e.id=s.current_execution_id
                   WHERE s.current_execution_id IS NOT NULL AND e.id IS NULL"""
            ).fetchone()[0]
            if dangling:
                issues.append({"check": "workflow_execution_links", "count": dangling})
            fts_mode = db.execute("SELECT value FROM meta WHERE key='fts'").fetchone()
            if fts_mode and fts_mode["value"] == "trigram":
                capability_count = db.execute("SELECT COUNT(*) FROM capabilities").fetchone()[0]
                fts_count = db.execute("SELECT COUNT(*) FROM capability_fts").fetchone()[0]
                if capability_count != fts_count:
                    issues.append({
                        "check": "capability_fts", "capabilities": capability_count,
                        "indexed": fts_count,
                    })
        return {"healthy": not issues, "database": str(self.db_path), "issues": issues}

    def restore(self, source: Path, confirm: bool = False) -> dict[str, str]:
        if not confirm:
            raise ValueError("confirm=true is required to restore a Craft database")
        source = source.expanduser().resolve()
        if not source.is_file() or source == self.db_path:
            raise ValueError("Restore source must be a separate SQLite backup file")
        with closing(sqlite3.connect(source)) as candidate:
            check = candidate.execute("PRAGMA quick_check").fetchone()[0]
            if check != "ok":
                raise ValueError(f"Restore source failed SQLite quick_check: {check}")
        recovery = self.root / "backups" / f"pre-restore-{uuid.uuid4().hex}.db"
        self.backup(recovery)
        staged = self.root / f".restore-{uuid.uuid4().hex}.db"
        try:
            with closing(sqlite3.connect(source)) as candidate, closing(sqlite3.connect(staged)) as output:
                candidate.backup(output)
            staged.replace(self.db_path)
            self.initialize()
        except Exception:
            if staged.exists():
                staged.unlink()
            recovery.replace(self.db_path)
            self.initialize()
            raise
        return {"database": str(self.db_path), "source": str(source), "recovery_backup": str(recovery)}

    def initialize(self) -> None:
        with self.transaction() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sources (
                    id TEXT PRIMARY KEY,
                    path TEXT NOT NULL UNIQUE,
                    requested_path TEXT,
                    label TEXT,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    scan_generation INTEGER NOT NULL DEFAULT 0,
                    last_scanned_at TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS capabilities (
                    id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL REFERENCES sources(id),
                    kind TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    version TEXT NOT NULL DEFAULT 'unversioned',
                    path TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    digest TEXT NOT NULL,
                    modified_ns INTEGER,
                    size_bytes INTEGER,
                    metadata_json TEXT NOT NULL,
                    body TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_capabilities_source
                    ON capabilities(source_id);
                CREATE INDEX IF NOT EXISTS idx_capabilities_name
                    ON capabilities(name);
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY,
                    project_id TEXT,
                    title TEXT NOT NULL,
                    goal TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS checkpoints (
                    id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL REFERENCES tasks(id),
                    summary TEXT NOT NULL,
                    completed_json TEXT NOT NULL,
                    pending_json TEXT NOT NULL,
                    decisions_json TEXT NOT NULL,
                    artifacts_json TEXT NOT NULL,
                    source TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_checkpoints_task
                    ON checkpoints(task_id, created_at);
                CREATE TABLE IF NOT EXISTS feedback (
                    id TEXT PRIMARY KEY,
                    task_id TEXT REFERENCES tasks(id),
                    kind TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    original TEXT NOT NULL DEFAULT '',
                    corrected TEXT NOT NULL,
                    applies_to TEXT NOT NULL DEFAULT '',
                    source TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_feedback_task
                    ON feedback(task_id, created_at);
                CREATE TABLE IF NOT EXISTS workflows (
                    id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    goal TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    status TEXT NOT NULL,
                    workflow_json TEXT NOT NULL,
                    source_task_id TEXT REFERENCES tasks(id),
                    digest TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(id, version)
                );
                CREATE INDEX IF NOT EXISTS idx_workflows_name
                    ON workflows(name, scope, version DESC);
                CREATE TABLE IF NOT EXISTS workflow_runs (
                    id TEXT PRIMARY KEY,
                    workflow_id TEXT NOT NULL,
                    workflow_version INTEGER NOT NULL,
                    project_root TEXT NOT NULL,
                    inputs_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    attempt INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL,
                    no_progress_count INTEGER NOT NULL DEFAULT 0,
                    last_signature TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(workflow_id, workflow_version)
                        REFERENCES workflows(id, version)
                );
                CREATE TABLE IF NOT EXISTS workflow_attempts (
                    run_id TEXT NOT NULL REFERENCES workflow_runs(id),
                    attempt INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    signature TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(run_id, attempt)
                );
                CREATE INDEX IF NOT EXISTS idx_workflow_attempts_run
                    ON workflow_attempts(run_id, attempt DESC);
                CREATE TABLE IF NOT EXISTS workflow_sessions (
                    id TEXT PRIMARY KEY,
                    workflow_id TEXT NOT NULL,
                    workflow_version INTEGER NOT NULL,
                    project_root TEXT NOT NULL,
                    inputs_json TEXT NOT NULL,
                    context_json TEXT NOT NULL,
                    cursor INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL,
                    transition_count INTEGER NOT NULL DEFAULT 0,
                    max_transitions INTEGER NOT NULL,
                    restored_from_checkpoint TEXT,
                    current_execution_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(workflow_id, workflow_version)
                        REFERENCES workflows(id, version)
                );
                CREATE TABLE IF NOT EXISTS workflow_events (
                    session_id TEXT NOT NULL REFERENCES workflow_sessions(id),
                    sequence INTEGER NOT NULL,
                    step_id TEXT NOT NULL,
                    step_type TEXT NOT NULL,
                    verdict TEXT NOT NULL,
                    provenance TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(session_id, sequence)
                );
                CREATE INDEX IF NOT EXISTS idx_workflow_events_session
                    ON workflow_events(session_id, sequence);
                CREATE TABLE IF NOT EXISTS workflow_executions (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES workflow_sessions(id),
                    step_id TEXT NOT NULL,
                    step_type TEXT NOT NULL,
                    transition_number INTEGER NOT NULL,
                    attempt INTEGER NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    owner TEXT NOT NULL,
                    side_effect TEXT NOT NULL,
                    status TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    result_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(session_id, transition_number, attempt)
                );
                CREATE INDEX IF NOT EXISTS idx_workflow_executions_session
                    ON workflow_executions(session_id, status, created_at);
                CREATE TABLE IF NOT EXISTS workflow_checkpoints (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES workflow_sessions(id),
                    sequence INTEGER NOT NULL,
                    workflow_id TEXT NOT NULL,
                    workflow_version INTEGER NOT NULL,
                    project_root TEXT NOT NULL,
                    inputs_json TEXT NOT NULL,
                    context_json TEXT NOT NULL,
                    cursor INTEGER NOT NULL,
                    provenance TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    digest TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_session
                    ON workflow_checkpoints(session_id, sequence DESC);
                CREATE TABLE IF NOT EXISTS evaluation_suites (
                    id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    scope TEXT NOT NULL,
                    definition_json TEXT NOT NULL,
                    digest TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(id, version)
                );
                CREATE INDEX IF NOT EXISTS idx_evaluation_suites_name
                    ON evaluation_suites(name, scope, version DESC);
                CREATE TABLE IF NOT EXISTS evaluation_runs (
                    id TEXT PRIMARY KEY,
                    suite_id TEXT NOT NULL,
                    suite_version INTEGER NOT NULL,
                    subject_kind TEXT NOT NULL,
                    subject_id TEXT NOT NULL,
                    subject_version TEXT,
                    metadata_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(suite_id, suite_version)
                        REFERENCES evaluation_suites(id, version)
                );
                CREATE INDEX IF NOT EXISTS idx_evaluation_runs_suite
                    ON evaluation_runs(suite_id, suite_version, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_evaluation_runs_subject
                    ON evaluation_runs(subject_kind, subject_id, subject_version, created_at DESC);
                CREATE TABLE IF NOT EXISTS evaluation_results (
                    run_id TEXT NOT NULL REFERENCES evaluation_runs(id),
                    case_id TEXT NOT NULL,
                    verdict TEXT NOT NULL,
                    score REAL,
                    metrics_json TEXT NOT NULL,
                    evidence_json TEXT NOT NULL,
                    notes TEXT NOT NULL DEFAULT '',
                    provenance TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(run_id, case_id)
                );
                CREATE INDEX IF NOT EXISTS idx_evaluation_results_run
                    ON evaluation_results(run_id, case_id);
                CREATE TABLE IF NOT EXISTS agent_profiles (
                    id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    role TEXT NOT NULL,
                    host TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    reasoning_effort TEXT,
                    capabilities_json TEXT NOT NULL,
                    allowed_side_effects_json TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(id, version)
                );
                CREATE INDEX IF NOT EXISTS idx_agent_profiles_role
                    ON agent_profiles(role, host, enabled, version DESC);
                CREATE TABLE IF NOT EXISTS orchestration_plans (
                    id TEXT PRIMARY KEY,
                    task_id TEXT REFERENCES tasks(id),
                    goal TEXT NOT NULL,
                    status TEXT NOT NULL,
                    max_concurrency INTEGER NOT NULL,
                    policy_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS orchestration_nodes (
                    plan_id TEXT NOT NULL REFERENCES orchestration_plans(id),
                    node_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    objective TEXT NOT NULL,
                    depends_on_json TEXT NOT NULL,
                    routes_json TEXT NOT NULL,
                    input_json TEXT NOT NULL,
                    output_schema_json TEXT NOT NULL,
                    evidence_required_json TEXT NOT NULL,
                    side_effect TEXT NOT NULL,
                    status TEXT NOT NULL,
                    attempt INTEGER NOT NULL DEFAULT 0,
                    route_index INTEGER NOT NULL DEFAULT 0,
                    result_json TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(plan_id, node_id)
                );
                CREATE INDEX IF NOT EXISTS idx_orchestration_nodes_plan
                    ON orchestration_nodes(plan_id, status, position);
                CREATE TABLE IF NOT EXISTS orchestration_leases (
                    id TEXT PRIMARY KEY,
                    plan_id TEXT NOT NULL,
                    node_id TEXT NOT NULL,
                    attempt INTEGER NOT NULL,
                    profile_id TEXT NOT NULL,
                    profile_version INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    claimed_by TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    result_json TEXT NOT NULL DEFAULT '{}',
                    provenance TEXT,
                    expires_at TEXT,
                    heartbeat_at TEXT,
                    closed_reason TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(plan_id, node_id)
                        REFERENCES orchestration_nodes(plan_id, node_id),
                    FOREIGN KEY(profile_id, profile_version)
                        REFERENCES agent_profiles(id, version)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestration_lease_attempt
                    ON orchestration_leases(plan_id, node_id, attempt);
                CREATE INDEX IF NOT EXISTS idx_orchestration_leases_plan
                    ON orchestration_leases(plan_id, status, created_at);
                CREATE TABLE IF NOT EXISTS orchestration_events (
                    plan_id TEXT NOT NULL REFERENCES orchestration_plans(id),
                    sequence INTEGER NOT NULL,
                    event_type TEXT NOT NULL,
                    node_id TEXT,
                    lease_id TEXT,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(plan_id, sequence)
                );
                CREATE INDEX IF NOT EXISTS idx_orchestration_events_plan
                    ON orchestration_events(plan_id, sequence);
                CREATE TABLE IF NOT EXISTS artifacts (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    name TEXT NOT NULL,
                    uri TEXT NOT NULL,
                    media_type TEXT,
                    digest TEXT,
                    size_bytes INTEGER,
                    producer_type TEXT,
                    producer_id TEXT,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_artifacts_producer
                    ON artifacts(producer_type, producer_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_artifacts_kind
                    ON artifacts(kind, created_at DESC);
                CREATE TABLE IF NOT EXISTS evidence (
                    id TEXT PRIMARY KEY,
                    source_type TEXT NOT NULL,
                    claim TEXT NOT NULL,
                    confidence TEXT NOT NULL,
                    artifact_id TEXT REFERENCES artifacts(id),
                    locator TEXT,
                    observed_at TEXT NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_evidence_artifact
                    ON evidence(artifact_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_evidence_source
                    ON evidence(source_type, confidence, created_at DESC);
                CREATE TABLE IF NOT EXISTS lineage_edges (
                    id TEXT PRIMARY KEY,
                    from_type TEXT NOT NULL,
                    from_id TEXT NOT NULL,
                    to_type TEXT NOT NULL,
                    to_id TEXT NOT NULL,
                    relation TEXT NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    UNIQUE(from_type, from_id, to_type, to_id, relation)
                );
                CREATE INDEX IF NOT EXISTS idx_lineage_from
                    ON lineage_edges(from_type, from_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_lineage_to
                    ON lineage_edges(to_type, to_id, created_at);
                CREATE TABLE IF NOT EXISTS budgets (
                    id TEXT PRIMARY KEY,
                    owner_type TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_budgets_owner
                    ON budgets(owner_type, owner_id, created_at DESC);
                CREATE TABLE IF NOT EXISTS budget_limits (
                    budget_id TEXT NOT NULL REFERENCES budgets(id),
                    metric TEXT NOT NULL,
                    hard_limit REAL NOT NULL,
                    soft_limit REAL,
                    unit TEXT NOT NULL,
                    PRIMARY KEY(budget_id, metric)
                );
                CREATE TABLE IF NOT EXISTS budget_usage_events (
                    id TEXT PRIMARY KEY,
                    budget_id TEXT NOT NULL REFERENCES budgets(id),
                    metric TEXT NOT NULL,
                    amount REAL NOT NULL,
                    source_type TEXT NOT NULL,
                    source_id TEXT,
                    idempotency_key TEXT,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    UNIQUE(budget_id, metric, idempotency_key)
                );
                CREATE INDEX IF NOT EXISTS idx_budget_usage
                    ON budget_usage_events(budget_id, metric, created_at);
                """
            )
            node_columns = {
                row["name"] for row in db.execute("PRAGMA table_info(orchestration_nodes)").fetchall()
            }
            if "route_index" not in node_columns:
                db.execute("ALTER TABLE orchestration_nodes ADD COLUMN route_index INTEGER NOT NULL DEFAULT 0")
                db.execute(
                    """UPDATE orchestration_nodes SET route_index=CASE
                       WHEN status='pending' AND attempt>0 THEN attempt
                       WHEN attempt>0 THEN attempt-1 ELSE 0 END"""
                )
            lease_columns = {
                row["name"] for row in db.execute("PRAGMA table_info(orchestration_leases)").fetchall()
            }
            for column in ("expires_at", "heartbeat_at", "closed_reason"):
                if column not in lease_columns:
                    db.execute(f"ALTER TABLE orchestration_leases ADD COLUMN {column} TEXT")
            session_columns = {
                row["name"] for row in db.execute("PRAGMA table_info(workflow_sessions)").fetchall()
            }
            if "restored_from_checkpoint" not in session_columns:
                db.execute("ALTER TABLE workflow_sessions ADD COLUMN restored_from_checkpoint TEXT")
            if "current_execution_id" not in session_columns:
                db.execute("ALTER TABLE workflow_sessions ADD COLUMN current_execution_id TEXT")
            source_columns = {
                row["name"] for row in db.execute("PRAGMA table_info(sources)").fetchall()
            }
            if "requested_path" not in source_columns:
                db.execute("ALTER TABLE sources ADD COLUMN requested_path TEXT")
            if "scan_generation" not in source_columns:
                db.execute("ALTER TABLE sources ADD COLUMN scan_generation INTEGER NOT NULL DEFAULT 0")
            db.execute("UPDATE sources SET requested_path=path WHERE requested_path IS NULL")
            capability_sql = db.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='capabilities'"
            ).fetchone()["sql"]
            if "path TEXT NOT NULL UNIQUE" in capability_sql:
                db.executescript(
                    """
                    CREATE TABLE capabilities_v3 (
                        id TEXT PRIMARY KEY,
                        source_id TEXT NOT NULL REFERENCES sources(id),
                        kind TEXT NOT NULL,
                        name TEXT NOT NULL,
                        description TEXT NOT NULL DEFAULT '',
                        version TEXT NOT NULL DEFAULT 'unversioned',
                        path TEXT NOT NULL,
                        relative_path TEXT NOT NULL,
                        digest TEXT NOT NULL,
                        metadata_json TEXT NOT NULL,
                        body TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    INSERT INTO capabilities_v3 SELECT * FROM capabilities;
                    DROP TABLE capabilities;
                    ALTER TABLE capabilities_v3 RENAME TO capabilities;
                    CREATE INDEX idx_capabilities_source ON capabilities(source_id);
                    CREATE INDEX idx_capabilities_name ON capabilities(name);
                    """
                )
            capability_columns = {
                row["name"] for row in db.execute("PRAGMA table_info(capabilities)").fetchall()
            }
            if "modified_ns" not in capability_columns:
                db.execute("ALTER TABLE capabilities ADD COLUMN modified_ns INTEGER")
            if "size_bytes" not in capability_columns:
                db.execute("ALTER TABLE capabilities ADD COLUMN size_bytes INTEGER")
            try:
                db.execute(
                    """CREATE VIRTUAL TABLE IF NOT EXISTS capability_fts
                    USING fts5(asset_id UNINDEXED, name, description, body,
                               tokenize='trigram')"""
                )
                db.execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES('fts', 'trigram')"
                )
                backfilled = db.execute(
                    "SELECT value FROM meta WHERE key='fts_backfill_schema'"
                ).fetchone()
                if not backfilled or backfilled["value"] != str(SCHEMA_VERSION):
                    db.execute("DELETE FROM capability_fts")
                    db.execute(
                        """INSERT INTO capability_fts(asset_id,name,description,body)
                           SELECT id,name,description,body FROM capabilities"""
                    )
                    db.execute(
                        "INSERT OR REPLACE INTO meta(key,value) VALUES('fts_backfill_schema',?)",
                        (str(SCHEMA_VERSION),),
                    )
            except sqlite3.OperationalError:
                db.execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES('fts', 'like')"
                )
            db.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )
