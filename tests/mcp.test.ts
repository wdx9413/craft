import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer, TOOLS } from "../src/mcp.ts";
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

    const calls: Record<string, Record<string, unknown>> = {
      craft_info: {}, craft_source_list: {}, craft_task_list: {}, craft_artifact_list: {},
      craft_evidence_list: {}, craft_workflow_search: {}, craft_eval_suite_list: {}, craft_agent_profile_list: {},
      craft_orchestration_plan_list: {}, craft_experience_candidate_list: {},
      craft_task_open: { title: "T", goal: "G" },
      craft_default_route: { title: "Route", goal: "G" },
      craft_artifact_register: { kind: "file", name: "a", uri: "file:///a", artifact_id: "artifact_a" },
      craft_evidence_record: { source_type: "test", claim: "ok", evidence_id: "evidence_a" },
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
    const lifecycleRoute = await call("craft_default_route", { goal: "MCP safe route lifecycle" });
    await call("craft_default_route_resume", { task_id: (lifecycleRoute.task as Record<string, unknown>).id });
    await call("craft_default_route_find", { query: "继续 MCP safe route lifecycle" });
    for (const stageId of ["baseline", "minimal_change", "verification"]) {
      await call("craft_default_route_update", { route_id: lifecycleRoute.route_id, stage_id: stageId, summary: stageId });
    }
    await call("craft_default_route_update", { route_id: lifecycleRoute.route_id, stage_id: "review",
      summary: "review", verdict: "passed", evidence_ids: ["evidence_a"] });
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
