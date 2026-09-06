from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from craft_core.catalog import iter_skill_files, parse_skill, stable_id
from craft_core.cli import main as cli_main
from craft_core.mcp import McpServer, main as mcp_main
from craft_core.paths import data_root, ensure_layout
from craft_core.service import CraftService
from craft_core.store import CraftStore


TEST_TMP_ROOT = Path(__file__).resolve().parent / ".tmp"
TEST_TMP_ROOT.mkdir(exist_ok=True)


class CraftServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT)
        self.root = Path(self.temp.name)
        self.service = CraftService(CraftStore(self.root / "data"))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_default_data_path_can_be_isolated(self) -> None:
        old = os.environ.get("CRAFT_DATA_DIR")
        try:
            os.environ.pop("CRAFT_DATA_DIR", None)
            self.assertEqual(data_root(), (Path.home() / ".craft_data").resolve())
            os.environ["CRAFT_DATA_DIR"] = str(self.root / "isolated")
            self.assertEqual(data_root(), (self.root / "isolated").resolve())
        finally:
            if old is None:
                os.environ.pop("CRAFT_DATA_DIR", None)
            else:
                os.environ["CRAFT_DATA_DIR"] = old

    def test_scan_search_and_incremental_update(self) -> None:
        library = self.root / "skills"
        skill = library / "diagnose" / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text(
            "---\nname: evidence-diagnose\ndescription: Diagnose failures with evidence.\n"
            "version: 1.0.0\n---\n\nTrace a service call and verify the result.\n",
            encoding="utf-8",
        )
        source = self.service.source_add(str(library))
        self.assertEqual(source["scan"]["added"], 1)
        found = self.service.capability_search("Diagnose failures")
        self.assertEqual(found["results"][0]["name"], "evidence-diagnose")
        asset = self.service.capability_get(found["results"][0]["id"])
        self.assertIn("verify the result", asset["body"])
        self.assertEqual(self.service.source_scan(source["id"])["unchanged"], 1)

        skill.write_text(skill.read_text(encoding="utf-8") + "Check deployment fingerprint.\n", encoding="utf-8")
        refreshed = self.service.capability_search("deployment fingerprint", stale_after_seconds=0)
        self.assertEqual(refreshed["refreshed_sources"][0]["updated"], 1)
        self.assertEqual(refreshed["results"][0]["name"], "evidence-diagnose")

        skill.unlink()
        removed = self.service.source_scan(source["id"])
        self.assertEqual(removed["removed"], 1)
        self.assertEqual(self.service.capability_search("evidence-diagnose", refresh=False)["results"], [])

    def test_multiple_sources_store_real_paths(self) -> None:
        expected: list[Path] = []
        for index in range(3):
            library = self.root / f"library-{index}"
            library.mkdir()
            (library / "SKILL.md").write_text(
                f"---\nname: source-skill-{index}\ndescription: capability number {index}\n---\n",
                encoding="utf-8",
            )
            expected.append(library.resolve())
            added = self.service.source_add(str(library))
            self.assertEqual(Path(added["real_path"]), library.resolve())
        sources = self.service.source_list()["sources"]
        self.assertEqual(len(sources), 3)
        self.assertEqual({Path(item["real_path"]) for item in sources}, set(expected))

    def test_overlapping_sources_can_index_the_same_real_skill(self) -> None:
        parent = self.root / "library"
        child = parent / "nested"
        child.mkdir(parents=True)
        (child / "SKILL.md").write_text(
            "---\nname: shared-skill\ndescription: available from overlapping roots\n---\n",
            encoding="utf-8",
        )
        first = self.service.source_add(str(parent))
        second = self.service.source_add(str(child))
        self.assertNotEqual(first["id"], second["id"])
        found = self.service.capability_search("overlapping roots", refresh=False)["results"]
        self.assertEqual(len(found), 2)

    def test_source_lifecycle_does_not_delete_source_files(self) -> None:
        library = self.root / "skills"
        library.mkdir()
        skill = library / "SKILL.md"
        skill.write_text("---\nname: keep-me\ndescription: lifecycle test\n---\n", encoding="utf-8")
        source = self.service.source_add(str(library), label="old")
        updated = self.service.source_update(source["id"], enabled=False, label="new")
        self.assertFalse(updated["enabled"])
        self.assertEqual(updated["label"], "new")
        with self.assertRaisesRegex(ValueError, "disabled"):
            self.service.source_scan(source["id"])
        self.service.source_update(source["id"], enabled=True)
        removed = self.service.source_remove(source["id"])
        self.assertEqual(removed["removed_capabilities"], 1)
        self.assertTrue(skill.exists())
        self.assertEqual(self.service.source_list()["sources"], [])
        with self.assertRaisesRegex(ValueError, "Unknown source"):
            self.service.source_remove(source["id"])

    def test_partial_scan_preserves_previous_index(self) -> None:
        library = self.root / "skills"
        library.mkdir()
        skill = library / "SKILL.md"
        skill.write_text("---\nname: durable\ndescription: survives scan errors\n---\n", encoding="utf-8")
        source = self.service.source_add(str(library))
        with patch("craft_core.catalog.os.scandir", side_effect=PermissionError("denied")):
            result = self.service.source_scan(source["id"])
        self.assertFalse(result["complete"])
        self.assertEqual(result["removed"], 0)
        self.assertEqual(self.service.capability_search("survives scan errors", refresh=False)["results"][0]["name"], "durable")

    def test_linked_source_is_resolved_when_supported(self) -> None:
        target = self.root / "linked-target"
        target.mkdir()
        (target / "SKILL.md").write_text(
            "---\nname: linked-skill\ndescription: found through a directory link\n---\n",
            encoding="utf-8",
        )
        link = self.root / "linked-source"
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"Directory links unavailable: {exc}")
        added = self.service.source_add(str(link))
        self.assertEqual(Path(added["real_path"]), target.resolve())
        found = self.service.capability_search("directory link", refresh=False)
        self.assertEqual(Path(found["results"][0]["path"]), (target / "SKILL.md").resolve())

    def test_task_feedback_checkpoint_and_workflow_versions(self) -> None:
        opened = self.service.task_open(title="Analyze a case", goal="Find a supported cause", project_id="demo")
        task_id = opened["task"]["id"]
        self.assertEqual(self.service.task_list(project_id="demo")["tasks"][0]["id"], task_id)
        self.service.feedback_record(
            task_id=task_id,
            kind="process",
            scope="project",
            original="Inspect code only",
            corrected="Verify the effective environment before tracing code",
            applies_to="diagnosis",
        )
        checkpoint = self.service.task_checkpoint(
            task_id,
            "Repository and environment identified.",
            completed=["Located repository"],
            pending=["Trace request"],
            decisions=[{"statement": "Use read-only probes", "source": "user"}],
            artifacts=[{"path": "report.json", "state": "planned"}],
        )
        self.assertEqual(checkpoint["task"]["checkpoints"][0]["pending"], ["Trace request"])
        self.assertEqual(len(checkpoint["task"]["feedback"]), 1)

        first = self.service.workflow_save(
            "Evidence diagnosis",
            "Find a cause supported by scoped evidence",
            [{"id": "context", "action": "resolve_context"}],
            source_task_id=task_id,
            success_criteria=["Each claim cites evidence"],
        )
        second = self.service.workflow_save(
            "Evidence diagnosis",
            "Find a cause supported by scoped evidence",
            [{"id": "context", "action": "resolve_context"}, {"id": "verify", "action": "verify_claim"}],
            source_task_id=task_id,
            workflow_id=first["id"],
        )
        self.assertEqual((first["version"], second["version"]), (1, 2))
        found = self.service.workflow_search("Evidence diagnosis")
        self.assertEqual(found["results"][0]["version"], 2)
        loaded = self.service.workflow_get(first["id"], version=1)
        self.assertEqual(len(loaded["workflow"]["steps"]), 1)

        self.service.task_checkpoint(task_id, "Done", status="completed")
        self.assertEqual(self.service.task_list(status="completed")["tasks"][0]["id"], task_id)
        self.assertEqual(self.service.workflow_search("Evidence", scope="user")["results"][0]["version"], 2)

    def test_validation_errors_are_actionable(self) -> None:
        with self.assertRaisesRegex(ValueError, "does not exist"):
            self.service.source_add(str(self.root / "missing"))
        with self.assertRaisesRegex(ValueError, "enabled or label"):
            self.service.source_update("missing")
        with self.assertRaisesRegex(ValueError, "query must not be empty"):
            self.service.capability_search("", refresh=False)
        with self.assertRaisesRegex(ValueError, "title is required"):
            self.service.task_open()
        with self.assertRaisesRegex(ValueError, "Unknown task"):
            self.service.task_open(task_id="missing")
        with self.assertRaisesRegex(ValueError, "summary must not be empty"):
            self.service.task_checkpoint("missing", " ")
        with self.assertRaisesRegex(ValueError, "Unsupported feedback kind"):
            self.service.feedback_record("x", kind="bad", task_id="missing")
        with self.assertRaisesRegex(ValueError, "task_id is required"):
            self.service.feedback_record("x")
        with self.assertRaisesRegex(ValueError, "at least one step"):
            self.service.workflow_save("", "", [])
        with self.assertRaisesRegex(ValueError, "Unknown workflow"):
            self.service.workflow_get("missing")
        with self.assertRaisesRegex(ValueError, "Unsupported feedback scope"):
            self.service.feedback_record("x", scope="bad", task_id="missing")
        with self.assertRaisesRegex(ValueError, "Unknown task"):
            self.service.feedback_record("x", scope="user", task_id="missing")
        with self.assertRaisesRegex(ValueError, "Unsupported workflow scope"):
            self.service.workflow_save("x", "x", [{}], scope="bad")
        with self.assertRaisesRegex(ValueError, "Unsupported workflow status"):
            self.service.workflow_save("x", "x", [{}], status="bad")
        with self.assertRaisesRegex(ValueError, "Unknown task"):
            self.service.workflow_save("x", "x", [{}], source_task_id="missing")

        task_id = self.service.task_open(title="status test")["task"]["id"]
        with self.assertRaisesRegex(ValueError, "Unsupported task status"):
            self.service.task_checkpoint(task_id, "x", status="bad")

    def test_service_info_scan_all_and_invalid_stale_timestamp(self) -> None:
        library = self.root / "skills"
        library.mkdir()
        (library / "SKILL.md").write_text("short body", encoding="utf-8")
        source = self.service.source_add(str(library), scan=False)
        with self.service.store.transaction() as db:
            db.execute("UPDATE sources SET last_scanned_at='invalid' WHERE id=?", (source["id"],))
        found = self.service.capability_search("short", stale_after_seconds=300)
        self.assertEqual(found["refreshed_sources"][0]["added"], 1)
        self.assertEqual(self.service.source_scan()["count"], 1)
        self.assertEqual(self.service.info()["counts"]["capabilities"], 1)
        with self.assertRaisesRegex(ValueError, "Unknown capability"):
            self.service.capability_get("missing")

    def test_cli_routes_all_source_commands(self) -> None:
        library = self.root / "cli-skills"
        library.mkdir()
        (library / "SKILL.md").write_text(
            "---\nname: cli-skill\ndescription: command route\n---\n", encoding="utf-8"
        )

        def run_cli(*args: str) -> dict:
            output = StringIO()
            with patch("craft_core.cli.CraftService", return_value=self.service), patch.object(
                sys, "argv", ["craft", *args]
            ), redirect_stdout(output):
                cli_main()
            return json.loads(output.getvalue())

        self.assertEqual(run_cli("info")["version"], "0.1.0")
        source = run_cli("add-source", str(library), "--label", "cli")
        source_id = source["id"]
        self.assertEqual(run_cli("list-sources")["sources"][0]["label"], "cli")
        self.assertEqual(run_cli("scan", "--source-id", source_id)["unchanged"], 1)
        self.assertFalse(run_cli("update-source", source_id, "--disable")["enabled"])
        self.assertTrue(run_cli("update-source", source_id, "--enable")["enabled"])
        self.assertEqual(run_cli("search", "command route")["results"][0]["name"], "cli-skill")
        self.assertEqual(run_cli("remove-source", source_id)["removed_capabilities"], 1)

    def test_public_mcp_tool_names_are_prefixed(self) -> None:
        server = McpServer(self.service)
        response = server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
        names = [item["name"] for item in response["result"]["tools"]]
        self.assertTrue(all(name.startswith("craft_") for name in names))
        self.assertIn("craft_source_add", names)
        self.assertIn("craft_source_list", names)
        self.assertIn("craft_workflow_search", names)

    def test_mcp_protocol_errors_and_tool_validation(self) -> None:
        server = McpServer(self.service)
        self.assertIsNone(server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        self.assertEqual(server.handle([])["error"]["code"], -32600)
        self.assertEqual(server.handle({"jsonrpc": "2.0", "id": 1, "method": "unknown"})["error"]["code"], -32601)
        unknown = server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "craft_missing"}})
        self.assertEqual(unknown["error"]["code"], -32602)
        invalid = server.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "craft_capability_get", "arguments": {"asset_id": "missing"}}})
        self.assertTrue(invalid["result"]["isError"])
        fallback = server.handle({"jsonrpc": "2.0", "id": 4, "method": "initialize", "params": {"protocolVersion": "old"}})
        self.assertEqual(fallback["result"]["protocolVersion"], "2025-11-25")
        self.assertEqual(server.handle({"jsonrpc": "2.0", "id": 5, "method": "ping"})["result"], {})
        wrong_args = server.handle({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "craft_info", "arguments": {"extra": True}}})
        self.assertTrue(wrong_args["result"]["isError"])

    def test_mcp_run_writes_parse_errors_and_responses(self) -> None:
        server = McpServer(self.service)
        input_stream = StringIO(
            "bad-json\n"
            + json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"})
            + "\n"
        )
        output_stream = StringIO()
        with patch("craft_core.mcp.sys.stdin", input_stream), patch(
            "craft_core.mcp.sys.stdout", output_stream
        ):
            server.run()
        responses = [json.loads(line) for line in output_stream.getvalue().splitlines()]
        self.assertEqual(responses[0]["error"]["code"], -32700)
        self.assertEqual(responses[1]["result"], {})
        fake = unittest.mock.Mock()
        with patch("craft_core.mcp.McpServer", return_value=fake):
            mcp_main()
        fake.run.assert_called_once()


class CatalogUtilityTests(unittest.TestCase):
    def test_parse_skill_and_stable_id(self) -> None:
        metadata, body = parse_skill("plain body", "fallback")
        self.assertEqual(metadata, {"name": "fallback", "description": ""})
        self.assertEqual(body, "plain body")
        metadata, body = parse_skill("---\nname: 'quoted'\n nested: ignored\n---\nbody", "fallback")
        self.assertEqual(metadata["name"], "quoted")
        self.assertNotIn("nested", metadata)
        self.assertEqual(body, "body")
        self.assertEqual(stable_id("x", "same"), stable_id("x", "same"))
        malformed, malformed_body = parse_skill("---\nname: never-closed", "fallback")
        self.assertEqual(malformed["name"], "fallback")
        self.assertTrue(malformed_body.startswith("---"))

    def test_iterator_skips_known_directories(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temp:
            root = Path(temp)
            (root / "good").mkdir()
            (root / "good" / "SKILL.md").write_text("ok", encoding="utf-8")
            (root / ".git").mkdir()
            (root / ".git" / "SKILL.md").write_text("skip", encoding="utf-8")
            found = list(iter_skill_files(root))
            self.assertEqual(len(found), 1)
            self.assertEqual(found[0][1], "good/SKILL.md")


class StoreMigrationTests(unittest.TestCase):
    def test_v2_unique_path_schema_is_migrated(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temp:
            root = Path(temp)
            root.mkdir(exist_ok=True)
            db = sqlite3.connect(root / "craft.db")
            db.executescript(
                """
                CREATE TABLE sources (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE,
                    requested_path TEXT, label TEXT, enabled INTEGER NOT NULL DEFAULT 1,
                    last_scanned_at TEXT, created_at TEXT NOT NULL);
                CREATE TABLE capabilities (id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL REFERENCES sources(id), kind TEXT NOT NULL,
                    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
                    version TEXT NOT NULL DEFAULT 'unversioned', path TEXT NOT NULL UNIQUE,
                    relative_path TEXT NOT NULL, digest TEXT NOT NULL,
                    metadata_json TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL);
                """
            )
            db.close()
            store = CraftStore(root)
            with store.connect() as migrated:
                sql = migrated.execute("SELECT sql FROM sqlite_master WHERE name='capabilities'").fetchone()["sql"]
                version = migrated.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()["value"]
            self.assertNotIn("path TEXT NOT NULL UNIQUE", sql)
            self.assertEqual(version, "3")

    def test_transaction_rolls_back_and_layout_is_created(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temp:
            old = os.environ.get("CRAFT_DATA_DIR")
            try:
                os.environ["CRAFT_DATA_DIR"] = str(Path(temp) / "layout")
                root = ensure_layout()
                self.assertTrue((root / "artifacts").is_dir())
                store = CraftStore(root)
                with self.assertRaisesRegex(RuntimeError, "rollback"):
                    with store.transaction() as db:
                        db.execute("INSERT INTO meta(key,value) VALUES('temporary','x')")
                        raise RuntimeError("rollback")
                with store.connect() as db:
                    self.assertIsNone(db.execute("SELECT 1 FROM meta WHERE key='temporary'").fetchone())
            finally:
                if old is None:
                    os.environ.pop("CRAFT_DATA_DIR", None)
                else:
                    os.environ["CRAFT_DATA_DIR"] = old


class McpProcessTests(unittest.TestCase):
    def test_stdio_initialize_list_and_info(self) -> None:
        plugin_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temp:
            env = os.environ.copy()
            env["CRAFT_DATA_DIR"] = str(Path(temp) / "craft-data")
            messages = [
                "not-json",
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}},
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "craft_info", "arguments": {}}},
            ]
            payload = "".join((item if isinstance(item, str) else json.dumps(item)) + "\n" for item in messages)
            process = subprocess.run(
                [sys.executable, str(plugin_root / "scripts" / "craft_mcp.py")],
                input=payload,
                text=True,
                capture_output=True,
                env=env,
                cwd=plugin_root,
                timeout=15,
                check=False,
            )
            self.assertEqual(process.returncode, 0, process.stderr)
            responses = [json.loads(line) for line in process.stdout.splitlines()]
            self.assertEqual(responses[0]["error"]["code"], -32700)
            self.assertEqual([item["id"] for item in responses[1:]], [1, 2, 3])
            self.assertEqual(responses[1]["result"]["serverInfo"]["name"], "craft")
            names = [item["name"] for item in responses[2]["result"]["tools"]]
            self.assertIn("craft_capability_search", names)
            self.assertEqual(
                Path(responses[3]["result"]["structuredContent"]["data_root"]),
                (Path(temp) / "craft-data").resolve(),
            )


if __name__ == "__main__":
    unittest.main()
