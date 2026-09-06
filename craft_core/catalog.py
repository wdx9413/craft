from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from collections.abc import Iterator
from typing import Any

from .store import CraftStore


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def stable_id(prefix: str, value: str) -> str:
    return f"{prefix}_{hashlib.sha256(value.encode('utf-8')).hexdigest()[:20]}"


def path_identity(value: str) -> str:
    """Normalize path identity using the current platform's case semantics."""
    return os.path.normcase(value).replace("\\", "/")


def parse_skill(text: str, fallback_name: str) -> tuple[dict[str, str], str]:
    metadata: dict[str, str] = {}
    body = text
    if text.startswith("---"):
        match = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n?", text, re.S)
        if match:
            body = text[match.end() :]
            for line in match.group(1).splitlines():
                if ":" not in line or line[:1].isspace():
                    continue
                key, value = line.split(":", 1)
                value = value.strip().strip("'\"")
                if key.strip() and value:
                    metadata[key.strip()] = value
    metadata.setdefault("name", fallback_name)
    metadata.setdefault("description", "")
    return metadata, body


SKIP_DIRECTORIES = {".git", ".craft_data", "node_modules", "__pycache__"}


def iter_skill_files(root: Path, errors: list[dict[str, str]] | None = None) -> Iterator[tuple[Path, str]]:
    """Yield real and logical Skill paths while following directory links safely."""
    errors = errors if errors is not None else []
    stack: list[tuple[Path, Path]] = [(root, Path("."))]
    visited_directories: set[str] = set()
    while stack:
        directory, logical = stack.pop()
        real_directory = directory.resolve()
        identity = os.path.normcase(str(real_directory))
        if identity in visited_directories:
            continue
        visited_directories.add(identity)
        try:
            entries = list(os.scandir(real_directory))
        except OSError as exc:
            errors.append({"path": str(real_directory), "error": str(exc)})
            continue
        for entry in entries:
            if entry.name in SKIP_DIRECTORIES:
                continue
            logical_child = logical / entry.name
            try:
                if entry.is_dir(follow_symlinks=True):
                    stack.append((Path(entry.path), logical_child))
                elif entry.name == "SKILL.md" and entry.is_file(follow_symlinks=True):
                    path = Path(entry.path)
                    real_path = path.resolve() if entry.is_symlink() else path.absolute()
                    yield real_path, logical_child.as_posix().removeprefix("./")
            except OSError as exc:
                errors.append({"path": str(Path(entry.path)), "error": str(exc)})
                continue


class Catalog:
    def __init__(self, store: CraftStore) -> None:
        self.store = store

    def add_source(self, path: str, label: str | None = None) -> dict[str, Any]:
        requested = Path(path).expanduser().absolute()
        root = requested.resolve()
        if not root.is_dir():
            raise ValueError(f"Source directory does not exist: {root}")
        source_id = stable_id("src", path_identity(str(root)))
        now = utc_now()
        with self.store.transaction() as db:
            db.execute(
                """INSERT INTO sources(id, path, requested_path, label, created_at)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    requested_path=excluded.requested_path,
                    label=COALESCE(excluded.label, sources.label), enabled=1""",
                (source_id, str(root), str(requested), label, now),
            )
            source_id = db.execute(
                "SELECT id FROM sources WHERE path=?", (str(root),)
            ).fetchone()["id"]
        return {
            "id": source_id,
            "requested_path": str(requested),
            "real_path": str(root),
            "label": label,
        }

    def list_sources(self) -> list[dict[str, Any]]:
        with self.store.connect() as db:
            rows = db.execute(
                "SELECT id,requested_path,path,label,enabled,last_scanned_at FROM sources ORDER BY created_at"
            ).fetchall()
        return [
            {
                "id": row["id"], "requested_path": row["requested_path"],
                "real_path": row["path"], "label": row["label"],
                "enabled": bool(row["enabled"]), "last_scanned_at": row["last_scanned_at"],
            }
            for row in rows
        ]

    def update_source(
        self,
        source_id: str,
        *,
        enabled: bool | None = None,
        label: str | None = None,
    ) -> dict[str, Any]:
        if enabled is None and label is None:
            raise ValueError("enabled or label is required")
        with self.store.transaction() as db:
            if not db.execute("SELECT 1 FROM sources WHERE id=?", (source_id,)).fetchone():
                raise ValueError(f"Unknown source: {source_id}")
            if enabled is not None:
                db.execute("UPDATE sources SET enabled=? WHERE id=?", (int(enabled), source_id))
            if label is not None:
                db.execute("UPDATE sources SET label=? WHERE id=?", (label, source_id))
        return next(item for item in self.list_sources() if item["id"] == source_id)

    def remove_source(self, source_id: str) -> dict[str, Any]:
        with self.store.transaction() as db:
            if not db.execute("SELECT 1 FROM sources WHERE id=?", (source_id,)).fetchone():
                raise ValueError(f"Unknown source: {source_id}")
            capability_ids = [
                row["id"]
                for row in db.execute(
                    "SELECT id FROM capabilities WHERE source_id=?", (source_id,)
                ).fetchall()
            ]
            if self._fts_enabled(db):
                db.executemany(
                    "DELETE FROM capability_fts WHERE asset_id=?",
                    ((item,) for item in capability_ids),
                )
            db.execute("DELETE FROM capabilities WHERE source_id=?", (source_id,))
            db.execute("DELETE FROM sources WHERE id=?", (source_id,))
        return {"source_id": source_id, "removed_capabilities": len(capability_ids)}

    def scan_stale(self, stale_after_seconds: int = 300) -> list[dict[str, Any]]:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=max(0, stale_after_seconds))
        stale: list[str] = []
        with self.store.connect() as db:
            rows = db.execute(
                "SELECT id,last_scanned_at FROM sources WHERE enabled=1"
            ).fetchall()
        for row in rows:
            if not row["last_scanned_at"]:
                stale.append(row["id"])
                continue
            try:
                if datetime.fromisoformat(row["last_scanned_at"]) <= cutoff:
                    stale.append(row["id"])
            except ValueError:
                stale.append(row["id"])
        return [self.scan_source(source_id) for source_id in stale]

    def scan_source(self, source_id: str) -> dict[str, Any]:
        with self.store.transaction() as db:
            row = db.execute(
                "SELECT * FROM sources WHERE id=? AND enabled=1", (source_id,)
            ).fetchone()
            if not row:
                raise ValueError(f"Unknown or disabled source: {source_id}")
            generation = row["scan_generation"] + 1
            db.execute(
                "UPDATE sources SET scan_generation=? WHERE id=?", (generation, source_id)
            )
            existing_rows = db.execute(
                """SELECT id,path,digest,modified_ns,size_bytes
                   FROM capabilities WHERE source_id=?""", (source_id,)
            ).fetchall()
        root = Path(row["path"])
        if not root.is_dir():
            raise ValueError(f"Source directory is unavailable: {root}")

        existing = {item["id"]: item for item in existing_rows}
        seen: set[str] = set()
        added = updated = unchanged = failed = 0
        errors: list[dict[str, str]] = []
        changed: list[tuple[Any, ...]] = []
        metadata_refresh: list[tuple[int, int, str]] = []
        for skill_file, relative in iter_skill_files(root, errors):
            resolved_path = str(skill_file)
            asset_id = stable_id("cap", f"{source_id}:{path_identity(relative)}")
            seen.add(asset_id)
            try:
                stat = skill_file.stat()
                old = existing.get(asset_id)
                if (
                    old and old["path"] == resolved_path
                    and old["modified_ns"] == stat.st_mtime_ns
                    and old["size_bytes"] == stat.st_size
                ):
                    unchanged += 1
                    continue
                raw = skill_file.read_bytes()
                text = raw.decode("utf-8")
                digest = hashlib.sha256(raw).hexdigest()
                metadata, body = parse_skill(text, skill_file.parent.name)
                if old and old["digest"] == digest and old["path"] == resolved_path:
                    unchanged += 1
                    metadata_refresh.append((stat.st_mtime_ns, stat.st_size, asset_id))
                    continue
                changed.append(
                    (
                        asset_id, source_id, metadata["name"], metadata["description"],
                        metadata.get("version", "unversioned"), resolved_path, relative,
                        digest, stat.st_mtime_ns, stat.st_size,
                        json.dumps(metadata, ensure_ascii=False), body, utc_now(),
                    )
                )
                if old:
                    updated += 1
                else:
                    added += 1
            except Exception as exc:
                failed += 1
                errors.append({"path": str(skill_file), "error": str(exc)})

        traversal_failed = bool(errors)
        with self.store.transaction() as db:
            current = db.execute(
                "SELECT scan_generation,enabled FROM sources WHERE id=?", (source_id,)
            ).fetchone()
            if not current or not current["enabled"] or current["scan_generation"] != generation:
                return {
                    "source_id": source_id, "added": 0, "updated": 0,
                    "unchanged": 0, "removed": 0, "failed": failed,
                    "errors": errors[:20], "complete": False, "superseded": True,
                }
            fts_enabled = self._fts_enabled(db)
            db.executemany(
                "UPDATE capabilities SET modified_ns=?,size_bytes=? WHERE id=?",
                metadata_refresh,
            )
            for item in changed:
                db.execute(
                    """INSERT INTO capabilities(
                        id, source_id, kind, name, description, version, path,
                        relative_path, digest, modified_ns, size_bytes,
                        metadata_json, body, updated_at
                    ) VALUES(?, ?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        name=excluded.name, description=excluded.description,
                        version=excluded.version, path=excluded.path,
                        digest=excluded.digest, modified_ns=excluded.modified_ns,
                        size_bytes=excluded.size_bytes, metadata_json=excluded.metadata_json,
                        body=excluded.body, updated_at=excluded.updated_at""",
                    item,
                )
                if fts_enabled:
                    db.execute("DELETE FROM capability_fts WHERE asset_id=?", (item[0],))
                    db.execute(
                        "INSERT INTO capability_fts(asset_id,name,description,body) VALUES(?,?,?,?)",
                        (item[0], item[2], item[3], item[11]),
                    )
            # A partial traversal is not authoritative: preserve older rows so a
            # temporary permission or I/O failure cannot erase the usable index.
            removed = [] if traversal_failed else [
                item for item in existing_rows if item["id"] not in seen
            ]
            for item in removed:
                db.execute("DELETE FROM capabilities WHERE id=?", (item["id"],))
                if fts_enabled:
                    db.execute("DELETE FROM capability_fts WHERE asset_id=?", (item["id"],))
            db.execute(
                "UPDATE sources SET last_scanned_at=? WHERE id=?", (utc_now(), source_id)
            )
        return {
            "source_id": source_id, "added": added, "updated": updated,
            "unchanged": unchanged, "removed": len(removed), "failed": failed,
            "errors": errors[:20], "complete": not traversal_failed,
            "superseded": False,
        }

    @staticmethod
    def _fts_enabled(db: sqlite3.Connection) -> bool:
        row = db.execute("SELECT value FROM meta WHERE key='fts'").fetchone()
        return bool(row and row["value"] == "trigram")

    def search(self, query: str, limit: int = 6, kind: str | None = None) -> list[dict[str, Any]]:
        query = query.strip()
        if not query:
            raise ValueError("query must not be empty")
        limit = max(1, min(limit, 20))
        with self.store.connect() as db:
            params: list[Any]
            if self._fts_enabled(db) and len(query) >= 3:
                fts_query = '"' + query.replace('"', '""') + '"'
                sql = """SELECT c.*, bm25(capability_fts, 0.0, 8.0, 4.0, 1.0) AS rank
                         FROM capability_fts JOIN capabilities c ON c.id=capability_fts.asset_id
                         WHERE capability_fts MATCH ?"""
                params = [fts_query]
                if kind:
                    sql += " AND c.kind=?"
                    params.append(kind)
                sql += " ORDER BY rank, c.name LIMIT ?"
                params.append(limit)
                try:
                    rows = db.execute(sql, params).fetchall()
                except sqlite3.OperationalError:
                    rows = []
            else:
                rows = []
            if not rows:
                pattern = f"%{query}%"
                sql = """SELECT *, 0 AS rank FROM capabilities
                         WHERE (name LIKE ? OR description LIKE ? OR body LIKE ?)"""
                params = [pattern, pattern, pattern]
                if kind:
                    sql += " AND kind=?"
                    params.append(kind)
                sql += " ORDER BY CASE WHEN name LIKE ? THEN 0 ELSE 1 END, name LIMIT ?"
                params.extend([pattern, limit])
                rows = db.execute(sql, params).fetchall()
        return [self._card(row) for row in rows]

    def get(self, asset_id: str) -> dict[str, Any]:
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM capabilities WHERE id=?", (asset_id,)).fetchone()
        if not row:
            raise ValueError(f"Unknown capability: {asset_id}")
        result = self._card(row)
        result.update({"body": row["body"], "metadata": json.loads(row["metadata_json"])})
        return result

    @staticmethod
    def _card(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"], "kind": row["kind"], "name": row["name"],
            "description": row["description"], "version": row["version"],
            "path": row["path"], "digest": row["digest"],
        }
