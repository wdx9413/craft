from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .paths import ensure_layout


SCHEMA_VERSION = 7


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
                """
            )
            session_columns = {
                row["name"] for row in db.execute("PRAGMA table_info(workflow_sessions)").fetchall()
            }
            if "restored_from_checkpoint" not in session_columns:
                db.execute("ALTER TABLE workflow_sessions ADD COLUMN restored_from_checkpoint TEXT")
            source_columns = {
                row["name"] for row in db.execute("PRAGMA table_info(sources)").fetchall()
            }
            if "requested_path" not in source_columns:
                db.execute("ALTER TABLE sources ADD COLUMN requested_path TEXT")
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
            try:
                db.execute(
                    """CREATE VIRTUAL TABLE IF NOT EXISTS capability_fts
                    USING fts5(asset_id UNINDEXED, name, description, body,
                               tokenize='trigram')"""
                )
                db.execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES('fts', 'trigram')"
                )
            except sqlite3.OperationalError:
                db.execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES('fts', 'like')"
                )
            db.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )
