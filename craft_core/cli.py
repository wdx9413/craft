from __future__ import annotations

import argparse
import json

from .service import CraftService


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="craft", description="Craft local capability and workflow store"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("info")
    commands.add_parser("list-sources")
    add = commands.add_parser("add-source")
    add.add_argument("path")
    add.add_argument("--label")
    scan = commands.add_parser("scan")
    scan.add_argument("--source-id")
    update = commands.add_parser("update-source")
    update.add_argument("source_id")
    state = update.add_mutually_exclusive_group()
    state.add_argument("--enable", action="store_true")
    state.add_argument("--disable", action="store_true")
    update.add_argument("--label")
    remove = commands.add_parser("remove-source")
    remove.add_argument("source_id")
    search = commands.add_parser("search")
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=6)
    suite_save = commands.add_parser("eval-suite-save")
    suite_save.add_argument("name")
    suite_save.add_argument("cases_json", help="JSON array of evaluation cases")
    suite_save.add_argument("--description", default="")
    suite_save.add_argument("--scope", default="user", choices=["task", "project", "user"])
    suite_save.add_argument("--suite-id")
    suite_get = commands.add_parser("eval-suite-get")
    suite_get.add_argument("suite_id")
    suite_get.add_argument("--version", type=int)
    suite_list = commands.add_parser("eval-suite-list")
    suite_list.add_argument("--limit", type=int, default=20)
    suite_list.add_argument("--query")
    suite_list.add_argument("--scope", choices=["task", "project", "user"])
    run_start = commands.add_parser("eval-run-start")
    run_start.add_argument("suite_id")
    run_start.add_argument("subject_kind", choices=["capability", "skill", "workflow", "tool", "mcp", "plugin", "agent", "model", "system", "combination"])
    run_start.add_argument("subject_id")
    run_start.add_argument("--suite-version", type=int)
    run_start.add_argument("--subject-version")
    run_start.add_argument("--metadata-json", default="{}")
    result_submit = commands.add_parser("eval-result-submit")
    result_submit.add_argument("run_id")
    result_submit.add_argument("case_id")
    result_submit.add_argument("verdict", choices=["passed", "failed", "blocked", "skipped"])
    result_submit.add_argument("--score", type=float)
    result_submit.add_argument("--metrics-json", default="{}")
    result_submit.add_argument("--evidence-json", default="[]")
    result_submit.add_argument("--notes", default="")
    result_submit.add_argument("--provenance", default="agent_reported")
    run_get = commands.add_parser("eval-run-get")
    run_get.add_argument("run_id")
    run_list = commands.add_parser("eval-run-list")
    run_list.add_argument("--limit", type=int, default=20)
    run_list.add_argument("--suite-id")
    run_list.add_argument("--subject-kind", choices=["capability", "skill", "workflow", "tool", "mcp", "plugin", "agent", "model", "system", "combination"])
    run_list.add_argument("--subject-id")
    run_list.add_argument("--status", choices=["running", "completed"])
    compare = commands.add_parser("eval-compare")
    compare.add_argument("run_ids", nargs="+")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    service = CraftService()
    if args.command == "info":
        result = service.info()
    elif args.command == "list-sources":
        result = service.source_list()
    elif args.command == "add-source":
        result = service.source_add(args.path, args.label)
    elif args.command == "scan":
        result = service.source_scan(args.source_id)
    elif args.command == "update-source":
        enabled = True if args.enable else False if args.disable else None
        result = service.source_update(args.source_id, enabled=enabled, label=args.label)
    elif args.command == "remove-source":
        result = service.source_remove(args.source_id)
    elif args.command == "search":
        result = service.capability_search(args.query, args.limit)
    elif args.command == "eval-suite-save":
        result = service.eval_suite_save(
            args.name, json.loads(args.cases_json), args.description, args.scope, args.suite_id
        )
    elif args.command == "eval-suite-get":
        result = service.eval_suite_get(args.suite_id, args.version)
    elif args.command == "eval-suite-list":
        result = service.eval_suite_list(args.limit, args.query, args.scope)
    elif args.command == "eval-run-start":
        result = service.eval_run_start(
            args.suite_id, args.subject_kind, args.subject_id, args.suite_version,
            args.subject_version, json.loads(args.metadata_json),
        )
    elif args.command == "eval-result-submit":
        result = service.eval_result_submit(
            args.run_id, args.case_id, args.verdict, args.score,
            json.loads(args.metrics_json), json.loads(args.evidence_json),
            args.notes, args.provenance,
        )
    elif args.command == "eval-run-get":
        result = service.eval_run_get(args.run_id)
    elif args.command == "eval-run-list":
        result = service.eval_run_list(
            args.limit, args.suite_id, args.subject_kind, args.subject_id, args.status
        )
    else:
        result = service.eval_compare(args.run_ids)
    print(json.dumps(result, ensure_ascii=False, indent=2))
