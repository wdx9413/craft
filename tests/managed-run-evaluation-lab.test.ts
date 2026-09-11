import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { WorkbenchWebApp } from "../src/workbench-server.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-managed-run-")); await writeFile(join(root, "proof.txt"), "ok");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  service.codexHost.executor = async () => ({ exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n` });
  const workspace = service.workspaceOpen({ workspace_id: "workspace", name: "workspace", root_path: root, include_paths: ["proof.txt"] }).workspace as JsonObject;
  return { root, store, service, workspace };
}

async function prepared(f: Awaited<ReturnType<typeof fixture>>, id = "loop") {
  const result = f.service.verifiedWorkLoopPrepare({ work_loop_id: id, workspace_id: f.workspace.id, title: "Inspect", goal: "Inspect proof", host: "codex-cli", prompt: "inspect", sandbox: "read-only", environment: { image: "stable" }, budget: { tokens: 1 } });
  const launch = result.launch as JsonObject; await f.service.hostRuns.wait(String(launch.run_id));
  const advanced = f.service.verifiedWorkLoopAdvance({ work_loop_id: (result.work_loop as JsonObject).id, environment: { image: "stable" }, budget: { tokens: 1 } });
  return { result, advanced };
}

test("Managed Run persists reference-only observation, handoff, recovery and shadow continuation", async () => {
  const f = await fixture();
  try {
    const { result, advanced } = await prepared(f); const loop = result.work_loop as JsonObject; const full = new McpServer(f.service, "full");
    const created = await full.handlers.craft_managed_run_create({ managed_run_id: "managed", work_loop_id: loop.id }); const run = created.run as JsonObject;
    assert.equal((await full.handlers.craft_managed_run_create({ managed_run_id: "managed", work_loop_id: loop.id })).idempotent, true);
    const observed = await full.handlers.craft_managed_run_observe({ managed_run_id: run.id, task_run_state_id: ((advanced.receipt as JsonObject).task_run_state_id), snapshot_id: ((advanced.receipt as JsonObject).snapshot_id), work_loop_receipt_id: (advanced.receipt as JsonObject).id });
    assert.equal((await full.handlers.craft_managed_run_observe({ managed_run_id: run.id, task_run_state_id: ((advanced.receipt as JsonObject).task_run_state_id), snapshot_id: ((advanced.receipt as JsonObject).snapshot_id), work_loop_receipt_id: (advanced.receipt as JsonObject).id })).idempotent, true);
    const artifact = f.service.artifactRegister({ artifact_id: "artifact", kind: "file", name: "proof", uri: "file://proof.txt", producer_type: "test", producer_id: "test" }) as JsonObject;
    const evidence = f.service.evidenceRecord({ evidence_id: "evidence", source_type: "program", confidence: "confirmed", claim: "proof exists" }) as JsonObject;
    const handoff = await full.handlers.craft_managed_run_handoff({ managed_run_id: run.id, observation_id: (observed.observation as JsonObject).id, reason: "session budget", artifact_ids: [artifact.id], evidence_ids: [evidence.id] });
    assert.equal((handoff.run as JsonObject).lifecycle, "paused");
    assert.equal(f.service.managedRunHandoff({ managed_run_id: run.id, observation_id: (observed.observation as JsonObject).id, reason: "session budget", artifact_ids: [artifact.id], evidence_ids: [evidence.id] }).idempotent, true);
    const resumed = await full.handlers.craft_managed_run_resume({ managed_run_id: run.id, handoff_id: (handoff.handoff as JsonObject).id, observation_id: (observed.observation as JsonObject).id }); assert.equal(resumed.resumed, true);
    const fork = await full.handlers.craft_managed_run_fork_shadow({ managed_run_id: run.id, handoff_id: (handoff.handoff as JsonObject).id }); assert.equal((fork.fork as JsonObject).external_effects_allowed, false);
    assert.equal(f.service.managedRunForkShadow({ managed_run_id: run.id, handoff_id: (handoff.handoff as JsonObject).id }).idempotent, true);
    const got = await full.handlers.craft_managed_run_get({ managed_run_id: run.id }); assert.equal((got.timeline as JsonObject[]).length, 4); assert.equal(JSON.stringify(got).includes("inspect"), false);
    const app = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:1"); assert.equal(app.handle({ method: "GET", path: `/api/managed-runs/${run.id}`, token: "token" }).status, 200);
    assert.throws(() => f.service.managedRunObserve({ managed_run_id: run.id, task_run_state_id: (advanced.receipt as JsonObject).task_run_state_id, snapshot_id: (advanced.receipt as JsonObject).snapshot_id, work_loop_receipt_id: "missing" }), /Unknown/);
    assert.throws(() => f.service.managedRunHandoff({ managed_run_id: run.id, observation_id: (observed.observation as JsonObject).id, reason: "bad", artifact_ids: [artifact.id, artifact.id] }), /unique/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Campaign Runner issues deterministic slots, accepts only comparable Task Runs, and keeps the core view read-only", async () => {
  const f = await fixture();
  try {
    f.service.deliveryEvaluationCaseSave({ case_id: "case", name: "case", domain: "software", partition: "held_out", acceptance_contract_ref: "accept", sanitized: true, approved_by: "curator" });
    const campaign = f.service.evalCampaignCreate({ campaign_id: "campaign", case_ids: ["case"], baseline_harness: "single", candidate_harness: "retrieval", trials_per_case: 2, acceptance_ref: "accept", environment: { image: "stable" }, budget: { tokens: 1 } }).campaign as JsonObject;
    assert.match(String((f.service.campaignRunnerCreate({ campaign_id: campaign.id, evaluator_ref: "delivery-acceptance" }).runner as JsonObject).id), /^campaign_runner_/); assert.throws(() => f.service.campaignRunnerCreate({ campaign_id: campaign.id, evaluator_ref: " " }), /evaluator_ref/);
    const full = new McpServer(f.service, "full"); const runner = (await full.handlers.craft_campaign_runner_create({ runner_id: "runner", campaign_id: campaign.id, evaluator_ref: "delivery-acceptance" })).runner as JsonObject;
    assert.equal((await full.handlers.craft_campaign_runner_create({ runner_id: "runner", campaign_id: campaign.id, evaluator_ref: "delivery-acceptance" })).idempotent, true);
    assert.equal(((await full.handlers.craft_campaign_runner_advance({ runner_id: runner.id })).runner as JsonObject).lifecycle, "collecting");
    const slots = (f.service.evalCampaignGet({ campaign_id: campaign.id }).slots as JsonObject[]).sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const dispatchIds: string[] = []; for (const slot of slots) {
      const claim = await full.handlers.craft_campaign_runner_claim({ runner_id: runner.id }); const dispatch = claim.dispatch as JsonObject; assert.equal(dispatch.slot_id, slot.id);
      dispatchIds.push(String(dispatch.id));
      const launchId = `launch-${slot.id}`; const taskRunId = `run-${slot.id}`;
      f.store.create("task_run", taskRunId, { launch_id: launchId, environment_digest: campaign.environment_digest, budget_digest: campaign.budget_digest }); f.store.create("work_launch", launchId, { trial_id: `trial-${slot.id}` }); f.store.create("outcome", `outcome_trial-${slot.id}`, { verdict: slot.arm === "baseline" ? "failed" : "passed", costs: {} }); f.store.create("work_delivery", `delivery-${slot.id}`, { launch_id: launchId, status: slot.arm === "baseline" ? "host_failed" : "accepted" });
      await full.handlers.craft_campaign_runner_bind({ dispatch_id: dispatch.id, task_run_id: taskRunId }); assert.equal((await full.handlers.craft_campaign_runner_bind({ dispatch_id: dispatch.id, task_run_id: taskRunId })).idempotent, true);
    }
    assert.throws(() => f.service.campaignRunnerBind({ dispatch_id: dispatchIds[0], task_run_id: "other" }), /not issuable/);
    assert.equal(f.service.campaignRunnerClaim({ runner_id: runner.id }).dispatch, null);
    const advanced = await full.handlers.craft_campaign_runner_advance({ runner_id: runner.id }); assert.equal((advanced.runner as JsonObject).lifecycle, "completed"); assert.equal(((advanced.campaign as JsonObject).campaign as JsonObject).lifecycle, "eligible");
    const core = new McpServer(f.service, "core"); assert.ok(full.tools.some((tool) => tool.name === "craft_campaign_runner_claim")); assert.ok(core.tools.some((tool) => tool.name === "craft_campaign_runner_get")); assert.equal(core.tools.some((tool) => tool.name === "craft_campaign_runner_claim"), false);
    assert.ok((await full.handlers.craft_campaign_runner_get({ runner_id: runner.id })).runner); assert.equal(new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:1").handle({ method: "GET", path: `/api/campaign-runners/${runner.id}`, token: "token" }).status, 200); assert.throws(() => f.service.campaignRunnerCreate({ runner_id: "runner", campaign_id: campaign.id, evaluator_ref: "other" }), /conflict/); assert.throws(() => f.service.campaignRunnerClaim({ runner_id: runner.id }), /completed/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Managed Run refuses mixed facts and converts a fresh drift observation into replan", async () => {
  const f = await fixture();
  try {
    const first = await prepared(f, "first"); const second = await prepared(f, "second"); const firstLoop = first.result.work_loop as JsonObject; const secondLoop = second.result.work_loop as JsonObject;
    const generated = f.service.managedRunCreate({ work_loop_id: secondLoop.id }).run as JsonObject; assert.match(String(generated.id), /^managed_run_/);
    const generatedObservation = f.service.managedRunObserve({ managed_run_id: generated.id, task_run_state_id: (second.advanced.receipt as JsonObject).task_run_state_id, snapshot_id: (second.advanced.receipt as JsonObject).snapshot_id, work_loop_receipt_id: (second.advanced.receipt as JsonObject).id });
    assert.throws(() => f.service.managedRunCreate({ work_loop_id: " " }), /work_loop_id/);
    const run = f.service.managedRunCreate({ managed_run_id: "managed-drift", work_loop_id: firstLoop.id }).run as JsonObject;
    assert.throws(() => f.service.managedRunCreate({ managed_run_id: "managed-drift", work_loop_id: secondLoop.id }), /conflict/);
    const observed = f.service.managedRunObserve({ managed_run_id: run.id, observation_id: "conflict", task_run_state_id: (first.advanced.receipt as JsonObject).task_run_state_id, snapshot_id: (first.advanced.receipt as JsonObject).snapshot_id, work_loop_receipt_id: (first.advanced.receipt as JsonObject).id });
    f.store.create("verified_work_loop_receipt", "wrong-receipt", { work_loop_id: firstLoop.id, task_run_state_id: "other", snapshot_id: (first.advanced.receipt as JsonObject).snapshot_id }); assert.throws(() => f.service.managedRunObserve({ managed_run_id: run.id, task_run_state_id: (first.advanced.receipt as JsonObject).task_run_state_id, snapshot_id: (first.advanced.receipt as JsonObject).snapshot_id, work_loop_receipt_id: "wrong-receipt" }), /exact/);
    assert.throws(() => f.service.managedRunObserve({ managed_run_id: run.id, task_run_state_id: (second.advanced.receipt as JsonObject).task_run_state_id, snapshot_id: (second.advanced.receipt as JsonObject).snapshot_id, work_loop_receipt_id: (second.advanced.receipt as JsonObject).id }), /does not belong/);
    const change = f.service.verifiedWorkLoopDecide({ work_loop_id: firstLoop.id, decision: "human_change", actor: "reviewer", summary: "changed file", affected_paths: ["proof.txt"] }); const drift = change.advance as JsonObject;
    assert.throws(() => f.service.managedRunObserve({ managed_run_id: run.id, observation_id: "conflict", task_run_state_id: (drift.receipt as JsonObject).task_run_state_id, snapshot_id: (drift.receipt as JsonObject).snapshot_id, work_loop_receipt_id: (drift.receipt as JsonObject).id }), /conflict/);
    f.store.save("verified_work_loop", String(firstLoop.id), { ...firstLoop, lifecycle: "needs_replan", needs_replan_reason: null });
    const driftObservation = f.service.managedRunObserve({ managed_run_id: run.id, task_run_state_id: (drift.receipt as JsonObject).task_run_state_id, snapshot_id: (drift.receipt as JsonObject).snapshot_id, work_loop_receipt_id: (drift.receipt as JsonObject).id }); assert.equal((driftObservation.run as JsonObject).lifecycle, "needs_replan");
    assert.throws(() => f.service.managedRunHandoff({ managed_run_id: run.id, observation_id: (generatedObservation.observation as JsonObject).id, reason: "bad" }), /this Run/);
    assert.throws(() => f.service.managedRunHandoff({ managed_run_id: run.id, observation_id: (driftObservation.observation as JsonObject).id, reason: "bad", artifact_ids: "bad" as unknown as string[] }), /array/);
    const handoff = f.service.managedRunHandoff({ managed_run_id: run.id, observation_id: (driftObservation.observation as JsonObject).id, reason: "replan", resume_action: "review" }); const resumed = f.service.managedRunResume({ managed_run_id: run.id, handoff_id: (handoff.handoff as JsonObject).id, observation_id: (driftObservation.observation as JsonObject).id }); assert.equal(resumed.resumed, false);
    assert.throws(() => f.service.managedRunResume({ managed_run_id: generated.id, handoff_id: (handoff.handoff as JsonObject).id, observation_id: (driftObservation.observation as JsonObject).id }), /this Run/);
    assert.throws(() => f.service.managedRunResume({ managed_run_id: run.id, handoff_id: (handoff.handoff as JsonObject).id, observation_id: (generatedObservation.observation as JsonObject).id }), /fresh observation/);
    f.service.managedRunHandoff({ managed_run_id: generated.id, observation_id: (generatedObservation.observation as JsonObject).id, handoff_id: "collision", reason: "one" }); assert.throws(() => f.service.managedRunHandoff({ managed_run_id: generated.id, observation_id: (generatedObservation.observation as JsonObject).id, handoff_id: "collision", reason: "two" }), /conflict/);
    assert.throws(() => f.service.managedRunForkShadow({ managed_run_id: generated.id, handoff_id: (handoff.handoff as JsonObject).id }), /source Run/);
    f.store.create("managed_run_shadow", "fixed", { identity_digest: "different" }); assert.throws(() => f.service.managedRunForkShadow({ managed_run_id: run.id, handoff_id: (handoff.handoff as JsonObject).id, fork_id: "fixed" }), /conflict/);
    const paused = await prepared(f, "paused"); const pausedLoop = paused.result.work_loop as JsonObject; f.service.taskRunPause({ task_run_id: (paused.result.task_run as JsonObject).id, reason: "operator" }); const pausedAdvance = f.service.verifiedWorkLoopAdvance({ work_loop_id: pausedLoop.id }); const pausedRun = f.service.managedRunCreate({ managed_run_id: "managed-paused", work_loop_id: pausedLoop.id }).run as JsonObject; assert.equal((f.service.managedRunObserve({ managed_run_id: pausedRun.id, task_run_state_id: (pausedAdvance.receipt as JsonObject).task_run_state_id, snapshot_id: (pausedAdvance.receipt as JsonObject).snapshot_id, work_loop_receipt_id: (pausedAdvance.receipt as JsonObject).id }).run as JsonObject).lifecycle, "paused");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Judge calibration is evidence-backed and an uncalibrated Judge cannot become an eligible promotion gate", async () => {
  const f = await fixture();
  try {
    const judge = f.service.judgeAdapterSave({ judge_id: "judge", name: "Judge", grader_type: "model" }); const evidence = f.service.evidenceRecord({ evidence_id: "gold", source_type: "human", confidence: "confirmed", claim: "gold verdicts reviewed" });
    const assessment = f.store.create("evaluation_reliability", "eligible", { status: "eligible" });
    const uncalibrated = f.service.evaluationJudgeGate({ assessment_id: assessment.id, judge_id: judge.id }); assert.equal((uncalibrated.gate as JsonObject).status, "inconclusive");
    const calibration = f.service.judgeCalibrationRecord({ calibration_id: "calibration", judge_id: judge.id, total: 3, agreed: 3, gold_case_ids: ["one", "two", "three"], evidence_ids: [evidence.id] }).calibration as JsonObject; assert.equal(calibration.status, "calibrated");
    const gate = await new McpServer(f.service, "full").handlers.craft_evaluation_judge_gate({ assessment_id: assessment.id, judge_id: judge.id, evidence_ids: [evidence.id] }); assert.equal((gate.gate as JsonObject).status, "eligible"); assert.equal(f.service.evaluationJudgeGate({ assessment_id: assessment.id, judge_id: judge.id, evidence_ids: [evidence.id] }).idempotent, true);
    f.service.evaluationJudgeGate({ gate_id: "collision", assessment_id: assessment.id, judge_id: judge.id }); assert.throws(() => f.service.evaluationJudgeGate({ gate_id: "collision", assessment_id: assessment.id, judge_id: judge.id, evidence_ids: [evidence.id] }), /conflict/);
    const comparison = f.store.create("evaluation_comparison", "comparison", { candidate_run_id: "candidate-run" }); const promotionAssessment = f.store.create("evaluation_reliability", "promotion-assessment", { status: "eligible", comparison_id: comparison.id }); const signoff = f.store.create("signoff", "signoff", { decision: "passed", evaluation_run_id: "candidate-run" }); const candidate = f.store.create("adaptation_candidate", "candidate", { lifecycle: "draft" }); const blockedGate = f.store.create("evaluation_judge_gate", "blocked-gate", { status: "inconclusive" });
    assert.throws(() => f.service.adaptationCandidateAuthorizeCanary({ candidate_id: candidate.id, assessment_id: promotionAssessment.id, signoff_id: signoff.id, judge_gate_id: blockedGate.id }), /calibrated Judge Gate/);
    const goodGate = f.store.create("evaluation_judge_gate", "good-gate", { status: "eligible" }); assert.equal((f.service.adaptationCandidateAuthorizeCanary({ candidate_id: candidate.id, assessment_id: promotionAssessment.id, signoff_id: signoff.id, judge_gate_id: goodGate.id }).candidate as JsonObject).judge_gate_id, goodGate.id); assert.equal(comparison.id, "comparison");
    assert.throws(() => f.service.judgeCalibrationRecord({ judge_id: judge.id, total: 2, agreed: 2, gold_case_ids: ["one"] }), /match total/);
    assert.throws(() => f.service.evaluationJudgeGate({ assessment_id: "missing", judge_id: judge.id }), /Unknown/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
