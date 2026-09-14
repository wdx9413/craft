import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-runtime-assurance-")); await writeFile(join(root, "proof.txt"), "before");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  const workspace = service.workspaceOpen({ workspace_id: "workspace", name: "workspace", root_path: root, include_paths: ["proof.txt"] }).workspace as JsonObject;
  return { root, store, service, workspace };
}

function recordedRun(f: Awaited<ReturnType<typeof fixture>>, id: string, options: { effect?: string; delivery?: string; environment?: JsonObject; budget?: JsonObject } = {}) {
  const environment = options.environment ?? { image: "stable" }; const budget = options.budget ?? { tokens: 1 }; const effect = options.effect ?? "read_only";
  const task = f.store.create("task", `task-${id}`, { title: id });
  const contract = f.store.create("task_control_contract", `contract-${id}`, { task_id: task.id, allowed_effects: [effect] });
  const launch = f.store.create("work_launch", `launch-${id}`, { task_id: task.id, workspace: f.root, run_id: `host-${id}`, acceptance_plan_id: undefined, trial_id: `trial-${id}` });
  const run = f.store.create("task_run", `run-${id}`, { contract_id: contract.id, launch_id: launch.id, launch_identity: { task_id: task.id }, environment_digest: digest(environment), budget_digest: digest(budget) });
  const host = f.store.create("host_run", `host-${id}`, { task_id: task.id, status: "completed" });
  const delivery = f.store.create("work_delivery", `delivery-${id}`, { launch_id: launch.id, status: options.delivery ?? "ready_for_delivery" });
  f.store.create("outcome", `outcome_${launch.trial_id}`, { verdict: delivery.status === "accepted" ? "passed" : "failed", costs: {} });
  return { task, contract, launch, run, host, delivery, environment, budget };
}

test("Runtime Assurance attests real Host receipts, re-observation, write conformance, and interventions", async () => {
  const f = await fixture();
  try {
    const read = recordedRun(f, "read");
    f.store.create("work_delivery", "delivery-read-prior", { launch_id: read.launch.id, status: "ready_for_delivery" });
    const observation = f.service.workspaceObserverObserve({ workspace_id: f.workspace.id, source: "host" }).observation as JsonObject;
    const evidence = f.service.evidenceRecord({ evidence_id: "evidence", source_type: "program", confidence: "confirmed", claim: "receipt checked" }) as JsonObject;
    f.store.create("host_run", "other-host", { task_id: read.task.id, status: "completed" });
    assert.throws(() => f.service.runtimeAssuranceAttest({ task_run_id: read.run.id, host_run_id: "other-host", environment: read.environment, budget: read.budget, workspace_observation_id: observation.id }), /terminal Host receipt/);
    assert.throws(() => f.service.runtimeAssuranceAttest({ task_run_id: read.run.id, environment: read.environment, budget: read.budget, workspace_observation_id: observation.id, evidence_ids: "bad" as unknown as string[] }), /array/);
    assert.throws(() => f.service.runtimeAssuranceAttest({ task_run_id: read.run.id, environment: read.environment, budget: read.budget, workspace_observation_id: observation.id, evidence_ids: [evidence.id, evidence.id] }), /unique/);
    assert.throws(() => f.service.runtimeAssuranceAttest({ task_run_id: read.run.id, environment: { image: "drift" }, budget: read.budget, workspace_observation_id: observation.id }), /drift/);
    const attested = f.service.runtimeAssuranceAttest({ attestation_id: "read-attestation", task_run_id: read.run.id, environment: read.environment, budget: read.budget, workspace_observation_id: observation.id, evidence_ids: [evidence.id] });
    assert.equal((attested.attestation as JsonObject).status, "verified");
    assert.equal(f.service.runtimeAssuranceAttest({ attestation_id: "read-attestation", task_run_id: read.run.id, environment: read.environment, budget: read.budget, workspace_observation_id: observation.id, evidence_ids: [evidence.id] }).idempotent, true);
    f.store.create("task_run_state", "loop-state", {}); f.store.create("state_snapshot", "loop-snapshot", {});
    f.store.create("verified_work_loop", "loop", { task_run_id: read.run.id, latest_task_run_state_id: "loop-state", latest_snapshot_id: "loop-snapshot" });
    f.store.create("verified_work_loop_receipt", "loop-receipt", { work_loop_id: "loop", task_run_state_id: "loop-state", snapshot_id: "loop-snapshot", status: "observed" });
    f.store.create("verified_work_loop_receipt", "stale-loop-receipt", { work_loop_id: "loop", task_run_state_id: "other-state", snapshot_id: "loop-snapshot", status: "observed" });
    assert.throws(() => f.service.runtimeAssuranceAttest({ task_run_id: read.run.id, environment: read.environment, budget: read.budget, work_loop_receipt_id: "stale-loop-receipt" }), /not the current/);
    assert.equal((f.service.runtimeAssuranceAttest({ attestation_id: "loop-attestation", task_run_id: read.run.id, environment: read.environment, budget: read.budget, work_loop_receipt_id: "loop-receipt" }).attestation as JsonObject).status, "verified");
    const intervention = f.service.runtimeAssuranceIntervene({ task_run_id: read.run.id, kind: "pause", actor: "operator", reason: "review" }).intervention as JsonObject;
    assert.equal(intervention.kind, "pause"); assert.throws(() => f.service.runtimeAssuranceIntervene({ task_run_id: read.run.id, kind: "invent", actor: "operator", reason: "review" }), /unsupported/);
    await writeFile(join(f.root, "proof.txt"), "after");
    const drift = f.service.workspaceObserverObserve({ workspace_id: f.workspace.id, previous_snapshot_id: observation.snapshot_id, source: "unattributed" }).observation as JsonObject;
    assert.equal((f.service.runtimeAssuranceAttest({ attestation_id: "drift-attestation", task_run_id: read.run.id, environment: read.environment, budget: read.budget, workspace_observation_id: drift.id }).attestation as JsonObject).status, "needs_replan");
    const write = recordedRun(f, "write", { effect: "local_write", delivery: "accepted" });
    const conformance = f.service.platformExecutionConformanceRecord({ conformance_id: "conformance", platform: "test-platform", verifier: "test", checks: { network_denied: true, workspace_contained: true, credentials_absent: true, cancel_cleanup: true, resource_limits: true } }).conformance as JsonObject;
    f.service.platformExecutionProfileSave({ profile_id: "profile", platform: "test-platform", isolation: "verified", network: "deny", verified_by: "test", conformance_id: conformance.id });
    const preflight = f.service.platformExecutionPreflight({ preflight_id: "preflight", platform: "test-platform", effect: "local_write", profile_id: "profile" }).preflight as JsonObject;
    const writeObservation = f.service.workspaceObserverObserve({ workspace_id: f.workspace.id, source: "host" }).observation as JsonObject;
    assert.throws(() => f.service.runtimeAssuranceAttest({ task_run_id: write.run.id, effect: "local_write", environment: write.environment, budget: write.budget, workspace_observation_id: writeObservation.id }), /preflight_id/);
    assert.equal((f.service.runtimeAssuranceAttest({ task_run_id: write.run.id, effect: "local_write", environment: write.environment, budget: write.budget, workspace_observation_id: writeObservation.id, preflight_id: preflight.id }).attestation as JsonObject).status, "verified");
    const state = f.service.runtimeAssuranceGet({ task_run_id: read.run.id }); assert.equal((state.attestations as JsonObject[]).length, 3); assert.equal((state.interventions as JsonObject[]).length, 1);
    assert.equal(VERSION, "0.12.24");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Runtime Assurance only advances a Campaign after every bound run has matching verified evidence", async () => {
  const f = await fixture();
  try {
    const environment = { image: "stable" }; const budget = { tokens: 1 };
    f.service.deliveryEvaluationCaseSave({ case_id: "case", name: "case", domain: "software", partition: "held_out", acceptance_contract_ref: "accept", sanitized: true, approved_by: "reviewer" });
    const campaign = f.store.create("eval_campaign", "campaign", { environment_digest: digest(environment), budget_digest: digest(budget), trials_per_case: 2, lifecycle: "collecting" });
    const runner = f.store.create("campaign_runner", "runner", { campaign_id: campaign.id, lifecycle: "collecting" });
    f.store.create("eval_campaign_slot", "slot-1-baseline", { campaign_id: campaign.id, case_id: "case", trial: 1, arm: "baseline", task_run_id: null, status: "pending" });
    assert.throws(() => f.service.runtimeAssuranceCampaignAdvance({ runner_id: runner.id }), /every Campaign slot/);
    for (const trial of [1, 2]) for (const arm of ["baseline", "candidate"]) {
      const item = recordedRun(f, `${trial}-${arm}`, { delivery: arm === "baseline" ? "host_failed" : "accepted", environment, budget });
      const slotId = `slot-${trial}-${arm}`; const existing = f.store.find("eval_campaign_slot", slotId);
      if (existing) f.store.save("eval_campaign_slot", slotId, { ...existing, task_run_id: item.run.id, status: "bound" });
      else f.store.create("eval_campaign_slot", slotId, { campaign_id: campaign.id, case_id: "case", trial, arm, task_run_id: item.run.id, status: "bound" });
      f.store.create("runtime_assurance_attestation", `assurance-${trial}-${arm}`, { task_run_id: item.run.id, status: "verified", environment_digest: digest(environment), budget_digest: digest(budget) });
      if (trial === 1 && arm === "baseline") f.store.create("runtime_assurance_attestation", "assurance-duplicate", { task_run_id: item.run.id, status: "verified", environment_digest: digest(environment), budget_digest: digest(budget) });
    }
    const advanced = f.service.runtimeAssuranceCampaignAdvance({ runner_id: runner.id });
    assert.equal(((advanced.result as JsonObject).runner as JsonObject).campaign_lifecycle, "eligible");
    assert.equal((advanced.assurance_campaign as JsonObject).status, "eligible");
    assert.equal(f.service.runtimeAssuranceCampaignAdvance({ runner_id: runner.id }).idempotent, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
