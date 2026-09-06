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
    profile_save = commands.add_parser("agent-profile-save")
    profile_save.add_argument("name")
    profile_save.add_argument("role")
    profile_save.add_argument("host")
    profile_save.add_argument("provider")
    profile_save.add_argument("model")
    profile_save.add_argument("--reasoning-effort")
    profile_save.add_argument("--capabilities-json", default="[]")
    profile_save.add_argument("--allowed-side-effects-json", default='["read_only"]')
    profile_save.add_argument("--metadata-json", default="{}")
    profile_save.add_argument("--disabled", action="store_true")
    profile_save.add_argument("--profile-id")
    profile_get = commands.add_parser("agent-profile-get")
    profile_get.add_argument("profile_id")
    profile_get.add_argument("--version", type=int)
    profile_list = commands.add_parser("agent-profile-list")
    profile_list.add_argument("--limit", type=int, default=20)
    profile_list.add_argument("--role")
    profile_list.add_argument("--host")
    profile_list.add_argument("--include-disabled", action="store_true")
    plan_create = commands.add_parser("orchestration-plan-create")
    plan_create.add_argument("goal")
    plan_create.add_argument("nodes_json")
    plan_create.add_argument("--task-id")
    plan_create.add_argument("--max-concurrency", type=int, default=4)
    plan_create.add_argument("--policy-json", default="{}")
    plan_get = commands.add_parser("orchestration-plan-get")
    plan_get.add_argument("plan_id")
    plan_list = commands.add_parser("orchestration-plan-list")
    plan_list.add_argument("--limit", type=int, default=20)
    plan_list.add_argument("--task-id")
    plan_list.add_argument("--status", choices=["running", "paused", "completed", "failed", "cancelled"])
    dispatch = commands.add_parser("orchestration-dispatch")
    dispatch.add_argument("plan_id")
    dispatch.add_argument("claimed_by")
    dispatch.add_argument("--limit", type=int)
    submit = commands.add_parser("orchestration-submit")
    submit.add_argument("lease_id")
    submit.add_argument("verdict", choices=["passed", "failed", "blocked"])
    submit.add_argument("--result-json", default="{}")
    submit.add_argument("--evidence-json", default="[]")
    submit.add_argument("--provenance", default="agent_reported")
    submit.add_argument("--claimed-by")
    heartbeat = commands.add_parser("orchestration-heartbeat")
    heartbeat.add_argument("lease_id")
    heartbeat.add_argument("claimed_by")
    heartbeat.add_argument("--extend-seconds", type=int)
    reclaim = commands.add_parser("orchestration-reclaim")
    reclaim.add_argument("plan_id")
    control = commands.add_parser("orchestration-plan-control")
    control.add_argument("plan_id")
    control.add_argument("action", choices=["pause", "resume", "cancel"])
    retry = commands.add_parser("orchestration-node-retry")
    retry.add_argument("plan_id")
    retry.add_argument("node_id")
    retry.add_argument("--restart-routes", action="store_true")
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
    elif args.command == "eval-compare":
        result = service.eval_compare(args.run_ids)
    elif args.command == "agent-profile-save":
        result = service.agent_profile_save(
            args.name, args.role, args.host, args.provider, args.model,
            args.reasoning_effort, json.loads(args.capabilities_json),
            json.loads(args.allowed_side_effects_json), json.loads(args.metadata_json),
            not args.disabled, args.profile_id,
        )
    elif args.command == "agent-profile-get":
        result = service.agent_profile_get(args.profile_id, args.version)
    elif args.command == "agent-profile-list":
        result = service.agent_profile_list(
            args.limit, args.role, args.host, None if args.include_disabled else True
        )
    elif args.command == "orchestration-plan-create":
        result = service.orchestration_plan_create(
            args.goal, json.loads(args.nodes_json), args.task_id,
            args.max_concurrency, json.loads(args.policy_json),
        )
    elif args.command == "orchestration-plan-get":
        result = service.orchestration_plan_get(args.plan_id)
    elif args.command == "orchestration-plan-list":
        result = service.orchestration_plan_list(args.limit, args.task_id, args.status)
    elif args.command == "orchestration-dispatch":
        result = service.orchestration_dispatch(args.plan_id, args.claimed_by, args.limit)
    elif args.command == "orchestration-submit":
        result = service.orchestration_submit(
            args.lease_id, args.verdict, json.loads(args.result_json),
            json.loads(args.evidence_json), args.provenance, args.claimed_by,
        )
    elif args.command == "orchestration-heartbeat":
        result = service.orchestration_heartbeat(args.lease_id, args.claimed_by, args.extend_seconds)
    elif args.command == "orchestration-reclaim":
        result = service.orchestration_reclaim(args.plan_id)
    elif args.command == "orchestration-plan-control":
        result = service.orchestration_plan_control(args.plan_id, args.action)
    else:
        result = service.orchestration_node_retry(args.plan_id, args.node_id, args.restart_routes)
    print(json.dumps(result, ensure_ascii=False, indent=2))
