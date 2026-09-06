from __future__ import annotations

import json
import logging
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
from craft_core.installer import install_plugin, main as installer_main, mcp_config, resolved_python
from craft_core.log import get_logger, log_event
from craft_core.mcp import McpServer, main as mcp_main
from craft_core.orchestrator import (
    approved_effects, compile_invariants, external_request, next_cursor,
    normalize_steps, normalize_submission,
)
from craft_core.paths import data_root, ensure_layout
from craft_core.service import CraftService
from craft_core.store import CraftStore
from craft_core.workflow_runtime import (
    _git_changed_lines,
    assertion_step,
    command_step,
    coverage_gate,
    execute_steps,
    failure_signature,
    redact_output,
    resolve_inputs,
    safe_path,
    substitute,
)


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

    def test_evaluation_suite_runs_and_comparison(self) -> None:
        cases = [
            {
                "id": "correct",
                "name": "Produces the expected answer",
                "input": {"question": "2+2"},
                "expected": {"answer": 4},
                "graders": [{"type": "exact_match", "field": "answer"}],
                "tags": ["quality"],
                "weight": 1,
            },
            {
                "id": "safe",
                "name": "Avoids an unsafe action",
                "weight": 3,
            },
        ]
        first_suite = self.service.eval_suite_save("Core behavior", cases, "Stable cases")
        second_suite = self.service.eval_suite_save(
            "Core behavior", cases, "Stable cases v2", suite_id=first_suite["id"]
        )
        self.assertEqual((first_suite["version"], second_suite["version"]), (1, 2))
        self.assertEqual(self.service.eval_suite_get(first_suite["id"])["version"], 2)
        self.assertEqual(
            self.service.eval_suite_list(query="stable cases", scope="user")["suites"][0]["case_count"],
            2,
        )
        self.assertEqual(
            self.service.eval_suite_get(first_suite["id"], 1)["suite"]["cases"][0]["weight"],
            1.0,
        )

        baseline = self.service.eval_run_start(
            first_suite["id"], "workflow", "answer-flow", 1, "1", {"model": "demo"}
        )
        self.assertEqual(baseline["status"], "running")
        self.assertEqual(baseline["summary"]["completion_rate"], 0.0)
        baseline = self.service.eval_result_submit(
            baseline["id"], "correct", "passed", 0.8,
            {"latency_ms": 12}, [{"ref": "result.json"}], "checked", "program_verified",
        )
        self.assertEqual(baseline["summary"]["submitted_cases"], 1)
        baseline = self.service.eval_result_submit(baseline["id"], "safe", "passed")
        self.assertEqual(baseline["status"], "completed")
        self.assertEqual(baseline["summary"]["pass_rate"], 1.0)
        self.assertEqual(baseline["summary"]["weighted_score"], 0.95)
        self.assertEqual(baseline["results"][0]["metrics"], {"latency_ms": 12})

        candidate = self.service.eval_run_start(
            first_suite["id"], "workflow", "answer-flow", 1, "2"
        )
        candidate = self.service.eval_result_submit(candidate["id"], "correct", "failed", 0.5)
        candidate = self.service.eval_result_submit(candidate["id"], "safe", "skipped")
        self.assertIsNone(candidate["results"][1]["score"])
        listed_runs = self.service.eval_run_list(
            suite_id=first_suite["id"], subject_kind="workflow",
            subject_id="answer-flow", status="completed",
        )["runs"]
        self.assertEqual({item["id"] for item in listed_runs}, {baseline["id"], candidate["id"]})
        compared = self.service.eval_compare([baseline["id"], candidate["id"]])
        self.assertEqual(compared["baseline_run_id"], baseline["id"])
        self.assertEqual(compared["runs"][0]["delta"]["pass_rate"], 0.0)
        self.assertEqual(compared["runs"][1]["delta"]["pass_rate"], -1.0)
        self.assertEqual(compared["runs"][1]["delta"]["weighted_score"], -0.45)
        self.assertEqual(self.service.info()["counts"]["evaluation_results"], 4)

    def test_evaluation_validation_and_partial_metrics(self) -> None:
        with self.assertRaisesRegex(ValueError, "name and at least one"):
            self.service.eval_suite_save("", [])
        with self.assertRaisesRegex(ValueError, "Unsupported evaluation suite scope"):
            self.service.eval_suite_save("x", [{"id": "a", "name": "A"}], scope="bad")
        invalid_cases = [
            (["bad"], "must be an object"),
            ([{"id": "", "name": "A"}], "requires id and name"),
            ([{"id": "a", "name": "A"}, {"id": "a", "name": "B"}], "Duplicate"),
            ([{"id": "a", "name": "A", "weight": True}], "positive number"),
            ([{"id": "a", "name": "A", "weight": 0}], "positive number"),
            ([{"id": "a", "name": "A", "tags": [1]}], "tags must be strings"),
            ([{"id": "a", "name": "A", "graders": ["judge"]}], "graders must be objects"),
        ]
        for cases, message in invalid_cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                self.service.eval_suite_save("bad", cases)  # type: ignore[arg-type]
        with self.assertRaisesRegex(ValueError, "Unknown evaluation suite"):
            self.service.eval_suite_get("missing")
        with self.assertRaisesRegex(ValueError, "Unsupported evaluation suite scope"):
            self.service.eval_suite_list(scope="bad")
        self.assertEqual(self.service.eval_suite_list(query=" ")["suites"], [])

        suite = self.service.eval_suite_save("One", [{"id": "a", "name": "A"}])
        self.assertEqual(self.service.eval_run_list()["runs"], [])
        with self.assertRaisesRegex(ValueError, "Unsupported evaluation subject kind"):
            self.service.eval_run_start(suite["id"], "unknown", "x")
        with self.assertRaisesRegex(ValueError, "subject_id must not be empty"):
            self.service.eval_run_start(suite["id"], "skill", " ")
        with self.assertRaisesRegex(ValueError, "Unknown evaluation run"):
            self.service.eval_run_get("missing")
        with self.assertRaisesRegex(ValueError, "Unsupported evaluation subject kind"):
            self.service.eval_run_list(subject_kind="unknown")
        with self.assertRaisesRegex(ValueError, "Unsupported evaluation run status"):
            self.service.eval_run_list(status="failed")
        run = self.service.eval_run_start(suite["id"], "skill", "sample")
        with self.assertRaisesRegex(ValueError, "Unsupported evaluation verdict"):
            self.service.eval_result_submit(run["id"], "a", "unknown")
        for score in (True, -0.1, 1.1):
            with self.subTest(score=score), self.assertRaisesRegex(ValueError, "between 0 and 1"):
                self.service.eval_result_submit(run["id"], "a", "passed", score)  # type: ignore[arg-type]
        with self.assertRaisesRegex(ValueError, "Unsupported evaluation provenance"):
            self.service.eval_result_submit(run["id"], "a", "passed", provenance="guessed")
        with self.assertRaisesRegex(ValueError, "Unknown evaluation case"):
            self.service.eval_result_submit(run["id"], "missing", "passed")
        completed = self.service.eval_result_submit(run["id"], "a", "blocked")
        self.assertIsNone(completed["summary"]["pass_rate"])
        self.assertIsNone(completed["summary"]["weighted_score"])
        with self.assertRaisesRegex(ValueError, "already completed"):
            self.service.eval_result_submit(run["id"], "a", "passed")

        multi_suite = self.service.eval_suite_save(
            "Multi", [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}]
        )
        duplicate_run = self.service.eval_run_start(multi_suite["id"], "agent", "sample")
        self.service.eval_result_submit(duplicate_run["id"], "a", "failed")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.service.eval_result_submit(duplicate_run["id"], "a", "failed")
        with self.assertRaisesRegex(ValueError, "At least two"):
            self.service.eval_compare([run["id"]])
        with self.assertRaisesRegex(ValueError, "must be unique"):
            self.service.eval_compare([run["id"], run["id"]])
        newer_suite = self.service.eval_suite_save(
            "One", [{"id": "a", "name": "A"}], suite_id=suite["id"]
        )
        newer_run = self.service.eval_run_start(newer_suite["id"], "skill", "sample", 2)
        with self.assertRaisesRegex(ValueError, "same suite version"):
            self.service.eval_compare([run["id"], newer_run["id"]])
        self.assertIsNone(self.service._metric_delta(None, 1.0))

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
        with self.assertRaisesRegex(ValueError, "Unknown task"):
            self.service.task_checkpoint("missing", "nonempty")
        with self.assertRaisesRegex(ValueError, "corrected must not be empty"):
            self.service.feedback_record(" ", scope="user")
        with self.assertRaisesRegex(ValueError, "Unsupported feedback kind"):
            self.service.feedback_record("x", kind="bad", task_id="missing")
        with self.assertRaisesRegex(ValueError, "task_id is required"):
            self.service.feedback_record("x")
        with self.assertRaisesRegex(ValueError, "at least one step"):
            self.service.workflow_save("", "", [])
        with self.assertRaisesRegex(ValueError, "Unknown workflow"):
            self.service.workflow_get("missing")
        with self.assertRaisesRegex(ValueError, "query must not be empty"):
            self.service.workflow_search(" ")
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

    def test_catalog_fallback_paths_and_scan_failures(self) -> None:
        library = self.root / "fallback-skills"
        library.mkdir()
        for name in ("first", "second"):
            folder = library / name
            folder.mkdir()
            (folder / "SKILL.md").write_text(
                f"---\nname: {name}\ndescription: fallback searchable {name}\n---\nbody",
                encoding="utf-8",
            )
        source = self.service.source_add(str(library), scan=False)
        self.assertEqual(self.service.catalog.scan_stale()[0]["added"], 2)
        self.assertEqual(self.service.catalog.scan_stale(3600), [])
        self.service.source_update(source["id"], label="fallback-only")
        with self.assertRaisesRegex(ValueError, "Unknown source"):
            self.service.source_update("missing", enabled=True)

        self.assertEqual(len(self.service.catalog.search("fallback", kind="skill")), 2)
        self.assertEqual(self.service.catalog.search("fi", kind="skill")[0]["name"], "first")
        with self.service.store.transaction() as db:
            db.execute("DROP TABLE capability_fts")
        self.assertEqual(self.service.catalog.search("searchable", kind="skill")[0]["kind"], "skill")

        with self.service.store.transaction() as db:
            db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('fts','like')")
        for path in library.rglob("SKILL.md"):
            path.write_text(path.read_text(encoding="utf-8") + "\nupdated", encoding="utf-8")
        self.assertEqual(self.service.source_scan(source["id"])["updated"], 2)
        for path in library.rglob("SKILL.md"):
            path.unlink()
        removed = self.service.source_scan(source["id"])
        self.assertEqual(removed["removed"], 2)
        empty_remove = self.service.source_remove(source["id"])
        self.assertEqual(empty_remove["removed_capabilities"], 0)

        unavailable = self.root / "unavailable"
        unavailable.mkdir()
        unavailable_source = self.service.source_add(str(unavailable), scan=False)
        unavailable.rmdir()
        with self.assertRaisesRegex(ValueError, "unavailable"):
            self.service.source_scan(unavailable_source["id"])

    def test_invalid_utf8_skill_is_reported_without_aborting_scan(self) -> None:
        library = self.root / "bad-encoding"
        library.mkdir()
        (library / "SKILL.md").write_bytes(b"\xff\xfe")
        result = self.service.source_add(str(library))["scan"]
        self.assertEqual(result["failed"], 1)
        self.assertFalse(result["complete"])

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

        cases_json = json.dumps([{"id": "case", "name": "CLI case"}])
        suite = run_cli(
            "eval-suite-save", "CLI suite", cases_json,
            "--description", "from cli", "--scope", "project",
        )
        loaded = run_cli("eval-suite-get", suite["id"], "--version", "1")
        self.assertEqual(loaded["suite"]["description"], "from cli")
        self.assertEqual(
            run_cli("eval-suite-list", "--query", "CLI", "--scope", "project")["suites"][0]["id"],
            suite["id"],
        )
        run = run_cli(
            "eval-run-start", suite["id"], "system", "craft",
            "--suite-version", "1", "--subject-version", "0.1",
            "--metadata-json", '{"client":"cli"}',
        )
        submitted = run_cli(
            "eval-result-submit", run["id"], "case", "passed", "--score", "0.9",
            "--metrics-json", '{"latency":1}', "--evidence-json", '[{"ref":"test"}]',
            "--notes", "ok", "--provenance", "program_verified",
        )
        self.assertEqual(submitted["status"], "completed")
        self.assertEqual(run_cli("eval-run-get", run["id"])["summary"]["weighted_score"], 0.9)
        self.assertEqual(
            run_cli(
                "eval-run-list", "--suite-id", suite["id"], "--subject-kind", "system",
                "--subject-id", "craft", "--status", "completed",
            )["runs"][0]["id"],
            run["id"],
        )
        second = run_cli("eval-run-start", suite["id"], "system", "craft-next")
        run_cli("eval-result-submit", second["id"], "case", "failed")
        self.assertEqual(run_cli("eval-compare", run["id"], second["id"])["runs"][1]["delta"]["pass_rate"], -1.0)

    def test_public_mcp_tool_names_are_prefixed(self) -> None:
        server = McpServer(self.service)
        response = server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
        names = [item["name"] for item in response["result"]["tools"]]
        self.assertTrue(all(name.startswith("craft_") for name in names))
        self.assertIn("craft_source_add", names)
        self.assertIn("craft_source_list", names)
        self.assertIn("craft_workflow_search", names)
        self.assertIn("craft_eval_suite_save", names)
        self.assertIn("craft_eval_compare", names)

    def test_mcp_protocol_errors_and_tool_validation(self) -> None:
        server = McpServer(self.service)
        self.assertIsNone(server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        self.assertEqual(server.handle([])["error"]["code"], -32600)
        self.assertEqual(server.handle({"jsonrpc": "2.0", "id": 1, "method": "unknown"})["error"]["code"], -32601)
        unknown = server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "craft_missing"}})
        self.assertEqual(unknown["error"]["code"], -32602)
        invalid = server.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "craft_capability_get", "arguments": {"asset_id": "missing"}}})
        self.assertTrue(invalid["result"]["isError"])
        success = server.handle({"jsonrpc": "2.0", "id": 31, "method": "tools/call", "params": {"name": "craft_info", "arguments": {}}})
        self.assertFalse(success["result"]["isError"])
        fallback = server.handle({"jsonrpc": "2.0", "id": 4, "method": "initialize", "params": {"protocolVersion": "old"}})
        self.assertEqual(fallback["result"]["protocolVersion"], "2025-11-25")
        self.assertEqual(server.handle({"jsonrpc": "2.0", "id": 5, "method": "ping"})["result"], {})
        wrong_args = server.handle({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "craft_info", "arguments": {"extra": True}}})
        self.assertTrue(wrong_args["result"]["isError"])

    def test_mcp_run_writes_parse_errors_and_responses(self) -> None:
        server = McpServer(self.service)
        input_stream = StringIO(
            "bad-json\n"
            + json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"})
            + "\n"
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

        failing = McpServer(self.service)
        with patch.object(failing, "handle", side_effect=RuntimeError("boom")), patch(
            "craft_core.mcp.sys.stdin", StringIO('{"jsonrpc":"2.0","id":2}\n')
        ), patch("craft_core.mcp.sys.stderr", StringIO()) as stderr:
            failing.run()
        self.assertIn("RuntimeError: boom", stderr.getvalue())


class CatalogUtilityTests(unittest.TestCase):
    def test_stderr_logging_is_concise_and_configurable(self) -> None:
        logger = logging.getLogger("craft")
        for handler in list(logger.handlers):
            if getattr(handler, "_craft_handler", False):
                logger.removeHandler(handler)
        with patch.dict(os.environ, {"CRAFT_LOG_LEVEL": "not-a-level"}):
            logger = get_logger()
        self.assertEqual(logger.level, logging.INFO)
        self.assertTrue(any(getattr(item, "_craft_handler", False) for item in logger.handlers))
        with self.assertLogs("craft", level="INFO") as captured:
            log_event(logger, "empty", omitted=None)
            log_event(logger, "sample", session_id="session_1", status="passed")
        self.assertIn("event=empty", captured.output[0])
        self.assertIn("session_id=session_1 status=passed", captured.output[1])

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
        sparse, _ = parse_skill(
            "---\nno-colon\n: no-key\nempty:\nvalid: yes\n---\nbody", "fallback"
        )
        self.assertEqual(sparse["valid"], "yes")

    def test_iterator_handles_cycles_and_entry_errors(self) -> None:
        class Entry:
            def __init__(self, name: str, path: Path, mode: str) -> None:
                self.name = name
                self.path = str(path)
                self.mode = mode

            def is_dir(self, follow_symlinks: bool = True) -> bool:
                if self.mode == "error":
                    raise OSError("entry denied")
                return self.mode == "dir"

            def is_file(self, follow_symlinks: bool = True) -> bool:
                return self.mode == "file"

        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temp:
            root = Path(temp).resolve()
            errors: list[dict[str, str]] = []
            entries = [
                Entry("cycle", root, "dir"),
                Entry("broken", root / "broken", "error"),
                Entry("SKILL.md", root / "not-a-file", "other"),
                Entry("ordinary.txt", root / "ordinary.txt", "file"),
            ]
            with patch("craft_core.catalog.os.scandir", return_value=entries):
                self.assertEqual(list(iter_skill_files(root, errors)), [])
            self.assertEqual(errors[0]["error"], "entry denied")

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
                    label TEXT, enabled INTEGER NOT NULL DEFAULT 1,
                    last_scanned_at TEXT, created_at TEXT NOT NULL);
                CREATE TABLE capabilities (id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL REFERENCES sources(id), kind TEXT NOT NULL,
                    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
                    version TEXT NOT NULL DEFAULT 'unversioned', path TEXT NOT NULL UNIQUE,
                    relative_path TEXT NOT NULL, digest TEXT NOT NULL,
                    metadata_json TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE workflow_sessions (
                    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL,
                    workflow_version INTEGER NOT NULL, project_root TEXT NOT NULL,
                    inputs_json TEXT NOT NULL, context_json TEXT NOT NULL,
                    cursor INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
                    transition_count INTEGER NOT NULL DEFAULT 0,
                    max_transitions INTEGER NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                """
            )
            db.close()
            store = CraftStore(root)
            with store.connect() as migrated:
                sql = migrated.execute("SELECT sql FROM sqlite_master WHERE name='capabilities'").fetchone()["sql"]
                version = migrated.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()["value"]
                session_columns = {
                    row["name"] for row in migrated.execute("PRAGMA table_info(workflow_sessions)")
                }
            self.assertNotIn("path TEXT NOT NULL UNIQUE", sql)
            self.assertEqual(version, "7")
            self.assertIn("restored_from_checkpoint", session_columns)

    def test_store_falls_back_when_fts5_is_unavailable(self) -> None:
        from craft_core.store import ClosingConnection

        original_connect = sqlite3.connect

        class NoFtsConnection(ClosingConnection):
            def execute(self, sql, parameters=()):  # type: ignore[no-untyped-def]
                if "CREATE VIRTUAL TABLE" in sql:
                    raise sqlite3.OperationalError("fts5 unavailable")
                return super().execute(sql, parameters)

        def no_fts_connect(*args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs["factory"] = NoFtsConnection
            return original_connect(*args, **kwargs)

        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temp, patch(
            "craft_core.store.sqlite3.connect", side_effect=no_fts_connect
        ):
            store = CraftStore(Path(temp))
            with store.connect() as db:
                self.assertEqual(
                    db.execute("SELECT value FROM meta WHERE key='fts'").fetchone()["value"],
                    "like",
                )

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


class CrossPlatformInstallTests(unittest.TestCase):
    def test_marketplace_and_plugin_distribution_metadata(self) -> None:
        plugin_root = Path(__file__).resolve().parents[1]
        marketplace = json.loads(
            (plugin_root / ".agents" / "plugins" / "marketplace.json").read_text(
                encoding="utf-8"
            )
        )
        entry = marketplace["plugins"][0]
        self.assertEqual(marketplace["name"], "craft-marketplace")
        self.assertEqual(entry["name"], "craft")
        self.assertEqual(entry["source"]["source"], "url")
        self.assertEqual(entry["source"]["url"], "https://github.com/wdx9413/craft.git")
        self.assertEqual(entry["policy"]["installation"], "AVAILABLE")

        manifest = json.loads(
            (plugin_root / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8")
        )
        self.assertEqual(manifest["repository"], "https://github.com/wdx9413/craft")
        self.assertEqual(manifest["mcpServers"], "./.mcp.json")

        mcp = json.loads((plugin_root / ".mcp.json").read_text(encoding="utf-8"))
        server = mcp["mcpServers"]["craft"]
        self.assertEqual(server["command"], "uvx")
        self.assertEqual(
            server["args"],
            ["--from", "craft-agent-harness==0.1.0", "craft-mcp"],
        )

    def test_installer_generates_absolute_python_mcp_command(self) -> None:
        plugin_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temp:
            target = Path(temp) / "installed" / "craft"
            result = install_plugin(plugin_root, target, sys.executable)
            config = json.loads((target / ".mcp.json").read_text(encoding="utf-8"))
            self.assertEqual(config["mcpServers"]["craft"]["command"], resolved_python())
            self.assertEqual(result["plugin_root"], str(target.resolve()))
            self.assertTrue((target / ".codex-plugin" / "plugin.json").is_file())
            self.assertTrue((target / ".claude-plugin" / "plugin.json").is_file())
            self.assertTrue((target / "README.en.md").is_file())
            self.assertTrue((target / "docs" / "architecture.zh-CN.md").is_file())
            self.assertFalse((target / "tests").exists())
            message = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {"protocolVersion": "2025-11-25"},
                }
            )
            environment = os.environ.copy()
            environment["CRAFT_DATA_DIR"] = str(Path(temp) / "installed-data")
            process = subprocess.run(
                [
                    config["mcpServers"]["craft"]["command"],
                    *config["mcpServers"]["craft"]["args"],
                ],
                input=message + "\n",
                text=True,
                capture_output=True,
                cwd=target,
                env=environment,
                timeout=15,
                check=False,
            )
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(json.loads(process.stdout)["result"]["serverInfo"]["name"], "craft")

    def test_installer_validates_paths_and_supports_atomic_update(self) -> None:
        plugin_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temp:
            target = Path(temp) / "craft"
            install_plugin(plugin_root, target)
            (target / "stale.txt").write_text("old", encoding="utf-8")
            install_plugin(plugin_root, target)
            self.assertFalse((target / "stale.txt").exists())
            with self.assertRaisesRegex(ValueError, "dedicated directory"):
                install_plugin(plugin_root, plugin_root)
            with self.assertRaisesRegex(ValueError, "does not exist"):
                resolved_python(str(Path(temp) / "missing-python"))
            self.assertEqual(mcp_config()["mcpServers"]["craft"]["cwd"], ".")

    def test_installer_missing_item_failure_and_recovery(self) -> None:
        plugin_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temp:
            temp_root = Path(temp)
            with self.assertRaisesRegex(ValueError, "Plugin item is missing"):
                install_plugin(temp_root / "empty-source", temp_root / "target")

            original_copytree = __import__("shutil").copytree
            target = temp_root / "recover" / "craft"
            install_plugin(plugin_root, target)
            marker = target / "marker.txt"
            marker.write_text("keep", encoding="utf-8")

            def fail_with_partial(source, destination, *args, **kwargs):  # type: ignore[no-untyped-def]
                if Path(destination) == target:
                    target.mkdir(parents=True)
                    raise RuntimeError("copy failed")
                return original_copytree(source, destination, *args, **kwargs)

            with patch("craft_core.installer.shutil.copytree", side_effect=fail_with_partial):
                with self.assertRaisesRegex(RuntimeError, "copy failed"):
                    install_plugin(plugin_root, target)
            self.assertEqual(marker.read_text(encoding="utf-8"), "keep")

            absent = temp_root / "absent" / "craft"

            def fail_without_partial(source, destination, *args, **kwargs):  # type: ignore[no-untyped-def]
                if Path(destination) == absent:
                    raise RuntimeError("copy failed empty")
                return original_copytree(source, destination, *args, **kwargs)

            with patch("craft_core.installer.shutil.copytree", side_effect=fail_without_partial):
                with self.assertRaisesRegex(RuntimeError, "copy failed empty"):
                    install_plugin(plugin_root, absent)
            self.assertFalse(absent.exists())

    def test_installer_main_prints_result(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temp:
            target = Path(temp) / "craft"
            output = StringIO()
            with patch.object(sys, "argv", ["craft-install", "--target", str(target)]), redirect_stdout(output):
                installer_main()
            self.assertEqual(json.loads(output.getvalue())["plugin_root"], str(target.resolve()))


class WorkflowRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT)
        self.root = Path(self.temp.name).resolve()
        self.service = CraftService(CraftStore(self.root / "data"))
        self.project = self.root / "project"
        self.project.mkdir()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_plan_run_and_read_passed_workflow(self) -> None:
        workflow = self.service.workflow_save(
            "Verified artifact",
            "Create and verify an artifact",
            inputs=[{"name": "python", "required": True}],
            preconditions=[
                {"id": "root", "type": "assertion", "evaluator": "file_exists", "path": "."}
            ],
            steps=[
                {
                    "id": "create",
                    "type": "command",
                    "command": [
                        "{{python}}",
                        "-c",
                        "import json; open('result.json','w').write(json.dumps({'ok': True}))",
                    ],
                }
            ],
            success_criteria=[
                {
                    "id": "content",
                    "type": "assertion",
                    "evaluator": "json_value",
                    "path": "result.json",
                    "field": "ok",
                    "expected": True,
                }
            ],
            repair_policy={"enabled": True, "max_attempts": 3},
            artifacts=[{"path": "result.json"}],
        )
        plan = self.service.workflow_plan(
            workflow["id"], str(self.project), inputs={"python": sys.executable}
        )
        self.assertTrue(plan["requires_execution_approval"])
        self.assertEqual(plan["steps"][1]["command"][0], sys.executable)
        with self.assertRaisesRegex(ValueError, "allow_execution"):
            self.service.workflow_run(
                workflow["id"], str(self.project), inputs={"python": sys.executable}
            )
        receipt = self.service.workflow_run(
            workflow["id"], str(self.project), inputs={"python": sys.executable},
            allow_execution=True,
        )
        self.assertEqual(receipt["status"], "passed")
        run = self.service.workflow_run_get(receipt["run_id"])
        self.assertEqual(run["attempts"][0]["status"], "passed")
        self.assertEqual(run["inputs"]["python"], sys.executable)
        self.assertEqual(self.service.workflow_get(workflow["id"])["status"], "tested")
        with self.assertRaisesRegex(ValueError, "cannot resume"):
            self.service.workflow_run(
                workflow["id"], str(self.project), inputs={"python": sys.executable},
                run_id=receipt["run_id"], allow_execution=True,
            )

    def test_repair_loop_stops_on_no_progress(self) -> None:
        workflow = self.service.workflow_save(
            "Failing check", "Exercise bounded repair",
            [{"id": "fail", "type": "command", "command": [sys.executable, "-c", "raise SystemExit(2)"]}],
            repair_policy={"enabled": True, "max_attempts": 4, "no_progress_limit": 1},
        )
        first = self.service.workflow_run(
            workflow["id"], str(self.project), allow_execution=True
        )
        self.assertEqual(first["status"], "needs_repair")
        second = self.service.workflow_run(
            workflow["id"], str(self.project), run_id=first["run_id"], allow_execution=True
        )
        self.assertEqual(second["status"], "no_progress")
        self.assertIsNone(second["next_action"])
        with self.assertRaisesRegex(ValueError, "cannot resume"):
            self.service.workflow_run(
                workflow["id"], str(self.project), run_id=first["run_id"], allow_execution=True
            )

    def test_run_validation_and_immediate_failure(self) -> None:
        workflow = self.service.workflow_save(
            "One shot", "Fail once",
            [{"type": "command", "command": [sys.executable, "-c", "raise SystemExit(1)"]}],
        )
        failed = self.service.workflow_run(
            workflow["id"], str(self.project), allow_execution=True
        )
        self.assertEqual(failed["status"], "failed")
        with self.assertRaisesRegex(ValueError, "Unknown workflow run"):
            self.service.workflow_run_get("missing")
        with self.assertRaisesRegex(ValueError, "Unknown workflow run"):
            self.service.workflow_run(
                workflow["id"], str(self.project), run_id="missing", allow_execution=True
            )
        other = self.service.workflow_save(
            "Other", "Other", [{"type": "assertion", "evaluator": "file_exists", "path": "."}]
        )
        with self.service.store.transaction() as db:
            db.execute("UPDATE workflow_runs SET status='needs_repair' WHERE id=?", (failed["run_id"],))
        with self.assertRaisesRegex(ValueError, "different workflow"):
            self.service.workflow_run(
                other["id"], str(self.project), run_id=failed["run_id"], allow_execution=True
            )
        with self.assertRaisesRegex(ValueError, "different project root"):
            self.service.workflow_run(
                workflow["id"], str(self.root), run_id=failed["run_id"], allow_execution=True
            )
        input_workflow = self.service.workflow_save(
            "Input run", "Keep inputs stable",
            [{"type": "command", "command": [sys.executable, "-c", "raise SystemExit(1)"]}],
            inputs=[{"name": "value", "required": True}],
            repair_policy={"enabled": True, "max_attempts": 2},
        )
        input_run = self.service.workflow_run(
            input_workflow["id"], str(self.project), inputs={"value": "first"}, allow_execution=True
        )
        with self.assertRaisesRegex(ValueError, "different resolved inputs"):
            self.service.workflow_run(
                input_workflow["id"], str(self.project), inputs={"value": "second"},
                run_id=input_run["run_id"], allow_execution=True,
            )

    def test_plan_validation_and_template_resolution(self) -> None:
        definitions = [
            {"name": "defaulted", "default": 3},
            {"name": "required", "required": True},
        ]
        self.assertEqual(resolve_inputs(definitions, {"required": "x"}), {"defaulted": 3, "required": "x"})
        with self.assertRaisesRegex(ValueError, "non-empty name"):
            resolve_inputs([{}], {})
        with self.assertRaisesRegex(ValueError, "Missing required"):
            resolve_inputs([{"name": "x", "required": True}], {})
        value = substitute(
            {"list": ["{{number}}", "prefix-{{text}}", 4]}, {"number": 2, "text": "ok"}
        )
        self.assertEqual(value, {"list": [2, "prefix-ok", 4]})
        with self.assertRaisesRegex(ValueError, "Unknown workflow input"):
            substitute("{{missing}}", {})
        with self.assertRaisesRegex(ValueError, "Unknown workflow input"):
            substitute("x-{{missing}}", {})

        bad = self.service.workflow_save("Bad", "Bad", [{"type": "unknown"}])
        with self.assertRaisesRegex(ValueError, "Unsupported workflow step"):
            self.service.workflow_plan(bad["id"], str(self.project))
        advisory = self.service.workflow_save(
            "Advisory", "Old format", [{"type": "assertion", "evaluator": "file_exists", "path": "."}],
            success_criteria=["looks good"],
        )
        with self.assertRaisesRegex(ValueError, "structured success_criteria"):
            self.service.workflow_plan(advisory["id"], str(self.project))
        with self.assertRaisesRegex(ValueError, "Project root does not exist"):
            self.service.workflow_plan(bad["id"], str(self.project / "missing"))

    def test_command_assertion_and_path_helpers(self) -> None:
        with self.assertRaisesRegex(ValueError, "escapes project root"):
            safe_path(self.project, "../outside")
        with self.assertRaisesRegex(ValueError, "non-empty string array"):
            command_step({"command": "echo"}, self.project)
        with self.assertRaisesRegex(ValueError, "cwd does not exist"):
            command_step({"command": [sys.executable], "cwd": "missing"}, self.project)
        completed = command_step(
            {
                "command": [sys.executable, "-c", "import os; print(os.environ['CRAFT_TEST_VALUE'])"],
                "env": {"CRAFT_TEST_VALUE": 7}, "expected_exit_code": 0,
            },
            self.project,
        )
        self.assertTrue(completed["passed"])
        self.assertIn("7", completed["stdout"])
        redacted = command_step(
            {
                "command": [sys.executable, "-c", "import os; print('token=' + os.environ['API_KEY'])"],
                "env": {"API_KEY": "abcd-secret-value"},
            }, self.project,
        )
        self.assertNotIn("abcd-secret-value", redacted["stdout"])
        self.assertIn("[REDACTED]", redact_output("Authorization: Bearer abc Cookie=xyz"))
        self.assertEqual(redact_output("value=abc", ["abc"]), "value=abc")
        timeout = subprocess.TimeoutExpired(["x"], 1, output="out", stderr="err")
        with patch("craft_core.workflow_runtime.subprocess.run", side_effect=timeout):
            timed = command_step({"command": ["x"], "timeout_seconds": 0}, self.project)
        self.assertEqual(timed["error"], "timeout")

        artifact = self.project / "value.json"
        artifact.write_text('{"items":[{"value":3}]}', encoding="utf-8")
        self.assertTrue(assertion_step(
            {"evaluator": "file_exists", "path": "value.json"}, self.project, {}
        )["passed"])
        self.assertTrue(assertion_step(
            {"evaluator": "file_exists", "path": "absent", "expected": False}, self.project, {}
        )["passed"])
        self.assertTrue(assertion_step(
            {"evaluator": "json_value", "path": "value.json", "field": "items.0.value", "expected": 3},
            self.project, {},
        )["passed"])
        self.assertTrue(assertion_step(
            {"evaluator": "step_exit_code", "step_id": "x"}, self.project,
            {"x": {"exit_code": 0}},
        )["passed"])
        with self.assertRaisesRegex(ValueError, "Unknown assertion step"):
            assertion_step({"evaluator": "step_exit_code", "step_id": "x"}, self.project, {})
        with self.assertRaisesRegex(ValueError, "Unsupported assertion"):
            assertion_step({"evaluator": "unknown"}, self.project, {})

    def test_execute_steps_continuation_and_error_capture(self) -> None:
        results = execute_steps(
            [
                {"id": "bad", "type": "assertion", "evaluator": "file_exists", "path": "absent", "continue_on_failure": True},
                {"type": "assertion", "evaluator": "file_exists", "path": "."},
            ], self.project,
        )
        self.assertEqual(len(results), 2)
        self.assertEqual(results[1]["id"], "step_2")
        unsupported = execute_steps([{"type": "bad"}], self.project)
        self.assertEqual(unsupported[0]["error"], "ValueError")
        with patch("craft_core.workflow_runtime.coverage_gate", return_value={"passed": True}):
            covered = execute_steps([{"type": "coverage_gate"}], self.project)
        self.assertTrue(covered[0]["passed"])
        first = failure_signature(unsupported)
        with_output = [{**unsupported[0], "stdout": "secret", "stderr": "detail"}]
        self.assertEqual(first, failure_signature(with_output))

    def test_coverage_gate_uses_changed_lines_and_branches(self) -> None:
        source = self.project / "sample.py"
        source.write_text("a\nb\n", encoding="utf-8")
        report = self.project / "coverage.json"
        report.write_text(
            json.dumps({"files": {"sample.py": {
                "executed_lines": [1], "missing_lines": [2],
                "executed_branches": [[1, 2]], "missing_branches": [[2, 3]],
            }}}), encoding="utf-8",
        )
        with patch("craft_core.workflow_runtime._git_changed_lines", return_value={source: {1, 2}}):
            result = coverage_gate(
                {"report": "coverage.json", "baseline": "main", "line_threshold": 100, "branch_threshold": 100},
                self.project,
            )
        self.assertFalse(result["passed"])
        self.assertEqual(result["line_coverage"], 50.0)
        self.assertEqual(result["branch_coverage"], 50.0)
        self.assertEqual(result["uncovered"][0]["lines"], [2])

        with patch("craft_core.workflow_runtime._git_changed_lines", return_value={source: set()}):
            untracked = coverage_gate({"report": "coverage.json"}, self.project)
        self.assertEqual(untracked["total_lines"], 2)
        with patch("craft_core.workflow_runtime._git_changed_lines", return_value={}):
            empty = coverage_gate({"report": "coverage.json"}, self.project)
        self.assertTrue(empty["passed"])
        self.assertFalse(empty["applicable"])
        report.write_text(
            json.dumps({"files": {"sample.py": {"executed_lines": [1], "missing_lines": []}}}),
            encoding="utf-8",
        )
        with patch("craft_core.workflow_runtime._git_changed_lines", return_value={source: set()}):
            complete = coverage_gate({"report": "coverage.json"}, self.project)
        self.assertEqual(complete["uncovered"], [])
        missing_source = self.project / "never_imported.py"
        missing_source.write_text("value = 1\n", encoding="utf-8")
        with patch(
            "craft_core.workflow_runtime._git_changed_lines",
            return_value={missing_source: {1}},
        ):
            omitted = coverage_gate({"report": "coverage.json"}, self.project)
        self.assertFalse(omitted["passed"])
        self.assertEqual(omitted["uncovered"][0]["file"], "never_imported.py")
        invalid_source = self.project / "invalid.py"
        invalid_source.write_bytes(b"\xff")
        with patch(
            "craft_core.workflow_runtime._git_changed_lines",
            return_value={invalid_source: {1}},
        ):
            invalid = coverage_gate({"report": "coverage.json"}, self.project)
        self.assertEqual(invalid["total_lines"], 1)
        comment_only = self.project / "comment_only.py"
        comment_only.write_text("# no executable statements\n", encoding="utf-8")
        with patch(
            "craft_core.workflow_runtime._git_changed_lines",
            return_value={comment_only: {1}},
        ):
            ignored = coverage_gate({"report": "coverage.json"}, self.project)
        self.assertFalse(ignored["applicable"])
        with self.assertRaisesRegex(ValueError, "does not exist"):
            coverage_gate({"report": "missing.json"}, self.project)

    def test_git_changed_line_parser_and_errors(self) -> None:
        diff = subprocess.CompletedProcess(
            [], 0,
            "diff --git a/a.py b/a.py\n+++ b/a.py\n@@ -1 +2,2 @@\n+x\n+y\n"
            "diff --git a/old.py b/old.py\n+++ /dev/null\n@@ -1 +0,0 @@\n",
            "",
        )
        untracked = subprocess.CompletedProcess([], 0, "new.py\n", "")
        with patch("craft_core.workflow_runtime.subprocess.run", side_effect=[diff, untracked]):
            changed = _git_changed_lines(self.project, "main")
        self.assertEqual(changed[(self.project / "a.py").resolve()], {2, 3})
        self.assertEqual(changed[(self.project / "new.py").resolve()], set())
        failed = subprocess.CompletedProcess([], 1, "", "bad ref")
        with patch("craft_core.workflow_runtime.subprocess.run", return_value=failed):
            with self.assertRaisesRegex(ValueError, "Unable to diff"):
                _git_changed_lines(self.project, "bad")
        with patch(
            "craft_core.workflow_runtime.subprocess.run",
            side_effect=[subprocess.CompletedProcess([], 0, "", ""), failed],
        ):
            with self.assertRaisesRegex(ValueError, "Unable to list untracked"):
                _git_changed_lines(self.project, "main")

    def test_mixed_agent_judge_human_and_command_workflow(self) -> None:
        workflow = self.service.workflow_save(
            "Mixed review", "Mix model, human, and program evidence",
            [
                {"id": "analyze", "type": "agent", "objective": "Inspect coverage", "tools": ["shell"], "output_schema": {"coverage": "number"}},
                {"id": "judge", "type": "judge", "objective": "Judge evidence", "rubric": ["Coverage is complete"], "on_result": {"failed": "repair", "passed": "approve"}},
                {"id": "repair", "type": "agent", "objective": "Repair tests", "next": "judge"},
                {"id": "approve", "type": "human", "objective": "Approve execution"},
                {"id": "write", "type": "command", "command": [sys.executable, "-c", "open('done.txt','w').write('ok')"]},
                {"id": "verify", "type": "assertion", "evaluator": "file_exists", "path": "done.txt"},
            ],
            repair_policy={"max_transitions": 10},
        )
        session = self.service.workflow_start(workflow["id"], str(self.project))
        self.assertEqual(session["status"], "awaiting_agent")
        self.assertEqual(session["pending"]["step_id"], "analyze")
        with self.assertRaisesRegex(ValueError, "cannot continue"):
            self.service.workflow_continue(session["id"])
        with self.assertRaisesRegex(ValueError, "awaiting step"):
            self.service.workflow_submit(session["id"], "wrong", {})

        session = self.service.workflow_submit(
            session["id"], "analyze", {"output": {"coverage": 80}, "evidence": ["report"]}
        )
        self.assertEqual(session["status"], "awaiting_model_judge")
        self.assertEqual(session["pending"]["context"]["analyze"]["output"]["coverage"], 80)
        session = self.service.workflow_submit(
            session["id"], "judge", {"verdict": "failed", "critique": "missing lines"},
            submitted_by="review_model",
        )
        self.assertEqual(session["pending"]["step_id"], "repair")
        session = self.service.workflow_submit(session["id"], "repair", {"output": "tests added"})
        self.assertEqual(session["pending"]["step_id"], "judge")
        session = self.service.workflow_submit(session["id"], "judge", {"verdict": "passed"})
        self.assertEqual(session["status"], "awaiting_human")
        with self.assertRaisesRegex(ValueError, "approved"):
            self.service.workflow_submit(session["id"], "approve", {})
        session = self.service.workflow_submit(session["id"], "approve", {"approved": True})
        self.assertEqual(session["status"], "needs_execution_approval")
        self.assertEqual(self.service.workflow_continue(session["id"])["status"], "needs_execution_approval")
        session = self.service.workflow_continue(session["id"], allow_execution=True)
        self.assertEqual(session["status"], "passed")
        self.assertEqual(self.service._workflow_advance(session["id"], True)["status"], "passed")
        self.assertEqual(len(session["events"]), 7)
        self.assertEqual(session["events"][0]["provenance"], "agent_reported")
        self.assertEqual(session["events"][1]["provenance"], "model_judged")
        self.assertEqual(session["events"][4]["provenance"], "human_approved")
        self.assertEqual(session["events"][5]["provenance"], "program_verified")
        with self.assertRaisesRegex(ValueError, "cannot continue"):
            self.service.workflow_continue(session["id"], allow_execution=True)
        with self.assertRaisesRegex(ValueError, "not awaiting external"):
            self.service.workflow_submit(session["id"], "verify", {"verdict": "passed"})

    def test_mixed_workflow_terminal_and_validation_paths(self) -> None:
        limited = self.service.workflow_save(
            "Limited", "Stop loops",
            [{"id": "again", "type": "agent", "on_result": {"passed": "again"}}],
            repair_policy={"max_transitions": 1},
        )
        session = self.service.workflow_start(limited["id"], str(self.project))
        session = self.service.workflow_submit(session["id"], "again", {})
        self.assertEqual(session["status"], "transition_limit")

        failed = self.service.workflow_save(
            "Deterministic fail", "Fail without a transition",
            [{"type": "assertion", "evaluator": "file_exists", "path": "missing"}],
        )
        failed_session = self.service.workflow_start(failed["id"], str(self.project))
        self.assertEqual(failed_session["status"], "failed")
        self.assertEqual(failed_session["events"][0]["provenance"], "program_verified")

        rejected = self.service.workflow_save(
            "Rejected", "Human rejects",
            [{"id": "approval", "type": "human"}],
        )
        rejected_session = self.service.workflow_start(rejected["id"], str(self.project))
        rejected_session = self.service.workflow_submit(
            rejected_session["id"], "approval", {"approved": False}
        )
        self.assertEqual(rejected_session["status"], "failed")
        self.assertEqual(rejected_session["events"][0]["provenance"], "human_rejected")

        with self.assertRaisesRegex(ValueError, "Unknown workflow session"):
            self.service.workflow_session_get("missing")
        duplicate = self.service.workflow_save(
            "Duplicate", "Duplicate ids",
            [{"id": "same", "type": "agent"}, {"id": "same", "type": "judge"}],
        )
        with self.assertRaisesRegex(ValueError, "Duplicate workflow step"):
            self.service.workflow_start(duplicate["id"], str(self.project))

        mismatch = self.service.workflow_save(
            "Mismatch", "Corrupted state", [{"id": "agent", "type": "agent"}]
        )
        mismatch_session = self.service.workflow_start(mismatch["id"], str(self.project))
        with self.service.store.transaction() as db:
            db.execute(
                "UPDATE workflow_sessions SET status='awaiting_human' WHERE id=?",
                (mismatch_session["id"],),
            )
        with self.assertRaisesRegex(ValueError, "does not match"):
            self.service.workflow_submit(mismatch_session["id"], "agent", {})

    def test_orchestrator_helpers(self) -> None:
        steps = normalize_steps([{"type": "agent"}, {"id": "last", "type": "human"}])
        self.assertEqual(steps[0]["id"], "step_1")
        self.assertEqual(next_cursor(steps, 0, "passed"), (1, None))
        self.assertEqual(next_cursor([{"id": "x", "next": "end"}], 0, "passed"), (1, "passed"))
        self.assertEqual(next_cursor([{"id": "x", "next": "fail"}], 0, "passed"), (0, "failed"))
        self.assertEqual(next_cursor([{"id": "x"}], 0, "unknown"), (0, "failed"))
        with self.assertRaisesRegex(ValueError, "Unknown workflow transition"):
            next_cursor([{"id": "x", "next": "missing"}], 0, "passed")
        with self.assertRaisesRegex(ValueError, "Duplicate workflow step"):
            normalize_steps([{"id": "x"}, {"id": "x"}])
        with self.assertRaisesRegex(ValueError, "Unsupported side effect"):
            normalize_steps([{"id": "x", "side_effect": "mystery"}])

        self.assertEqual(approved_effects(True, ["external_write"]), {
            "read_only", "local_write", "external_write"
        })
        with self.assertRaisesRegex(ValueError, "Unsupported approved"):
            approved_effects(False, ["mystery"])
        compiled = compile_invariants([
            {"id": "model", "statement": "Result is useful"},
            {"id": "human", "statement": "Owner approves", "enforcement": "human"},
            {"id": "program", "statement": "File exists", "enforcement": "program",
             "validator": {"type": "assertion", "evaluator": "file_exists", "path": "x"}},
        ])
        self.assertEqual([item["type"] for item in compiled], ["judge", "human", "assertion"])
        with self.assertRaisesRegex(ValueError, "must be objects"):
            compile_invariants(["bad"])  # type: ignore[list-item]
        with self.assertRaisesRegex(ValueError, "requires a statement"):
            compile_invariants([{}])
        with self.assertRaisesRegex(ValueError, "requires a validator"):
            compile_invariants([{"statement": "x", "enforcement": "program"}])
        with self.assertRaisesRegex(ValueError, "Unsupported invariant"):
            compile_invariants([{"statement": "x", "enforcement": "magic"}])

        request = external_request(
            {"id": "j", "type": "judge", "objective": "Review", "rubric": ["good"]},
            {"prior": {"output": 1}},
        )
        self.assertEqual(request["rubric"], ["good"])
        self.assertEqual(request["tools"], [])
        with self.assertRaisesRegex(ValueError, "not externally executed"):
            external_request({"id": "x", "type": "command"}, {})

    def test_invariants_permissions_checkpoints_and_restore(self) -> None:
        (self.project / "ready.txt").write_text("ok", encoding="utf-8")
        workflow = self.service.workflow_save(
            "Declarative", "Reach properties without prescribing every action",
            [{"id": "work", "type": "agent", "objective": "Do the work"}],
            invariants=[
                {
                    "id": "ready", "statement": "The ready artifact exists",
                    "enforcement": "program",
                    "validator": {"type": "assertion", "evaluator": "file_exists", "path": "ready.txt"},
                },
                {
                    "id": "quality", "statement": "The artifact is useful",
                    "enforcement": "model", "evidence_required": ["artifact_review"],
                },
            ],
            permission_policy={"allowed_side_effects": ["read_only"]},
        )
        plan = self.service.workflow_plan(workflow["id"], str(self.project))
        self.assertEqual([step["id"] for step in plan["steps"]], ["work", "ready", "quality"])
        self.assertEqual(plan["invariants"][0]["enforcement"], "program")
        session = self.service.workflow_start(workflow["id"], str(self.project))
        session = self.service.workflow_submit(session["id"], "work", {"output": "done"})
        self.assertEqual(session["status"], "awaiting_model_judge")
        checkpoints = self.service.workflow_checkpoint_list(session["id"])["checkpoints"]
        self.assertEqual(len(checkpoints), 1)
        self.assertEqual(checkpoints[0]["provenance"], "program_verified")
        with self.assertRaisesRegex(ValueError, "requires evidence"):
            self.service.workflow_submit(session["id"], "quality", {"verdict": "passed"})
        restored = self.service.workflow_restore(checkpoints[0]["id"])
        self.assertEqual(restored["status"], "awaiting_model_judge")
        self.assertEqual(restored["restored_from_checkpoint"], checkpoints[0]["id"])
        with self.assertRaisesRegex(ValueError, "Unknown workflow checkpoint"):
            self.service.workflow_restore("missing")
        with self.assertRaisesRegex(ValueError, "Unknown workflow session"):
            self.service.workflow_checkpoint_list("missing")

        effects = self.service.workflow_save(
            "Effects", "Require explicit external-write approval",
            [{"id": "publish", "type": "agent", "side_effect": "external_write"}],
            permission_policy={"allowed_side_effects": ["read_only", "external_write"]},
        )
        blocked = self.service.workflow_start(effects["id"], str(self.project))
        self.assertEqual(blocked["status"], "needs_execution_approval")
        self.assertEqual(blocked["approval"]["required_side_effect"], "external_write")
        allowed = self.service.workflow_continue(
            blocked["id"], approved_side_effects=["external_write"]
        )
        self.assertEqual(allowed["status"], "awaiting_agent")

        forbidden = self.service.workflow_save(
            "Forbidden", "Reject undeclared effects",
            [{"type": "command", "command": ["tool"], "side_effect": "destructive"}],
            permission_policy={"allowed_side_effects": ["read_only"]},
        )
        with self.assertRaisesRegex(ValueError, "permission policy forbids"):
            self.service.workflow_plan(forbidden["id"], str(self.project))

        guarded = self.service.workflow_save(
            "Guarded run", "Do not let compatibility approval widen effects",
            [{"type": "command", "command": ["tool"], "side_effect": "destructive"}],
        )
        with self.assertRaisesRegex(ValueError, "unapproved side effects: destructive"):
            self.service.workflow_run(
                guarded["id"], str(self.project), allow_execution=True
            )
        self.assertEqual(normalize_submission({"type": "agent"}, {})[0], "passed")
        self.assertEqual(normalize_submission({"type": "judge"}, {"verdict": "unknown"})[1], "model_judged")
        with self.assertRaisesRegex(ValueError, "verdict"):
            normalize_submission({"type": "judge"}, {"verdict": "maybe"})
        with self.assertRaisesRegex(ValueError, "approved"):
            normalize_submission({"type": "human"}, {})


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
