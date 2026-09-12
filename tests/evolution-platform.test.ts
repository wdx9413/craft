import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-evolution-platform-"));
  await writeFile(join(root, "note.txt"), "before", "utf8");
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  const workspace = service.workspaceOpen({ workspace_id: "workspace", name: "Workspace", root_path: root, include_paths: ["note.txt"] }).workspace as JsonObject;
  return { root, store, service, workspace };
}

function observedRun(store: CraftStore, id: string, deliveryStatus: string, environment: JsonObject = { image: "fixed" }, budget: JsonObject = { usd: 1 }) {
  const launchId = `launch-${id}`;
  store.create("task_run", id, { launch_id: launchId, environment_digest: digest(environment), budget_digest: digest(budget) });
  store.create("work_launch", launchId, { trial_id: `trial-${id}` });
  store.create("outcome", `outcome_trial-${id}`, { verdict: deliveryStatus === "accepted" ? "passed" : "failed", costs: { duration_ms: deliveryStatus === "accepted" ? 10 : 20 } });
  store.create("work_delivery", `delivery-${id}`, { launch_id: launchId, status: deliveryStatus });
}

test("v0.11.60 closes a local write with a scoped transaction and explicit rollback", async () => {
  const f = await fixture();
  try {
    let release: (() => void) | undefined;
    f.service.codexHost.executor = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n` };
    };
    const prepared = f.service.executionFabricPrepare({ fabric_id: "write", manifest_id: "write-manifest", workspace_id: f.workspace.id, title: "Write", goal: "update note", host: "codex-cli", prompt: "update note", sandbox: "workspace-write" });
    const execution = f.service.executionFabricExecute({ fabric_id: "write", prompt: "update note", approved: true, actor: "reviewer" });
    const guard = execution.managed_write as JsonObject;
    assert.equal(guard.status, "running");
    await writeFile(join(f.root, "note.txt"), "after", "utf8");
    release?.();
    await f.service.hostRuns.wait(String((execution.run as JsonObject).id));
    const settled = f.service.managedWriteGet({ fabric_id: "write" }).guard as JsonObject;
    assert.equal(settled.status, "committed");
    assert.ok(settled.committed_checkpoint_id);
    const rollback = f.service.managedWriteRollback({ fabric_id: "write", approved: true, actor: "reviewer" });
    assert.equal((rollback.guard as JsonObject).status, "rolled_back");
    assert.equal(await readFile(join(f.root, "note.txt"), "utf8"), "before");
    assert.throws(() => f.service.managedWriteRollback({ fabric_id: "write", approved: true, actor: "reviewer" }), /cannot roll back/);
    const full = new McpServer(f.service, "full");
    assert.equal(((await full.handle({ id: "write-get", method: "tools/call", params: { name: "craft_managed_write_get", arguments: { fabric_id: "write" } } }))?.result as JsonObject).isError, false);
    assert.equal((prepared.launch as JsonObject).sandbox, "workspace-write");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.11.60 reports a repeated held-out Campaign and routes only a reviewed canary candidate", async () => {
  const f = await fixture();
  try {
    for (const id of ["code", "file"]) f.service.deliveryEvaluationCaseSave({ case_id: id, name: id, domain: id === "code" ? "software" : "media", partition: "held_out", acceptance_contract_ref: "contract", sanitized: true, approved_by: "curator" });
    for (const id of ["code", "file"]) {
      observedRun(f.store, `baseline-${id}`, "host_failed");
      observedRun(f.store, `candidate-${id}`, "accepted");
    }
    const campaign = f.service.evalCampaignCreate({ campaign_id: "campaign", case_ids: ["code", "file"], baseline_harness: "minimal", candidate_harness: "retrieval", trials_per_case: 2, environment: { image: "fixed" }, budget: { usd: 1 }, acceptance_ref: "contract" }).campaign as JsonObject;
    const slots = f.service.evalCampaignGet({ campaign_id: campaign.id }).slots as JsonObject[];
    for (const slot of slots) f.service.evalCampaignBind({ slot_id: slot.id, task_run_id: `${slot.arm}-${slot.case_id}` });
    const advanced = f.service.evalCampaignAdvance({ campaign_id: campaign.id });
    assert.equal(advanced.status, "eligible");
    const report = f.service.evalCampaignReport({ campaign_id: campaign.id }).report as JsonObject;
    assert.deepEqual(report.aggregate, { pairs: 4, baseline_delivery_rate: 0, candidate_delivery_rate: 1, improvement_rate: 1, regression_rate: 0 });
    const evaluation = advanced.evaluation as JsonObject;
    const candidate = f.service.taskBenchmarkCandidatePropose({ candidate_id: "candidate", evaluation_run_id: evaluation.id, summary: "retrieval helps", candidate_axes: "context", candidate_harness: "retrieval", applicability_terms: ["code", "file"] }).candidate as JsonObject;
    const signoff = f.store.create("signoff", "signoff", { decision: "passed" });
    f.service.taskBenchmarkCandidateAuthorizeCanary({ candidate_id: candidate.id, signoff_id: signoff.id });
    const canary = f.service.taskBenchmarkCandidateCanaryStart({ candidate_id: candidate.id, canary_id: "canary", baseline_id: "minimal", environment: { image: "fixed" }, budget: { usd: 1 } }).canary as JsonObject;
    const evidence = f.store.create("evidence", "canary-evidence", { confidence: "confirmed" });
    f.service.taskBenchmarkCandidateCanaryObserve({ canary_id: canary.id, sample_id: "one", evidence_id: evidence.id, baseline_quality: 0.5, candidate_quality: 1 });
    assert.equal(f.service.taskBenchmarkCandidateCanaryObserve({ canary_id: canary.id, sample_id: "one", evidence_id: evidence.id, baseline_quality: 0.5, candidate_quality: 1 }).idempotent, true);
    f.service.taskBenchmarkCandidateCanaryObserve({ canary_id: canary.id, sample_id: "two", evidence_id: evidence.id, baseline_quality: 0.5, candidate_quality: 1 });
    const eligible = f.service.taskBenchmarkCandidateCanaryConclude({ candidate_id: candidate.id, canary_id: canary.id, reviewer: "reviewer", min_samples: 2 }).candidate as JsonObject;
    assert.equal(eligible.lifecycle, "routing_eligible");
    assert.equal(f.service.taskBenchmarkCandidateCanaryConclude({ candidate_id: candidate.id, canary_id: canary.id, reviewer: "reviewer", min_samples: 2 }).idempotent, true);
    assert.throws(() => f.service.taskBenchmarkCandidateCanaryObserve({ canary_id: canary.id, sample_id: "one", evidence_id: evidence.id, baseline_quality: 0.5, candidate_quality: 0.8 }), /conflict/);
    assert.equal(((await new McpServer(f.service, "full").handle({ id: "conclude", method: "tools/call", params: { name: "craft_task_benchmark_candidate_canary_conclude", arguments: { candidate_id: candidate.id, canary_id: canary.id, reviewer: "reviewer", min_samples: 2 } } }))?.result as JsonObject).isError, false);
    const task = f.service.taskOpen({ title: "Code task", goal: "code file" }).task as JsonObject;
    const recommendation = f.service.adaptiveHarnessRecommend({ task_id: task.id, goal: task.goal, baseline_harness: "minimal" }).recommendation as JsonObject;
    assert.equal(recommendation.selected_harness, "retrieval");
    const fallback = f.service.adaptiveHarnessRecommend({ task_id: task.id, goal: "unrelated", baseline_harness: "minimal", recommendation_id: "fallback" }).recommendation as JsonObject;
    assert.deepEqual([fallback.selected_harness, fallback.reason], ["minimal", "no_eligible_candidate"]);
    const core = new McpServer(f.service, "core");
    for (const name of ["craft_eval_campaign_report", "craft_adaptive_harness_recommend", "craft_managed_write_get"]) assert.ok(core.tools.some((tool) => tool.name === name), name);
    assert.equal(core.tools.some((tool) => tool.name === "craft_managed_write_rollback"), false);
    const full = new McpServer(f.service, "full");
    assert.equal(((await full.handle({ id: "report", method: "tools/call", params: { name: "craft_eval_campaign_report", arguments: { campaign_id: campaign.id } } }))?.result as JsonObject).isError, false);
    assert.equal(((await full.handle({ id: "recommend", method: "tools/call", params: { name: "craft_adaptive_harness_recommend", arguments: { task_id: task.id, goal: task.goal, baseline_harness: "minimal" } } }))?.result as JsonObject).isError, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.11.60 keeps recovery, report, and routing rejection branches explicit", async () => {
  const f = await fixture();
  try {
    const read = f.service.executionFabricPrepare({ fabric_id: "read", manifest_id: "read-manifest", workspace_id: f.workspace.id, title: "Read", goal: "read", host: "codex-cli", prompt: "read" });
    assert.throws(() => f.service.managedWrites.prepare({ fabric_id: "read" }), /workspace-write/);
    const write = f.service.executionFabricPrepare({ fabric_id: "failed-write", manifest_id: "failed-write-manifest", workspace_id: f.workspace.id, title: "Write", goal: "write", host: "codex-cli", prompt: "write", sandbox: "workspace-write" });
    const guard = f.service.managedWrites.prepare({ fabric_id: "failed-write" }).guard as JsonObject;
    assert.equal(f.service.managedWrites.prepare({ fabric_id: "failed-write" }).idempotent, true);
    f.store.save("workspace", String(f.workspace.id), { name: f.workspace.name, root_path: f.workspace.root_path, include_paths: ["note.txt", "changed-scope.txt"] });
    assert.throws(() => f.service.managedWrites.prepare({ fabric_id: "failed-write" }), /conflict/);
    const launch = write.launch as JsonObject;
    const wrong = f.store.create("host_run", "wrong", { host: "claude-code", dispatch_id: launch.dispatch_id, status: "running" });
    assert.throws(() => f.service.managedWrites.start({ fabric_id: "failed-write", run_id: wrong.id }), /does not match/);
    const run = f.store.create("host_run", "failed", { host: launch.host, dispatch_id: launch.dispatch_id, status: "running" });
    assert.equal((f.service.managedWrites.start({ fabric_id: "failed-write", run_id: run.id }).guard as JsonObject).status, "running");
    assert.equal(f.service.managedWrites.start({ fabric_id: "failed-write", run_id: run.id }).idempotent, true);
    assert.throws(() => f.service.managedWrites.settleForRun(run), /terminal/);
    const failed = f.store.save("host_run", String(run.id), { ...run, status: "failed" });
    assert.equal((f.service.managedWrites.settleForRun(failed)!.guard as JsonObject).status, "rollback_pending");
    assert.equal(f.service.managedWrites.settleForRun(failed)!.idempotent, true);
    assert.equal(f.service.managedWrites.settleForRun(f.store.create("host_run", "unmanaged", { status: "completed" })), null);
    assert.throws(() => f.service.managedWriteRollback({ fabric_id: guard.fabric_id, approved: false, actor: "reviewer" }), /approved/);
    assert.equal(((await new McpServer(f.service, "full").handle({ id: "write-rollback", method: "tools/call", params: { name: "craft_managed_write_rollback", arguments: { fabric_id: guard.fabric_id, approved: false, actor: "reviewer" } } }))?.result as JsonObject).isError, true);
    assert.throws(() => f.service.managedWriteRollback({ fabric_id: guard.fabric_id, approved: true, actor: " " }), /actor/);
    assert.equal((f.service.managedWriteRollback({ fabric_id: guard.fabric_id, approved: true, actor: "reviewer" }).guard as JsonObject).status, "rolled_back");
    assert.throws(() => f.service.managedWrites.start({ fabric_id: guard.fabric_id, run_id: run.id }), /not prepared/);

    f.service.deliveryEvaluationCaseSave({ case_id: "pending", name: "Pending", domain: "software", partition: "held_out", acceptance_contract_ref: "contract", sanitized: true, approved_by: "curator" });
    const pending = f.service.evalCampaignCreate({ campaign_id: "pending", case_ids: ["pending"], baseline_harness: "base", candidate_harness: "candidate", trials_per_case: 2, acceptance_ref: "contract" }).campaign as JsonObject;
    const pendingReport = f.service.evalCampaignReport({ campaign_id: pending.id, report_id: "pending-report" });
    assert.equal((pendingReport.report as JsonObject).lifecycle, "collecting");
    assert.equal(f.service.evalCampaignReport({ campaign_id: pending.id, report_id: "pending-report" }).idempotent, true);
    f.store.save("eval_campaign", String(pending.id), { ...pending, lifecycle: "changed" });
    assert.throws(() => f.service.evalCampaignReport({ campaign_id: pending.id, report_id: "pending-report" }), /conflict/);
    const broken = f.store.create("eval_campaign", "broken", {}); f.store.create("eval_campaign_slot", "broken-slot", { campaign_id: broken.id, case_id: "pending", trial: 1, arm: "baseline", task_run_id: null });
    assert.throws(() => f.service.evalCampaignReport({ campaign_id: broken.id }), /incomplete/);
    assert.throws(() => f.service.evalCampaignReport({ campaign_id: " " }), /campaign_id/);
    f.service.deliveryEvaluationCaseSave({ case_id: "reported", name: "Reported", domain: "software", partition: "held_out", acceptance_contract_ref: "contract", sanitized: true, approved_by: "curator" });
    observedRun(f.store, "equal-base", "accepted"); observedRun(f.store, "equal-candidate", "accepted"); observedRun(f.store, "regressed-base", "accepted"); observedRun(f.store, "regressed-candidate", "host_failed");
    const reported = f.service.evalCampaignCreate({ campaign_id: "reported", case_ids: ["reported"], baseline_harness: "base", candidate_harness: "candidate", trials_per_case: 2, environment: { image: "fixed" }, budget: { usd: 1 }, acceptance_ref: "contract" }).campaign as JsonObject;
    for (const slot of f.service.evalCampaignGet({ campaign_id: reported.id }).slots as JsonObject[]) f.service.evalCampaignBind({ slot_id: slot.id, task_run_id: slot.trial === 1 ? (slot.arm === "baseline" ? "equal-base" : "equal-candidate") : (slot.arm === "baseline" ? "regressed-base" : "regressed-candidate") });
    assert.deepEqual(((f.service.evalCampaignReport({ campaign_id: reported.id }).report as JsonObject).samples as JsonObject[]).map((sample) => sample.verdict), ["equal", "regressed"]);
    f.service.deliveryEvaluationCaseSave({ case_id: "partial", name: "Partial", domain: "software", partition: "held_out", acceptance_contract_ref: "contract", sanitized: true, approved_by: "curator" });
    observedRun(f.store, "partial-base", "accepted"); f.store.create("task_run", "partial-candidate", { launch_id: "launch-partial-candidate", environment_digest: digest({ image: "fixed" }), budget_digest: digest({ usd: 1 }) });
    const partial = f.service.evalCampaignCreate({ campaign_id: "partial", case_ids: ["partial"], baseline_harness: "base", candidate_harness: "candidate", trials_per_case: 2, environment: { image: "fixed" }, budget: { usd: 1 }, acceptance_ref: "contract" }).campaign as JsonObject;
    for (const slot of f.service.evalCampaignGet({ campaign_id: partial.id }).slots as JsonObject[]) f.service.evalCampaignBind({ slot_id: slot.id, task_run_id: slot.arm === "baseline" ? "partial-base" : "partial-candidate" });
    assert.equal((f.service.evalCampaignReport({ campaign_id: partial.id }).report as JsonObject).lifecycle, "collecting");
    f.service.deliveryEvaluationCaseSave({ case_id: "reverse-partial", name: "Reverse partial", domain: "software", partition: "held_out", acceptance_contract_ref: "contract", sanitized: true, approved_by: "curator" });
    f.store.create("task_run", "reverse-base", { launch_id: "launch-reverse-base", environment_digest: digest({ image: "fixed" }), budget_digest: digest({ usd: 1 }) }); observedRun(f.store, "reverse-candidate", "accepted");
    const reversePartial = f.service.evalCampaignCreate({ campaign_id: "reverse-partial", case_ids: ["reverse-partial"], baseline_harness: "base", candidate_harness: "candidate", trials_per_case: 2, environment: { image: "fixed" }, budget: { usd: 1 }, acceptance_ref: "contract" }).campaign as JsonObject;
    for (const slot of f.service.evalCampaignGet({ campaign_id: reversePartial.id }).slots as JsonObject[]) f.service.evalCampaignBind({ slot_id: slot.id, task_run_id: slot.arm === "baseline" ? "reverse-base" : "reverse-candidate" });
    assert.equal((f.service.evalCampaignReport({ campaign_id: reversePartial.id }).report as JsonObject).lifecycle, "collecting");

    const task = f.service.taskOpen({ title: "No candidate", goal: "plain" }).task as JsonObject;
    const noTerms = f.store.create("task_benchmark_candidate", "no-terms", { lifecycle: "routing_eligible", candidate_harness: "ignored" });
    assert.equal((f.service.adaptiveHarnessRecommend({ task_id: task.id, goal: "plain", baseline_harness: "minimal", recommendation_id: "plain" }).recommendation as JsonObject).selected_harness, "minimal");
    assert.equal(f.service.adaptiveHarnessRecommend({ task_id: task.id, goal: "plain", baseline_harness: "minimal", recommendation_id: "plain" }).idempotent, true);
    assert.throws(() => f.service.adaptiveHarnessRecommend({ task_id: task.id, goal: "plain", baseline_harness: "other", recommendation_id: "plain" }), /conflict/);
    f.store.create("task_benchmark_candidate", "first", { lifecycle: "routing_eligible", candidate_harness: "first", applicability_terms: ["plain"] });
    f.store.create("task_benchmark_candidate", "second", { lifecycle: "routing_eligible", candidate_harness: "second", applicability_terms: ["plain"] });
    assert.equal((f.service.adaptiveHarnessRecommend({ task_id: task.id, goal: "plain", baseline_harness: "minimal", recommendation_id: "sorted" }).recommendation as JsonObject).selected_harness, "first");
    assert.equal((f.service.adaptiveHarnessRecommend({ task_id: task.id, goal: "💥", baseline_harness: "minimal", recommendation_id: "empty-terms" }).recommendation as JsonObject).selected_harness, "minimal");
    assert.throws(() => f.service.adaptiveHarnessRecommend({ task_id: " ", goal: "plain", baseline_harness: "minimal" }), /task_id/);
    assert.equal(noTerms.id, "no-terms");

    const routingEvaluation = f.store.create("delivery_evaluation_run", "routing-evaluation", { status: "eligible_for_signoff" });
    assert.throws(() => f.service.taskBenchmarkCandidatePropose({ evaluation_run_id: routingEvaluation.id, summary: "x", candidate_axes: "context", applicability_terms: [] }), /applicability_terms/);
    assert.throws(() => f.service.taskBenchmarkCandidatePropose({ evaluation_run_id: routingEvaluation.id, summary: "x", candidate_axes: "context", applicability_terms: ["same", "same"] }), /applicability_terms/);
    const stoppedCandidate = f.store.create("task_benchmark_candidate", "stopped-candidate", { lifecycle: "canary_ready", evaluation_run_id: routingEvaluation.id });
    const stoppedCanary = f.store.create("task_benchmark_canary", "stopped-canary", { candidate_id: stoppedCandidate.id, status: "rolled_back" });
    assert.throws(() => f.service.taskBenchmarkCandidateCanaryConclude({ candidate_id: stoppedCandidate.id, canary_id: stoppedCanary.id, reviewer: "reviewer" }), /non-regressed/);
    const staleEvaluation = f.store.create("delivery_evaluation_run", "stale-evaluation", { status: "rejected" });
    const staleCandidate = f.store.create("task_benchmark_candidate", "stale-candidate", { lifecycle: "canary_ready", evaluation_run_id: staleEvaluation.id });
    const staleCanary = f.store.create("task_benchmark_canary", "stale-canary", { candidate_id: staleCandidate.id, status: "running" });
    assert.throws(() => f.service.taskBenchmarkCandidateCanaryConclude({ candidate_id: staleCandidate.id, canary_id: staleCanary.id, reviewer: "reviewer" }), /no longer eligible/);
    const emptyCandidate = f.store.create("task_benchmark_candidate", "empty-candidate", { lifecycle: "canary_ready", evaluation_run_id: routingEvaluation.id });
    const emptyCanary = f.store.create("task_benchmark_canary", "empty-canary", { candidate_id: emptyCandidate.id, status: "running" });
    assert.throws(() => f.service.taskBenchmarkCandidateCanaryConclude({ candidate_id: emptyCandidate.id, canary_id: emptyCanary.id, reviewer: "reviewer" }), /enough evidence/);
    const brokenHost = f.store.create("host_run", "settlement-error", { status: "completed" });
    f.store.create("managed_write_guard", "settlement-error", { run_id: brokenHost.id, workspace_id: "missing-workspace", transaction_id: "missing-transaction", status: "running" });
    (f.service as unknown as { settleManagedWrite(run: JsonObject): void }).settleManagedWrite(brokenHost);
    assert.equal(f.store.events(`host-run:${brokenHost.id}`).at(-1)?.event_type, "managed_write.settlement_failed");
    const originalSettlement = f.service.managedWrites.settleForRun.bind(f.service.managedWrites);
    (f.service.managedWrites as unknown as { settleForRun(run: JsonObject): JsonObject | null }).settleForRun = () => { throw "non-error"; };
    (f.service as unknown as { settleManagedWrite(run: JsonObject): void }).settleManagedWrite(f.store.create("host_run", "settlement-unknown", { status: "completed" }));
    assert.equal((f.store.events("host-run:settlement-unknown").at(-1)?.payload as JsonObject).error_class, "UnknownError");
    (f.service.managedWrites as unknown as { settleForRun(run: JsonObject): JsonObject | null }).settleForRun = originalSettlement;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
