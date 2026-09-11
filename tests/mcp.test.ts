import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { McpServer, TOOLS } from "../src/mcp.ts";
import { serveMcpStdio } from "../src/mcp-stdio.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore } from "../src/store.ts";

test("MCP negotiates protocols, lists tools, dispatches every handler, and reports errors", async () => {
  const root = join(tmpdir(), `craft-mcp-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  const server = new McpServer(new CraftService(store));
  try {
    assert.equal((await server.handle(null))?.error instanceof Object, true);
    assert.equal((await server.handle({ jsonrpc: "1.0", id: 0, method: "ping" }))?.error instanceof Object, true);
    assert.equal((await server.handle({ jsonrpc: "1.0", method: "ping" }))?.error instanceof Object, true);
    assert.equal((await server.handle({ id: 0 }))?.error instanceof Object, true);
    assert.equal(await server.handle({ method: "x" }), undefined);
    assert.equal(await server.handle({ id: 1, method: "notifications/initialized" }), undefined);
    assert.equal(((await server.handle({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }))?.result as Record<string, unknown>).protocolVersion, "2025-06-18");
    assert.equal(((await server.handle({ id: 1, method: "initialize" }))?.result as Record<string, unknown>).protocolVersion, "2025-11-25");
    assert.deepEqual((await server.handle({ id: 2, method: "ping" }))?.result, {});
    assert.equal((((await server.handle({ id: 3, method: "tools/list" }))?.result as Record<string, unknown>).tools as unknown[]).length, TOOLS.length);
    assert.equal((await server.handle({ id: 4, method: "missing" }))?.error instanceof Object, true);
    assert.equal((await server.handle({ id: 5, method: "tools/call", params: { name: "missing" } }))?.error instanceof Object, true);
    assert.equal((await server.handle({ id: 5, method: "tools/call" }))?.error instanceof Object, true);
    assert.equal((await server.handle({ id: 5, method: "tools/call", params: [] }))?.error instanceof Object, true);
    assert.equal((await server.handle({ id: 5, method: "tools/call", params: { name: "craft_info", arguments: [] } }))?.error instanceof Object, true);
    assert.equal(((await server.handle({ id: 5, method: "tools/call", params: { name: "craft_info" } }))?.result as Record<string, unknown>).isError, false);
    server.handlers.craft_throw_string = () => { throw "string failure"; };
    const stringFailure = await server.handle({ id: 5, method: "tools/call", params: { name: "craft_throw_string" } });
    assert.equal((((stringFailure?.result as Record<string, unknown>).content as Record<string, unknown>[])[0]).text, "string failure");
    const failed = await server.handle({ id: 6, method: "tools/call", params: { name: "craft_task_open", arguments: {} } });
    assert.equal(((failed?.result as Record<string, unknown>).isError), true);
    for (const name of ["craft_capability_bundle_propose", "craft_capability_bundle_review", "craft_capability_bundle_publish",
      "craft_capability_release_subscribe", "craft_capability_subscription_resolve", "craft_capability_release_revoke"]) {
      const response = await server.handle({ id: name, method: "tools/call", params: { name, arguments: {} } });
      assert.equal((response?.result as Record<string, unknown>).isError, true, name);
    }
    for (const name of ["craft_hub_source_register", "craft_hub_catalog_ingest", "craft_hub_catalog_search", "craft_hub_source_disable"]) {
      const response = await server.handle({ id: name, method: "tools/call", params: { name, arguments: {} } });
      assert.equal((response?.result as Record<string, unknown>).isError, true, name);
    }
    for (const name of ["craft_capability_materialize_stage", "craft_capability_materialize_review", "craft_capability_materialize_activate"]) {
      const response = await server.handle({ id: name, method: "tools/call", params: { name, arguments: {} } });
      assert.equal((response?.result as Record<string, unknown>).isError, true, name);
    }
    for (const name of ["craft_capability_certification_assess", "craft_capability_certification_promote"]) {
      const response = await server.handle({ id: name, method: "tools/call", params: { name, arguments: {} } });
      assert.equal((response?.result as Record<string, unknown>).isError, true, name);
    }
    for (const name of ["craft_supply_chain_advisory_record", "craft_supply_chain_advisory_resolve", "craft_supply_chain_reconcile"]) {
      const response = await server.handle({ id: name, method: "tools/call", params: { name, arguments: {} } });
      assert.equal((response?.result as Record<string, unknown>).isError, true, name);
    }

    const calls: Record<string, Record<string, unknown>> = {
      craft_info: {}, craft_source_list: {}, craft_semantic_status: {}, craft_task_list: {}, craft_artifact_list: {},
      craft_evidence_list: {}, craft_workflow_search: {}, craft_eval_suite_list: {}, craft_agent_profile_list: {},
      craft_orchestration_plan_list: {}, craft_experience_candidate_list: {},
      craft_task_open: { title: "T", goal: "G" },
      craft_default_route: { title: "Route", goal: "G" },
      craft_artifact_register: { kind: "file", name: "a", uri: "file:///a", artifact_id: "artifact_a" },
      craft_evidence_record: { source_type: "test", claim: "ok", confidence: "confirmed", evidence_id: "evidence_a" },
      craft_workflow_save: { name: "W", workflow_id: "workflow_a" },
      craft_eval_suite_save: { name: "E", suite_id: "suite_a", cases: [{ case_id: "held", split: "held_out" }] },
      craft_agent_profile_save: { name: "A", role: "worker", host: "codex", model: "m", profile_id: "profile_a" },
      craft_artifact_get: { artifact_id: "artifact_a" }, craft_evidence_get: { evidence_id: "evidence_a" },
      craft_workflow_get: { workflow_id: "workflow_a" }, craft_eval_suite_get: { suite_id: "suite_a" },
      craft_agent_profile_get: { profile_id: "profile_a" },
      craft_orchestration_plan_create: { goal: "O", nodes: [{ id: "n", role: "r", objective: "o", profile_ids: ["profile_a"] }] },
    };
    for (const [name, arguments_] of Object.entries(calls)) {
      const response = await server.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((response?.result as Record<string, unknown>).isError, false, name);
    }
    const planList = await server.handle({ id: 8, method: "tools/call", params: { name: "craft_orchestration_plan_list", arguments: {} } });
    const planId = String((((planList?.result as Record<string, unknown>).structuredContent as Record<string, unknown>).plans as Record<string, unknown>[])[0].id);
    assert.equal(((await server.handle({ id: 8, method: "tools/call", params: { name: "craft_orchestration_plan_get", arguments: { plan_id: planId } } }))?.result as Record<string, unknown>).isError, false);
    const dispatch = await server.handle({ id: 8, method: "tools/call", params: { name: "craft_orchestration_dispatch",
      arguments: { plan_id: planId, claimed_by: "host" } } });
    const leaseId = String(((((dispatch?.result as Record<string, unknown>).structuredContent as Record<string, unknown>).leases as Record<string, unknown>[])[0]).lease_id);
    assert.equal(((await server.handle({ id: 8, method: "tools/call", params: { name: "craft_orchestration_renew",
      arguments: { plan_id: planId, lease_id: leaseId, claimed_by: "host" } } }))?.result as Record<string, unknown>).isError, false);
    assert.equal(((await server.handle({ id: 8, method: "tools/call", params: { name: "craft_orchestration_submit",
      arguments: { plan_id: planId, lease_id: leaseId, verdict: "passed" } } }))?.result as Record<string, unknown>).isError, false);
    const workflowPlan = await server.handle({ id: 9, method: "tools/call", params: { name: "craft_workflow_plan",
      arguments: { workflow_id: "workflow_a" } } });
    assert.equal((workflowPlan?.result as Record<string, unknown>).isError, false);
    const workflowRun = await server.handle({ id: 9, method: "tools/call", params: { name: "craft_workflow_run",
      arguments: { workflow_id: "workflow_a", project_root: root } } });
    const runId = String((((workflowRun?.result as Record<string, unknown>).structuredContent as Record<string, unknown>).id));
    assert.equal(((await server.handle({ id: 9, method: "tools/call", params: { name: "craft_workflow_run_get",
      arguments: { run_id: runId } } }))?.result as Record<string, unknown>).isError, false);
    const skillRoot = join(root, "skills");
    await mkdir(skillRoot);
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: mcp-skill\ndescription: searchable\n---\nbody");
    const added = await server.handle({ id: 10, method: "tools/call", params: {
      name: "craft_source_add", arguments: { path: skillRoot, scan: false } } });
    const sourceId = String(((added?.result as Record<string, unknown>).structuredContent as Record<string, unknown>).id);
    await server.handle({ id: 10, method: "tools/call", params: {
      name: "craft_source_scan", arguments: { source_id: sourceId } } });
    const searched = await server.handle({ id: 11, method: "tools/call", params: {
      name: "craft_capability_search", arguments: { query: "searchable" } } });
    const capabilityId = String(((((searched?.result as Record<string, unknown>).structuredContent as Record<string, unknown>)
      .capabilities as Record<string, unknown>[])[0]).id);
    for (const [name, arguments_] of Object.entries({
      craft_source_update: { source_id: sourceId, label: "Changed" },
      craft_source_scan: { source_id: sourceId }, craft_capability_get: { asset_id: capabilityId },
    })) {
      const response = await server.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((response?.result as Record<string, unknown>).isError, false);
    }
    const listed = await server.handle({ id: 12, method: "tools/call", params: {
      name: "craft_task_list", arguments: {} } });
    const taskId = String(((((listed?.result as Record<string, unknown>).structuredContent as Record<string, unknown>)
      .tasks as Record<string, unknown>[])[0]).id);
    const call = async (name: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const response = await server.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((response?.result as Record<string, unknown>).isError, false, name);
      return (response?.result as Record<string, unknown>).structuredContent as Record<string, unknown>;
    };
    const lifecycleRoute = await call("craft_default_route", { goal: "searchable safe route" });
    await call("craft_default_route_resume", { task_id: (lifecycleRoute.task as Record<string, unknown>).id });
    await call("craft_default_route_find", { query: "继续 searchable safe route" });
    for (const stageId of ["baseline", "minimal_change", "verification"]) {
      await call("craft_default_route_update", { route_id: lifecycleRoute.route_id, stage_id: stageId, summary: stageId });
    }
    await call("craft_default_route_update", { route_id: lifecycleRoute.route_id, stage_id: "review",
      summary: "review", verdict: "passed", evidence_ids: ["evidence_a"] });
    const repeatedLifecycleRoute = await call("craft_default_route", { goal: "searchable safe route" });
    for (const stageId of ["baseline", "minimal_change", "verification"]) {
      await call("craft_default_route_update", { route_id: repeatedLifecycleRoute.route_id, stage_id: stageId, summary: stageId });
    }
    await call("craft_default_route_update", { route_id: repeatedLifecycleRoute.route_id, stage_id: "review",
      summary: "review", verdict: "passed", evidence_ids: ["evidence_a"] });
    await call("craft_route_workflow_proposal_create", { route_id: lifecycleRoute.route_id, name: "MCP safe route",
      workflow_id: "workflow_mcp_safe_route", steps: [{ id: "proof", type: "assertion", evaluator: "file_exists", path: "." }] });
    const orchestrationTrial = await call("craft_orchestration_trial_start", { plan_id: "plan_trial_mcp",
      trial_id: "orchestration_trial_mcp", task_id: taskId, goal: "Capture orchestration", nodes: [
        { id: "node", role: "worker", objective: "work", profile_ids: ["profile_a"] },
      ] });
    const orchestrationTrialDispatch = await call("craft_orchestration_dispatch", {
      plan_id: (orchestrationTrial.plan as Record<string, unknown>).id, claimed_by: "host",
    });
    await call("craft_orchestration_submit", { plan_id: (orchestrationTrial.plan as Record<string, unknown>).id,
      lease_id: (orchestrationTrialDispatch.leases as Record<string, unknown>[])[0].lease_id,
      verdict: "passed", costs: { tokens: 1 } });
    await call("craft_orchestration_trial_finalize", {
      plan_id: (orchestrationTrial.plan as Record<string, unknown>).id,
    });
    await call("craft_trial_get", { trial_id: (orchestrationTrial.trial as Record<string, unknown>).id });
    const captured = await call("craft_workflow_trial_run", {
      task_id: taskId, workflow_id: "workflow_a", project_root: root,
    });
    assert.equal((captured.outcome as Record<string, unknown>).verdict, "passed");
    const harness = await call("craft_harness_configuration_save", { name: "H", dimensions: {} });
    await call("craft_harness_configuration_get", { configuration_id: harness.id });
    await call("craft_harness_configuration_list", {});
    const candidate = await call("craft_workflow_transition", {
      workflow_id: "workflow_a", target: "candidate", reason: "evaluate",
    });
    const trial = await call("craft_trial_start", { trial_id: "trial_mcp", task_id: taskId, case_id: "held",
      subject_type: "workflow", subject_id: "workflow_a", subject_version: candidate.version,
      harness_configuration_id: harness.id });
    await call("craft_trial_trace_append", { trial_id: trial.id, event_type: "completed", data: { ok: true } });
    await call("craft_outcome_record", { trial_id: trial.id, verdict: "passed", summary: "ok" });
    await call("craft_trial_get", { trial_id: trial.id });
    await call("craft_trial_list", {});
    const evaluation = await call("craft_evaluation_run_record", { run_id: "eval_mcp", suite_id: "suite_a",
      split: "held_out", subject_type: "workflow", subject_id: "workflow_a",
      subject_version: candidate.version, trial_ids: [trial.id] });
    await call("craft_evaluation_run_get", { run_id: evaluation.id });
    await call("craft_evaluation_run_list", {});
    await call("craft_evaluation_run_aggregate", { run_id: evaluation.id });
    const comparisonTrial = await call("craft_trial_start", { trial_id: "trial_mcp_comparison",
      task_id: taskId, case_id: "held", subject_type: "workflow", subject_id: "workflow_a",
      subject_version: candidate.version });
    await call("craft_outcome_record", { trial_id: comparisonTrial.id, verdict: "passed", summary: "ok" });
    const comparisonEvaluation = await call("craft_evaluation_run_record", { run_id: "eval_mcp_comparison",
      suite_id: "suite_a", split: "held_out", subject_type: "workflow", subject_id: "workflow_a",
      subject_version: candidate.version, trial_ids: [comparisonTrial.id] });
    const comparison = await call("craft_evaluation_compare", { comparison_id: "comparison_mcp",
      baseline_run_id: evaluation.id, candidate_run_id: comparisonEvaluation.id });
    await call("craft_evaluation_comparison_get", { comparison_id: comparison.id });
    await call("craft_evaluation_comparison_list", {});
    const grader = await call("craft_grader_save", { name: "Program", grader_type: "program" });
    await call("craft_grader_get", { grader_id: grader.id });
    await call("craft_grader_list", {});
    const grade = await call("craft_grade_record", { trial_id: trial.id, grader_id: grader.id,
      grader_version: grader.version, verdict: "passed", summary: "passed" });
    await call("craft_grade_get", { grade_id: grade.id });
    await call("craft_grade_list", {});
    const policy = await call("craft_signoff_policy_save", { name: "Policy",
      requirements: [{ grader_type: "program" }] });
    await call("craft_signoff_policy_get", { policy_id: policy.id });
    await call("craft_signoff_policy_list", {});
    const signoff = await call("craft_signoff_evaluate", { policy_id: policy.id,
      evaluation_run_id: evaluation.id, grade_ids: [grade.id] });
    await call("craft_signoff_get", { signoff_id: signoff.id });
    await call("craft_signoff_list", {});
    const verified = await call("craft_workflow_transition", { workflow_id: "workflow_a", target: "verified",
      reason: "passed", signoff_id: signoff.id });
    await call("craft_workflow_transition", { workflow_id: "workflow_a", target: "deprecated", reason: "replace" });
    await call("craft_workflow_rollback", { workflow_id: "workflow_a", target_version: verified.version,
      reason: "restore" });
    const defaultRoute = await call("craft_default_route", { title: "Run verified", goal: "W" });
    await call("craft_default_route_execute", { route_id: defaultRoute.route_id, project_root: root });
    const projectPolicy = await call("craft_project_policy_save", { project_id: "mcp-project", name: "Strict MCP" });
    await call("craft_project_policy_get", { policy_id: projectPolicy.id });
    await call("craft_project_policy_list", {});
    const adapter = await call("craft_host_adapter_save", { host_adapter_id: "adapter_mcp", name: "MCP host",
      host: "generic", allowed_operations: ["complete_stage"] });
    await call("craft_host_adapter_get", { host_adapter_id: adapter.id });
    await call("craft_host_adapter_list", {});
    const strictRoute = await call("craft_default_route", { goal: "mcp governed route", project_id: "mcp-project",
      mode: "safe_incremental_development" });
    const strictDispatch = await call("craft_host_adapter_dispatch", { host_adapter_id: adapter.id, route_id: strictRoute.route_id });
    const strictDiff = await call("craft_route_receipt_record", { route_id: strictRoute.route_id, stage_id: "baseline",
      kind: "git_diff", status: "passed", command: "git diff --check", summary: "clean" });
    const strictTest = await call("craft_route_receipt_record", { route_id: strictRoute.route_id, stage_id: "baseline",
      kind: "focused_test", status: "passed", command: "pnpm test", summary: "passed" });
    await call("craft_default_route_update", { route_id: strictRoute.route_id, stage_id: "baseline", summary: "done",
      receipt_ids: [(strictDiff.receipt as Record<string, unknown>).id, (strictTest.receipt as Record<string, unknown>).id] });
    await call("craft_host_adapter_report", { dispatch_id: (strictDispatch.dispatch as Record<string, unknown>).id, status: "completed", summary: "done" });
    for (const [name, arguments_] of Object.entries({
      craft_task_checkpoint: { task_id: taskId, summary: "checkpoint" },
      craft_feedback_record: { task_id: taskId, corrected: "correction" },
      craft_source_remove: { source_id: sourceId },
    })) {
      const response = await server.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((response?.result as Record<string, unknown>).isError, false);
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("MCP exposes the 0.9.7 controlled host adapter, promotion gate, and adaptive harness controls", async () => {
  const root = join(tmpdir(), `craft-mcp-runtime-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "ok.txt"), "ok");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const server = new McpServer(new CraftService(store));
  const call = async (name: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await server.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
    assert.equal((response?.result as Record<string, unknown>).isError, false, name);
    return (response?.result as Record<string, unknown>).structuredContent as Record<string, unknown>;
  };
  try {
    const task = await call("craft_task_open", { title: "Runtime", goal: "Runtime" });
    const taskId = String((task.task as Record<string, unknown>).id);
    const policy = await call("craft_runtime_policy_save", { name: "P", allowed_effects: ["read_only"] });
    await call("craft_runtime_policy_get", { runtime_policy_id: policy.id }); await call("craft_runtime_policy_list", {});
    const run = await call("craft_runtime_run_start", { run_id: "run", task_id: taskId, policy_id: policy.id,
      environment: { image: "test" }, operations: [{ operation_id: "op", kind: "agent", effect: "read_only", objective: "read" }] });
    await call("craft_runtime_run_get", { run_id: "run" });
    const dispatched = await call("craft_runtime_dispatch", { run_id: "run", claimed_by: "host" });
    const operation = (dispatched.operations as Record<string, unknown>[])[0];
    await call("craft_runtime_operation_get", { operation_id: "op" });
    await call("craft_runtime_operation_submit", { operation_id: "op", lease_id: operation.lease_id,
      claimed_by: "host", verdict: "passed" });
    await call("craft_runtime_run_resume", { run_id: "run" });
    await call("craft_runtime_promotion_eligibility", { run_id: "run", policy_id: policy.id, environment: { image: "test" } });
    const runtimeAdapter = await call("craft_runtime_adapter_save", { name: "MCP Adapter", host: "generic",
      allowed_kinds: ["agent"], allowed_effects: ["read_only"], supports_evidence_receipts: true });
    await call("craft_runtime_adapter_get", { runtime_adapter_id: runtimeAdapter.id });
    await call("craft_runtime_adapter_list", {});
    await call("craft_runtime_run_start", { run_id: "adapter-run", task_id: taskId, policy_id: policy.id, environment: {},
      operations: [{ operation_id: "adapter-op", kind: "agent", effect: "read_only", objective: "adapter" }] });
    const adapterDispatch = await call("craft_runtime_adapter_dispatch", { runtime_adapter_id: runtimeAdapter.id, run_id: "adapter-run" });
    await call("craft_runtime_adapter_report", { runtime_adapter_id: runtimeAdapter.id, operation_id: "adapter-op",
      lease_id: (adapterDispatch.operations as Record<string, unknown>[])[0].lease_id, verdict: "passed", summary: "reported" });

    const approvalPolicy = await call("craft_runtime_policy_save", { name: "Approval", allowed_effects: ["local_write"],
      require_approval_for: ["local_write"] });
    await call("craft_runtime_run_start", { run_id: "approval-run", task_id: taskId, policy_id: approvalPolicy.id,
      environment: {}, operations: [{ operation_id: "approval-op", kind: "agent", effect: "local_write", objective: "write" }] });
    await call("craft_runtime_dispatch", { run_id: "approval-run", claimed_by: "host" });
    await call("craft_runtime_operation_decision", { operation_id: "approval-op", decision: "approve", actor: "human" });

    const suite = await call("craft_eval_suite_save", { name: "Suite", cases: [{ case_id: "held", split: "held_out" }] });
    const workflow = await call("craft_workflow_save", { workflow_id: "eval-workflow", name: "Eval", steps: [
      { id: "proof", type: "assertion", evaluator: "file_exists", path: "ok.txt" },
    ] });
    const evaluation = await call("craft_evaluation_runner_run", { task_id: taskId, suite_id: suite.id, split: "held_out", project_root: root,
      subjects: [{ label: "left", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version },
        { label: "right", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version }] });
    const driverPolicy = await call("craft_runtime_policy_save", { name: "Driver", allowed_effects: ["read_only"],
      trusted_hosts: ["driver"], path_allowlist: ["ok.txt"] });
    await call("craft_runtime_run_start", { run_id: "driver-run", task_id: taskId, policy_id: driverPolicy.id, environment: {}, operations: [{
      operation_id: "driver-op", kind: "workflow", effect: "read_only", objective: "proof", execution: {
        workflow_id: workflow.id, workflow_version: workflow.version, project_root: root, inputs: {},
      },
    }] });
    await call("craft_runtime_driver_tick", { run_id: "driver-run", driver_id: "driver" });
    await call("craft_runtime_lease_recover", { run_id: "driver-run" });
    const grader = await call("craft_grader_save", { name: "Program", grader_type: "program", rules: { minimum_pass_rate: 1 } });
    const evaluationRun = (evaluation.evaluation_runs as Record<string, unknown>[])[0];
    await call("craft_evaluation_program_grade", { evaluation_run_id: evaluationRun.id, grader_id: grader.id, grader_version: grader.version });
    const comparison = (evaluation.comparisons as Record<string, unknown>[])[0];
    await call("craft_evaluation_promotion_assess", { comparison_id: comparison.id, min_trials: 1,
      max_duration_regression_ratio: 1, cost_metric: "tokens" });
    const harness = await call("craft_harness_select", { task_id: taskId, risk: "high", budget: {} });
    const ir = await call("craft_agent_ir_compile", { task_id: taskId, harness_id: (harness.harness as Record<string, unknown>).id,
      goal: "inspect", operations: [{ id: "inspect", kind: "agent", effect: "read_only", objective: "inspect" }] });
    await call("craft_agent_ir_lower", { ir_id: ir.id, policy_id: policy.id, environment: {} });
    await call("craft_experience_mine", { subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version });
    await call("craft_experience_shadow_experiment_create", { task_id: taskId, mining_candidate_id: "missing" });
    for (const value of [1, 1, 3, 3]) await call("craft_operational_signal_record", { subject_type: "workflow",
      subject_id: workflow.id, metric: "latency", value });
    await call("craft_operational_drift_evaluate", { subject_type: "workflow", subject_id: workflow.id, metric: "latency",
      direction: "lower", threshold: 0.5, window_size: 2 });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("MCP runs bounded experience shadow evaluation without granting publication", async () => {
  const root = join(tmpdir(), `craft-mcp-shadow-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true }); await writeFile(join(root, "ok.txt"), "ok");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  const server = new McpServer(service);
  try {
    const task = service.taskOpen({ title: "Shadow", goal: "Shadow" }).task as Record<string, unknown>;
    const suite = service.evaluationSuiteSave({ name: "Held", cases: [{ case_id: "one", split: "held_out" }, { case_id: "two", split: "held_out" }] });
    const baseline = service.workflowSave({ workflow_id: "baseline", name: "Baseline", steps: [{ id: "ok", type: "assertion", evaluator: "file_exists", path: "ok.txt" }] });
    const candidate = service.workflowSave({ workflow_id: "candidate", name: "Candidate", steps: [{ id: "ok", type: "assertion", evaluator: "file_exists", path: "ok.txt" }] });
    const evidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "ok" });
    for (const trialId of ["one", "two"]) {
      service.trialStart({ trial_id: trialId, task_id: task.id, subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version });
      service.outcomeRecord({ trial_id: trialId, verdict: "passed", summary: "passed", evidence_ids: [evidence.id] });
    }
    const mined = service.experienceMine({ subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version });
    const experiment = service.experienceShadowExperimentCreate({ task_id: task.id,
      mining_candidate_id: ((mined.candidates as Record<string, unknown>[])[0]).id });
    const policy = service.signoffPolicySave({ name: "Policy", requirements: [] });
    const response = await server.handle({ id: 1, method: "tools/call", params: { name: "craft_experience_shadow_experiment_evaluate", arguments: {
      experiment_id: (experiment.experiment as Record<string, unknown>).id, suite_id: suite.id, suite_version: suite.version, project_root: root,
      baseline_workflow_id: baseline.id, baseline_workflow_version: baseline.version,
      candidate_workflow_id: candidate.id, candidate_workflow_version: candidate.version,
      signoff_policy_id: policy.id, signoff_policy_version: policy.version, min_trials: 2,
    } } });
    const body = (response?.result as Record<string, unknown>).structuredContent as Record<string, unknown>;
    assert.equal((response?.result as Record<string, unknown>).isError, false);
    assert.equal(body.status, "signoff_ready"); assert.equal(body.publication_allowed, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("MCP stdio buffers an eager Host request, serializes responses, and closes its runtime", async () => {
  const input = new PassThrough(); const output: string[] = []; let closed = false; let mode = "";
  const serving = serveMcpStdio({ mode: "core", input, write: (line) => output.push(line), start: async (selected) => {
    mode = selected;
    return { server: { handle: async (request) => request === "bad" ? undefined : { jsonrpc: "2.0", id: 1, result: { ok: true } } }, close: () => { closed = true; } };
  } });
  input.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n"bad"\n{\n');
  await serving;
  assert.equal(mode, "core"); assert.equal(closed, true); assert.equal(output.length, 2);
  assert.deepEqual(JSON.parse(output[0]), { jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.equal((JSON.parse(output[1]) as { error: { code: number } }).error.code, -32700);
});

test("MCP stdio waits for a Host request that arrives after startup", async () => {
  const input = new PassThrough(); const output: string[] = [];
  const serving = serveMcpStdio({ mode: "core", input, write: (line) => output.push(line), start: async () => ({
    server: { handle: async () => ({ jsonrpc: "2.0", id: 2, result: {} }) }, close: () => undefined,
  }) });
  await Promise.resolve(); input.end('{"jsonrpc":"2.0","id":2,"method":"ping"}\n'); await serving;
  assert.equal((JSON.parse(output[0]) as { id: number }).id, 2);
});

test("MCP stdio default runtime accepts buffered initialization", async () => {
  const root = join(tmpdir(), `craft-mcp-stdio-${process.pid}-${Date.now()}`); const input = new PassThrough(); const output: string[] = [];
  const original = process.env.CRAFT_DATA_DIR; process.env.CRAFT_DATA_DIR = root;
  try {
    const serving = serveMcpStdio({ mode: "full", input, write: (line) => output.push(line) });
    input.end('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}\n');
    await serving;
    assert.equal((JSON.parse(output[0]) as { result: { serverInfo: { version: string } } }).result.serverInfo.version, "0.11.57");
  } finally { if (original === undefined) delete process.env.CRAFT_DATA_DIR; else process.env.CRAFT_DATA_DIR = original; await rm(root, { recursive: true, force: true }); }
});
