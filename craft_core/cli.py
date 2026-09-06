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
    commands.add_parser("modes")
    mode_get = commands.add_parser("mode")
    mode_get.add_argument("mode", choices=["standalone", "supervisor", "capability-provider"])
    adapter_probe = commands.add_parser("host-adapter-probe")
    adapter_probe.add_argument("--host", choices=["codex", "claude-code", "deepseek-harness", "generic-mcp"])
    store_backup = commands.add_parser("store-backup")
    store_backup.add_argument("--destination")
    commands.add_parser("store-doctor")
    store_restore = commands.add_parser("store-restore")
    store_restore.add_argument("source")
    store_restore.add_argument("--confirm", action="store_true")
    artifact_add = commands.add_parser("artifact-register")
    artifact_add.add_argument("kind")
    artifact_add.add_argument("name")
    artifact_add.add_argument("uri")
    artifact_add.add_argument("--media-type")
    artifact_add.add_argument("--digest")
    artifact_add.add_argument("--size-bytes", type=int)
    artifact_add.add_argument("--producer-type")
    artifact_add.add_argument("--producer-id")
    artifact_add.add_argument("--metadata-json", default="{}")
    artifact_get = commands.add_parser("artifact-get")
    artifact_get.add_argument("artifact_id")
    artifact_list = commands.add_parser("artifact-list")
    artifact_list.add_argument("--limit", type=int, default=20)
    artifact_list.add_argument("--kind")
    artifact_list.add_argument("--producer-type")
    artifact_list.add_argument("--producer-id")
    evidence_add = commands.add_parser("evidence-record")
    evidence_add.add_argument("source_type")
    evidence_add.add_argument("claim")
    evidence_add.add_argument("--confidence", default="unverified", choices=["confirmed", "bounded", "unverified", "rejected"])
    evidence_add.add_argument("--artifact-id")
    evidence_add.add_argument("--locator")
    evidence_add.add_argument("--observed-at")
    evidence_add.add_argument("--metadata-json", default="{}")
    evidence_get = commands.add_parser("evidence-get")
    evidence_get.add_argument("evidence_id")
    evidence_list = commands.add_parser("evidence-list")
    evidence_list.add_argument("--limit", type=int, default=20)
    evidence_list.add_argument("--source-type")
    evidence_list.add_argument("--confidence", choices=["confirmed", "bounded", "unverified", "rejected"])
    evidence_list.add_argument("--artifact-id")
    lineage_link = commands.add_parser("lineage-link")
    lineage_link.add_argument("from_type")
    lineage_link.add_argument("from_id")
    lineage_link.add_argument("to_type")
    lineage_link.add_argument("to_id")
    lineage_link.add_argument("relation")
    lineage_link.add_argument("--metadata-json", default="{}")
    lineage_trace = commands.add_parser("lineage-trace")
    lineage_trace.add_argument("entity_type")
    lineage_trace.add_argument("entity_id")
    lineage_trace.add_argument("--direction", default="both", choices=["upstream", "downstream", "both"])
    lineage_trace.add_argument("--depth", type=int, default=3)
    budget_create = commands.add_parser("budget-create")
    budget_create.add_argument("owner_type")
    budget_create.add_argument("owner_id")
    budget_create.add_argument("name")
    budget_create.add_argument("limits_json")
    budget_get = commands.add_parser("budget-get")
    budget_get.add_argument("budget_id")
    budget_get.add_argument("--event-limit", type=int, default=50)
    budget_check = commands.add_parser("budget-check")
    budget_check.add_argument("budget_id")
    budget_check.add_argument("--predicted-json", default="{}")
    budget_record = commands.add_parser("budget-record")
    budget_record.add_argument("budget_id")
    budget_record.add_argument("usage_json")
    budget_record.add_argument("source_type")
    budget_record.add_argument("--source-id")
    budget_record.add_argument("--idempotency-key")
    budget_record.add_argument("--metadata-json", default="{}")
    budget_control = commands.add_parser("budget-control")
    budget_control.add_argument("budget_id")
    budget_control.add_argument("action", choices=["pause", "resume", "close"])
    budget_reserve = commands.add_parser("budget-reserve")
    budget_reserve.add_argument("budget_id")
    budget_reserve.add_argument("usage_json")
    budget_reserve.add_argument("claimed_by")
    budget_reserve.add_argument("idempotency_key")
    budget_reserve.add_argument("--ttl-seconds", type=int, default=900)
    budget_reserve.add_argument("--metadata-json", default="{}")
    reservation_get = commands.add_parser("budget-reservation-get")
    reservation_get.add_argument("reservation_id")
    reservation_settle = commands.add_parser("budget-reservation-settle")
    reservation_settle.add_argument("reservation_id")
    reservation_settle.add_argument("--actual-usage-json")
    reservation_settle.add_argument("--source-type", default="host")
    reservation_settle.add_argument("--source-id")
    reservation_settle.add_argument("--claimed-by")
    reservation_settle.add_argument("--metadata-json", default="{}")
    reservation_release = commands.add_parser("budget-reservation-release")
    reservation_release.add_argument("reservation_id")
    reservation_release.add_argument("--claimed-by")
    reservation_reclaim = commands.add_parser("budget-reservation-reclaim")
    reservation_reclaim.add_argument("--budget-id")
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
    workflow_reclaim = commands.add_parser("workflow-execution-reclaim")
    workflow_reclaim.add_argument("--session-id")
    workflow_reconcile = commands.add_parser("workflow-execution-reconcile")
    workflow_reconcile.add_argument("session_id")
    workflow_reconcile.add_argument("resolution", choices=["passed", "failed", "retry"])
    workflow_reconcile.add_argument("--result-json", default="{}")
    workflow_reconcile.add_argument("--approved-retry", action="store_true")
    workflow_reconcile.add_argument("--reconciled-by", default="human")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    service = CraftService()
    if args.command == "info":
        result = service.info()
    elif args.command == "modes":
        result = service.usage_mode_list()
    elif args.command == "mode":
        result = service.usage_mode_get(args.mode)
    elif args.command == "host-adapter-probe":
        result = service.host_adapter_probe(args.host)
    elif args.command == "store-backup":
        result = service.store_backup(args.destination)
    elif args.command == "store-doctor":
        result = service.store_doctor()
    elif args.command == "store-restore":
        result = service.store_restore(args.source, args.confirm)
    elif args.command == "artifact-register":
        result = service.artifact_register(
            args.kind, args.name, args.uri, args.media_type, args.digest, args.size_bytes,
            args.producer_type, args.producer_id, json.loads(args.metadata_json),
        )
    elif args.command == "artifact-get":
        result = service.artifact_get(args.artifact_id)
    elif args.command == "artifact-list":
        result = service.artifact_list(args.limit, args.kind, args.producer_type, args.producer_id)
    elif args.command == "evidence-record":
        result = service.evidence_record(
            args.source_type, args.claim, args.confidence, args.artifact_id,
            args.locator, args.observed_at, json.loads(args.metadata_json),
        )
    elif args.command == "evidence-get":
        result = service.evidence_get(args.evidence_id)
    elif args.command == "evidence-list":
        result = service.evidence_list(
            args.limit, args.source_type, args.confidence, args.artifact_id
        )
    elif args.command == "lineage-link":
        result = service.lineage_link(
            args.from_type, args.from_id, args.to_type, args.to_id,
            args.relation, json.loads(args.metadata_json),
        )
    elif args.command == "lineage-trace":
        result = service.lineage_trace(
            args.entity_type, args.entity_id, args.direction, args.depth
        )
    elif args.command == "budget-create":
        result = service.budget_create(
            args.owner_type, args.owner_id, args.name, json.loads(args.limits_json)
        )
    elif args.command == "budget-get":
        result = service.budget_get(args.budget_id, args.event_limit)
    elif args.command == "budget-check":
        result = service.budget_check(args.budget_id, json.loads(args.predicted_json))
    elif args.command == "budget-record":
        result = service.budget_record(
            args.budget_id, json.loads(args.usage_json), args.source_type,
            args.source_id, args.idempotency_key, json.loads(args.metadata_json),
        )
    elif args.command == "budget-control":
        result = service.budget_control(args.budget_id, args.action)
    elif args.command == "budget-reserve":
        result = service.budget_reserve(
            args.budget_id, json.loads(args.usage_json), args.claimed_by,
            args.idempotency_key, args.ttl_seconds, json.loads(args.metadata_json),
        )
    elif args.command == "budget-reservation-get":
        result = service.budget_reservation_get(args.reservation_id)
    elif args.command == "budget-reservation-settle":
        result = service.budget_reservation_settle(
            args.reservation_id,
            None if args.actual_usage_json is None else json.loads(args.actual_usage_json),
            args.source_type, args.source_id, args.claimed_by, json.loads(args.metadata_json),
        )
    elif args.command == "budget-reservation-release":
        result = service.budget_reservation_release(args.reservation_id, args.claimed_by)
    elif args.command == "budget-reservation-reclaim":
        result = service.budget_reservation_reclaim(args.budget_id)
    elif args.command == "workflow-execution-reclaim":
        result = service.workflow_execution_reclaim(args.session_id)
    elif args.command == "workflow-execution-reconcile":
        result = service.workflow_execution_reconcile(
            args.session_id, args.resolution, json.loads(args.result_json),
            args.approved_retry, args.reconciled_by,
        )
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
