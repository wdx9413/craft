import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer, CORE_TOOLS, TOOLS } from "../src/mcp.ts";
import { LocalIsolatedAdapter, processExitCode, runLocalProcess } from "../src/isolated.ts";
import { decideExecution } from "../src/execution-policy.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("capability planning creates an auditable minimal activation profile and rejects unsafe assets", async () => {
  const root = join(tmpdir(), `craft-v099-capability-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Diagnose", goal: "Inspect a timeout without changing code" }).task as JsonObject;
    const safe = service.capabilityAssetSave({ asset_id: "asset_safe", name: "Local logs", asset_type: "tool", source_uri: "local://logs",
      trust: "trusted", effect: "read_only", health: "healthy", cost_hint: { tokens: 1 }, aliases: ["logs", "diagnose"] });
    const verifiedWorkflow = service.capabilityAssetSave({ asset_id: "asset_workflow", name: "Diagnose logs", asset_type: "workflow", source_uri: "craft://workflow/diagnose",
      trust: "verified", effect: "read_only", health: "healthy", cost_hint: { tokens: 10, latency_ms: 50 }, aliases: ["logs", "diagnose"], historical_success_rate: 0.9 });
    service.capabilityAssetSave({ asset_id: "asset_unsafe", name: "Deploy", asset_type: "tool", source_uri: "mcp://deploy",
      trust: "untrusted", effect: "external_write", health: "healthy" });
    service.capabilityAssetSave({ asset_id: "asset_stale", name: "Old browser", asset_type: "tool", source_uri: "mcp://browser",
      trust: "trusted", effect: "read_only", health: "stale" });
    service.capabilityAssetSave({ asset_id: "asset_credential", name: "Secret logs", asset_type: "tool", source_uri: "mcp://secret",
      trust: "trusted", effect: "read_only", health: "healthy", requires_credential: true });
    service.capabilityAssetSave({ asset_id: "asset_effect", name: "Write logs", asset_type: "tool", source_uri: "local://write",
      trust: "trusted", effect: "local_write", health: "healthy" });
    assert.throws(() => service.capabilityAssetSave({ name: "Bad", asset_type: "unknown", source_uri: "local://bad", effect: "read_only" }), /unsupported/);
    const planned = service.capabilityAccessPlan({ task_id: task.id, goal: "diagnose logs", allowed_effects: ["read_only"] });
    assert.deepEqual((planned.profile as JsonObject).asset_ids, [verifiedWorkflow.id, safe.id]);
    assert.equal((planned.receipt as JsonObject).filtered_asset_ids instanceof Array, true);
    assert.equal(JSON.stringify(planned).includes("asset_unsafe"), true);
    assert.equal((service.capabilityAccessPlan({ task_id: task.id, goal: "diagnose logs" }).profile as JsonObject).status, "recommended");
    assert.throws(() => service.capabilityAccessPlan({ task_id: task.id, goal: "!!!", allowed_effects: ["unknown"] }), /supported/);
    assert.throws(() => service.capabilityAccessPlan({ task_id: task.id, goal: "!!!", allowed_effects: ["read_only"] }), /No eligible/);
    assert.throws(() => service.capabilityAccessPlan({ task_id: task.id, goal: "deploy", allowed_effects: ["read_only"] }), /No eligible capability assets/);
    const call = service.capabilityCallIssue({ profile_id: (planned.profile as JsonObject).id, asset_id: safe.id, operation: "inspect" });
    assert.throws(() => service.capabilityCallIssue({ profile_id: (planned.profile as JsonObject).id, asset_id: "asset_unsafe", operation: "inspect" }), /not in/);
    assert.throws(() => service.capabilityCallConsume({ call_id: call.call_id, profile_id: "other" }), /profile/);
    assert.equal((service.capabilityCallConsume({ call_id: call.call_id, profile_id: (planned.profile as JsonObject).id }).receipt as JsonObject).status, "consumed");
    assert.throws(() => service.capabilityCallConsume({ call_id: call.call_id, profile_id: (planned.profile as JsonObject).id }), /already consumed/);
    const expired = service.capabilityCallIssue({ profile_id: (planned.profile as JsonObject).id, asset_id: safe.id, operation: "inspect", expires_at: "2000-01-01T00:00:00.000Z" });
    assert.throws(() => service.capabilityCallConsume({ call_id: expired.call_id, profile_id: (planned.profile as JsonObject).id }), /expired/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.9.9 diagnostic Expert bounds context, child count and host receipts", async () => {
  const root = join(tmpdir(), `craft-v099-expert-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Diagnose", goal: "Find a failure" }).task as JsonObject;
    const policy = service.runtimePolicySave({ name: "Read only", allowed_effects: ["read_only"] });
    const profile = service.expertProfileSave({ expert_id: "diagnostic", name: "Diagnostic", expert_type: "diagnostic_research",
      allowed_effects: ["read_only"], output_contract: ["hypotheses", "counterexamples", "evidence_ids", "confidence", "next_action"] });
    assert.throws(() => service.expertProfileSave({ name: "Bad", expert_type: "writer", allowed_effects: ["local_write"], output_contract: [] }), /Only read-only/);
    const capsule = service.contextCapsuleCreate({ task_id: task.id, profile_id: profile.id, artifact_ids: [], evidence_ids: [], input_boundary: "no raw payload" });
    assert.equal(JSON.stringify(capsule).includes("Find a failure"), false);
    const artifact = service.artifactRegister({ kind: "log", name: "redacted", uri: "craft://artifact/redacted" });
    const capsuleEvidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "capsule ref" });
    const capsuleWithRefs = service.contextCapsuleCreate({ task_id: task.id, profile_id: profile.id, artifact_ids: [artifact.id], evidence_ids: [capsuleEvidence.id], input_boundary: "artifact reference only" });
    assert.equal((capsuleWithRefs.artifact_ids as string[])[0], artifact.id);
    const run = service.runtimeRunStart({ run_id: "expert-run", task_id: task.id, policy_id: policy.id, environment: { isolated: true }, operations: [
      { operation_id: "parent", kind: "agent", effect: "read_only", objective: "coordinate" },
    ] });
    const dispatched = service.runtimeDispatch({ run_id: (run.run as JsonObject).id, claimed_by: "host" }).operations as JsonObject[];
    const children = Array.from({ length: 4 }, (_, index) => ({ operation_id: `child-${index}`, kind: "agent", effect: "read_only", objective: `hypothesis ${index}` }));
    service.runtimeOperationSubmit({ operation_id: "parent", lease_id: dispatched[0].lease_id, claimed_by: "host", verdict: "passed", children });
    assert.equal((service.expertSubagentCreate({ run_id: "expert-run", parent_operation_id: "parent", expert_id: profile.id,
      capsule_id: capsule.id, objective: "fifth hypothesis" }) as JsonObject).status, "pending");
    assert.throws(() => service.expertSubagentCreate({ run_id: "expert-run", parent_operation_id: "parent", expert_id: profile.id,
      capsule_id: capsule.id, objective: "too many" }), /at most 5/);
    const child = service.runtimeOperationGet({ operation_id: "child-0" }).operation as JsonObject;
    const lease = (service.runtimeDispatch({ run_id: "expert-run", claimed_by: "host" }).operations as JsonObject[]).find((item) => item.operation_id === child.id)!;
    assert.throws(() => service.expertSubagentReport({ operation_id: child.id, lease_id: lease.lease_id, claimed_by: "host", verdict: "passed",
      report: { hypotheses: ["h"], evidence_ids: [], counterexamples: ["c"], confidence: "bounded", next_action: "inspect" } }), /Evidence/);
    assert.throws(() => service.expertSubagentReport({ operation_id: child.id, lease_id: lease.lease_id, claimed_by: "host", verdict: "passed",
      report: { hypotheses: ["h"], evidence_ids: [], counterexamples: ["c"], confidence: "bounded" } }), /output contract/);
    const evidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "observed" });
    assert.throws(() => service.expertSubagentReport({ operation_id: child.id, lease_id: lease.lease_id, claimed_by: "host", verdict: "passed",
      report: { hypotheses: ["h"], evidence_ids: [evidence.id], counterexamples: ["c"], confidence: "wrong", next_action: "inspect" } }), /confidence/);
    assert.equal((service.expertSubagentReport({ operation_id: child.id, lease_id: lease.lease_id, claimed_by: "host", verdict: "passed",
      report: { hypotheses: ["h"], evidence_ids: [evidence.id], counterexamples: ["c"], confidence: "bounded", next_action: "inspect" } }).operation as JsonObject).status, "passed");
    service.runtimeRunStart({ run_id: "other-run", task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "other-parent", kind: "agent", effect: "read_only", objective: "other" },
    ] });
    assert.throws(() => service.expertSubagentCreate({ run_id: "expert-run", parent_operation_id: "other-parent", expert_id: profile.id,
      capsule_id: capsule.id, objective: "wrong parent" }), /incompatible/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.9.9 reliability, adaptation, feedback and canary stay gated", async () => {
  const root = join(tmpdir(), `craft-v099-eval-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true }); const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Evaluate", goal: "Compare" }).task as JsonObject;
    const suite = service.evaluationSuiteSave({ suite_id: "suite", name: "Suite", cases: [{ case_id: "case", split: "held_out" }] });
    const workflow = service.workflowSave({ workflow_id: "workflow", name: "Workflow" });
    const trials = ["base", "candidate"].map((trialId) => service.trialStart({ trial_id: trialId, task_id: task.id, case_id: "case", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, environment: { image: "same" }, budget: { tokens: 10 } }));
    for (const trial of trials) service.outcomeRecord({ trial_id: trial.id, verdict: "passed", summary: "passed", costs: { tokens: 1 } });
    const baseline = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, trial_ids: ["base"] });
    const candidate = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, trial_ids: ["candidate"] });
    const comparison = service.evaluationCompare({ baseline_run_id: baseline.id, candidate_run_id: candidate.id });
    assert.equal(service.evaluationReliabilityAssess({ comparison_id: comparison.id, min_trials: 2, max_budget_ratio: 1 }).status, "inconclusive");
    const reliableSuite = service.evaluationSuiteSave({ suite_id: "reliable", name: "Reliable", cases: Array.from({ length: 5 }, (_, index) => ({ case_id: `reliable-${index}`, split: "held_out" })) });
    const reliableTrials: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      for (const [label, verdict] of [["base", "failed"], ["candidate", "passed"]] as const) {
        const trial = service.trialStart({ trial_id: `${label}-${index}`, task_id: task.id, case_id: `reliable-${index}`, subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, environment: { image: "same" }, budget: { tokens: 10 } });
        service.outcomeRecord({ trial_id: trial.id, verdict, summary: verdict, costs: { tokens: 1 } }); reliableTrials.push(String(trial.id));
      }
    }
    const reliableBase = service.evaluationRunRecord({ suite_id: reliableSuite.id, split: "held_out", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, trial_ids: reliableTrials.filter((trialId) => trialId.startsWith("base-")) });
    const reliableCandidate = service.evaluationRunRecord({ suite_id: reliableSuite.id, split: "held_out", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, trial_ids: reliableTrials.filter((trialId) => trialId.startsWith("candidate-")) });
    const reliableComparison = service.evaluationCompare({ baseline_run_id: reliableBase.id, candidate_run_id: reliableCandidate.id });
    const reliability = service.evaluationReliabilityAssess({ comparison_id: reliableComparison.id, min_trials: 5, max_budget_ratio: 1 });
    assert.equal(reliability.status, "eligible");
    assert.equal(service.evaluationReliabilityAssess({ comparison_id: comparison.id }).status, "inconclusive");
    const mismatchTrial = service.trialStart({ trial_id: "environment-mismatch", task_id: task.id, case_id: "case", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, environment: { image: "different" }, budget: { tokens: 10 } });
    service.outcomeRecord({ trial_id: mismatchTrial.id, verdict: "passed", summary: "passed", costs: { tokens: 1 } });
    const mismatchRun = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, trial_ids: [mismatchTrial.id] });
    assert.equal(service.evaluationReliabilityAssess({ comparison_id: service.evaluationCompare({ baseline_run_id: baseline.id, candidate_run_id: mismatchRun.id }).id, min_trials: 2 }).status, "inconclusive");
    const budgetTrial = service.trialStart({ trial_id: "budget-mismatch", task_id: task.id, case_id: "case", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, environment: { image: "same" }, budget: { tokens: 100 } });
    service.outcomeRecord({ trial_id: budgetTrial.id, verdict: "passed", summary: "passed", costs: { tokens: 1 } });
    const budgetRun = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, trial_ids: [budgetTrial.id] });
    assert.equal(service.evaluationReliabilityAssess({ comparison_id: service.evaluationCompare({ baseline_run_id: baseline.id, candidate_run_id: budgetRun.id }).id, min_trials: 2, max_budget_ratio: 1 }).status, "inconclusive");
    const tieSuite = service.evaluationSuiteSave({ suite_id: "tie", name: "Tie", cases: ["one", "two"].map((caseId) => ({ case_id: caseId, split: "held_out" })) });
    const tieTrials: string[] = [];
    for (const caseId of ["one", "two"]) for (const label of ["tie-base", "tie-candidate"]) {
      const trial = service.trialStart({ trial_id: `${label}-${caseId}`, task_id: task.id, case_id: caseId, subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, environment: { image: "same" }, budget: { tokens: 10 } });
      service.outcomeRecord({ trial_id: trial.id, verdict: "passed", summary: "passed", costs: { tokens: 1 } }); tieTrials.push(String(trial.id));
    }
    const tieBase = service.evaluationRunRecord({ suite_id: tieSuite.id, split: "held_out", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, trial_ids: tieTrials.filter((trialId) => trialId.startsWith("tie-base")) });
    const tieCandidate = service.evaluationRunRecord({ suite_id: tieSuite.id, split: "held_out", subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version, trial_ids: tieTrials.filter((trialId) => trialId.startsWith("tie-candidate")) });
    assert.equal(service.evaluationReliabilityAssess({ comparison_id: service.evaluationCompare({ baseline_run_id: tieBase.id, candidate_run_id: tieCandidate.id }).id, min_trials: 2 }).status, "rejected");
    assert.throws(() => service.evaluationReliabilityAssess({ comparison_id: reliableComparison.id, min_trials: 5, max_budget_ratio: -1 }), /non-negative/);
    const judge = service.judgeAdapterSave({ judge_id: "judge", name: "Judge", grader_type: "model" });
    assert.equal(service.judgePromotionEligible({ judge_id: judge.id }).eligible, false);
    assert.equal(((service.judgeCalibrationRecord({ judge_id: judge.id, total: 2, agreed: 2 }).calibration as JsonObject).status), "calibrated");
    assert.equal(service.judgePromotionEligible({ judge_id: judge.id }).eligible, true);
    assert.throws(() => service.judgeAdapterSave({ name: "Bad judge", grader_type: "program" }), /model or human/);
    assert.throws(() => service.judgeCalibrationRecord({ judge_id: judge.id, total: 1, agreed: 1, minimum_agreement: 2 }), /between/);
    const advisory = service.judgeCalibrationRecord({ judge_id: judge.id, total: 2, agreed: 0, minimum_agreement: 0.8 });
    assert.equal((advisory.calibration as JsonObject).status, "advisory");
    const evidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "repeatable" });
    const candidateDraft = service.adaptationCandidateCreate({ task_id: task.id, trial_ids: ["base", "candidate"], evidence_ids: [evidence.id],
      hypothesis: "use less context", applicability: "diagnostic", design_axes: { context: "bounded", tools: "minimal" } });
    assert.equal((candidateDraft.candidate as JsonObject).lifecycle, "draft");
    assert.throws(() => service.adaptationCandidateCreate({ task_id: task.id, trial_ids: ["base", "candidate"], evidence_ids: [evidence.id],
      hypothesis: "too many", applicability: "x", design_axes: { context: "a", tools: "b", memory: "c" } }), /at most two/);
    assert.throws(() => service.canaryStart({ candidate_id: (candidateDraft.candidate as JsonObject).id, baseline_id: workflow.id, environment: { image: "same" } }), /before Canary/);
    assert.throws(() => service.adaptationCandidateAuthorizeCanary({ candidate_id: (candidateDraft.candidate as JsonObject).id,
      assessment_id: (service.evaluationReliabilityAssess({ comparison_id: comparison.id }).assessment as JsonObject).id, signoff_id: "missing" }), /eligible/);
    const signoffPolicy = service.signoffPolicySave({ name: "Candidate signoff", requirements: [] });
    const signoff = service.signoffEvaluate({ policy_id: signoffPolicy.id, evaluation_run_id: reliableCandidate.id });
    const wrongSignoff = service.signoffEvaluate({ policy_id: signoffPolicy.id, evaluation_run_id: tieCandidate.id });
    assert.throws(() => service.adaptationCandidateAuthorizeCanary({ candidate_id: (candidateDraft.candidate as JsonObject).id,
      assessment_id: (reliability.assessment as JsonObject).id, signoff_id: wrongSignoff.id }), /compared candidate/);
    const canaryCandidate = service.adaptationCandidateAuthorizeCanary({ candidate_id: (candidateDraft.candidate as JsonObject).id,
      assessment_id: (reliability.assessment as JsonObject).id, signoff_id: signoff.id });
    assert.equal((canaryCandidate.candidate as JsonObject).lifecycle, "canary_ready");
    assert.throws(() => service.feedbackIntakeCreate({ task_id: task.id, source_uri: "https://example.test", summary: "authorization=secret" }), /sensitive/);
    const feedback = service.feedbackIntakeCreate({ task_id: task.id, source_uri: "craft://metric/1", summary: "latency regression", metric: "latency" });
    assert.equal((service.feedbackIntakeCreate({ task_id: task.id, source_uri: "craft://metric/2", summary: "bounded metric" }).intake as JsonObject).metric, null);
    assert.throws(() => service.feedbackCaseApprove({ intake_id: (feedback.intake as JsonObject).id, split: "held_out", reviewer: "r" }), /development/);
    const development = service.feedbackCaseApprove({ intake_id: (feedback.intake as JsonObject).id, split: "development", reviewer: "r" });
    const canary = service.canaryStart({ candidate_id: (canaryCandidate.candidate as JsonObject).id, baseline_id: workflow.id, environment: { image: "same" } });
    assert.equal(service.canaryObserve({ canary_id: (canary.canary as JsonObject).id, metric: "failure_rate", baseline: 0, candidate: 1, threshold: 0.1 }).status, "rolled_back");
    assert.throws(() => service.canaryObserve({ canary_id: (canary.canary as JsonObject).id, metric: "failure_rate", baseline: -1, candidate: 0, threshold: 0.1 }), /non-negative/);
    const steady = service.canaryStart({ candidate_id: (canaryCandidate.candidate as JsonObject).id, baseline_id: workflow.id, environment: { image: "same" } });
    assert.equal(service.canaryObserve({ canary_id: (steady.canary as JsonObject).id, metric: "failure_rate", baseline: 1, candidate: 1, threshold: 0.1 }).status, "running");
    assert.equal((development.case as JsonObject).split, "development");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.9.9 MCP core is compact while full mode remains compatible", async () => {
  const root = join(tmpdir(), `craft-v099-mcp-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const core = new McpServer(new CraftService(store), "core"); const full = new McpServer(new CraftService(store), "full");
    assert(CORE_TOOLS.length < TOOLS.length);
    const coreTools = ((await core.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }))?.result as JsonObject).tools as JsonObject[];
    const fullTools = ((await full.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }))?.result as JsonObject).tools as JsonObject[];
    assert.equal(coreTools.some((item) => item.name === "craft_skill_proposal_publish"), false);
    assert.equal(fullTools.some((item) => item.name === "craft_skill_proposal_publish"), true);
    assert.equal((((await core.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "craft_info", arguments: {} } }))?.result as JsonObject).isError), false);
    const decisionResponse = await core.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "craft_execution_policy_decide", arguments: { effect: "read_only", platform: "win32" } } });
    const decision = (decisionResponse?.result as JsonObject).structuredContent as JsonObject;
    assert.equal(decision.tier, "host_read_only");
    core.handlers.craft_hidden = () => ({});
    assert(((await core.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "craft_hidden", arguments: {} } }))?.error as JsonObject).message);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.9.9 local isolation fails closed and denies network through the platform adapter", async () => {
  assert.equal(processExitCode(null), 1);
  const calls: JsonObject[] = [];
  const unavailable = new LocalIsolatedAdapter({ platform: "win32", helperAvailable: () => false });
  await assert.rejects(() => unavailable.execute({ run_id: "r", command: "/usr/bin/true", args: [], runtime_root: tmpdir(),
    command_allowlist: ["/usr/bin/true"], path_allowlist: ["."], effect: "read_only" }), /unavailable/);
  const adapter = new LocalIsolatedAdapter({ platform: "darwin", helperAvailable: () => true, runner: async (command) => {
    calls.push(command); return { code: 0, stdout: "ok", stderr: "" };
  } });
  const receipt = await adapter.execute({ run_id: "r", command: "/usr/bin/true", args: [], runtime_root: tmpdir(),
    command_allowlist: ["/usr/bin/true"], path_allowlist: ["."], effect: "read_only" });
  assert.equal(receipt.status, "passed");
  assert.match(String(calls[0].profile), /deny network/);
  const writeReceipt = await adapter.execute({ run_id: "write", command: "/usr/bin/true", args: [], runtime_root: tmpdir(),
    command_allowlist: ["/usr/bin/true"], path_allowlist: ["."], effect: "local_write", compensation: {} });
  assert.equal(writeReceipt.status, "passed");
  await assert.rejects(() => adapter.execute({ run_id: "r", command: "/bin/sh", args: [], runtime_root: tmpdir(),
    command_allowlist: ["/usr/bin/true"], path_allowlist: ["."], effect: "read_only" }), /allowlist/);
  await assert.rejects(() => adapter.execute({ run_id: "r", command: "/usr/bin/true", args: [], runtime_root: tmpdir(),
    command_allowlist: ["/usr/bin/true"], path_allowlist: ["."], effect: "read_only", requires_credential: true }), /Credential Broker/);
  await assert.rejects(() => adapter.execute({ run_id: "r", command: "/usr/bin/true", args: [], runtime_root: tmpdir(),
    command_allowlist: ["/usr/bin/true"], path_allowlist: ["."], effect: "local_write" }), /compensation/);
  await assert.rejects(() => adapter.execute({ run_id: "r", command: "/usr/bin/true", args: [], runtime_root: tmpdir(),
    command_allowlist: ["/usr/bin/true"], path_allowlist: ["logs"], effect: "read_only" }), /path/);
  const linux = new LocalIsolatedAdapter({ platform: "linux", helperAvailable: () => true, runner: async () => ({ code: 1, stdout: "", stderr: "failed" }) });
  assert.equal((await linux.execute({ run_id: "linux", command: "/usr/bin/true", args: [], runtime_root: tmpdir(), command_allowlist: ["/usr/bin/true"], path_allowlist: ["."], effect: "local_write", compensation: {} })).status, "failed");
  const processResult = await runLocalProcess({ helper: process.execPath, argv: ["-e", ""], cwd: tmpdir() });
  assert.equal(typeof processResult.code, "number");
  const output = await runLocalProcess({ helper: process.execPath, argv: ["-e", "console.log('out'); console.error('err')"], cwd: tmpdir() });
  if (output.code === 0) { assert.match(output.stdout, /out/); assert.match(output.stderr, /err/); }
  else assert.match(output.stderr, /spawn|operation|not permitted/i);
  assert.equal((await runLocalProcess({ helper: process.execPath, argv: ["-e", "process.kill(process.pid, 'SIGTERM')"], cwd: tmpdir() })).code, 1);
  assert.equal((await runLocalProcess({ helper: "/not/a-command", argv: [], cwd: tmpdir() })).code, 1);
  const root = join(tmpdir(), `craft-v099-isolated-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store, undefined,
    new LocalIsolatedAdapter({ platform: "darwin", helperAvailable: () => true, runner: async () => ({ code: 0, stdout: "", stderr: "" }) }));
  try {
    const task = service.taskOpen({ title: "Isolated", goal: "Run true" }).task as JsonObject;
    const policy = service.runtimePolicySave({ name: "Isolated", allowed_effects: ["read_only"], command_allowlist: ["/usr/bin/true"], path_allowlist: [".", "scratch"] });
    service.runtimeRunStart({ run_id: "isolated", task_id: task.id, policy_id: policy.id, environment: {}, operations: [{ operation_id: "op", kind: "agent", effect: "read_only", objective: "true" }] });
    const lease = (service.runtimeDispatch({ run_id: "isolated", claimed_by: "local" }).operations as JsonObject[])[0];
    const completed = await service.localIsolatedExecute({ run_id: "isolated", operation_id: "op", lease_id: lease.lease_id, claimed_by: "local", command: "/usr/bin/true" });
    assert.equal((completed.operation as JsonObject).status, "passed");
    const failedService = new CraftService(store, undefined,
      new LocalIsolatedAdapter({ platform: "darwin", helperAvailable: () => true, runner: async () => ({ code: 1, stdout: "", stderr: "failed" }) }));
    failedService.runtimeRunStart({ run_id: "isolated-failed", task_id: task.id, policy_id: policy.id, environment: {}, operations: [{ operation_id: "op-failed", kind: "agent", effect: "read_only", objective: "false" }] });
    const failedLease = (failedService.runtimeDispatch({ run_id: "isolated-failed", claimed_by: "local" }).operations as JsonObject[])[0];
    await assert.rejects(() => failedService.localIsolatedExecute({ run_id: "isolated", operation_id: "op-failed", lease_id: failedLease.lease_id, claimed_by: "local", command: "/usr/bin/true" }), /does not belong/);
    const failed = await failedService.localIsolatedExecute({ run_id: "isolated-failed", operation_id: "op-failed", lease_id: failedLease.lease_id, claimed_by: "local", command: "/usr/bin/true", args: ["ignored"], cwd: "scratch", requires_credential: false, compensation: {} });
    assert.equal((failed.operation as JsonObject).status, "failed");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.9.9 execution policy keeps normal read work portable and restricts risky effects", () => {
  assert.deepEqual(decideExecution({ effect: "read_only", platform: "win32" }), {
    tier: "host_read_only", autonomous: true, requires_approval: false, requires_isolation: false, reason: "read_only_host_execution",
  });
  assert.equal(decideExecution({ effect: "local_write", generated_code: true, platform: "darwin" }).tier, "isolated_local");
  assert.equal(decideExecution({ effect: "local_write", generated_code: true, platform: "win32" }).tier, "approval_required");
  assert.equal(decideExecution({ effect: "external_write", has_compensation: true, platform: "linux" }).requires_approval, true);
  assert.equal(decideExecution({ effect: "destructive", has_compensation: false, platform: "linux" }).tier, "blocked");
  assert.equal(decideExecution({ effect: "read_only", requires_credential: true, platform: "darwin" }).tier, "blocked");
  assert.throws(() => decideExecution({ effect: "unknown", platform: "darwin" }), /unsupported/);
});
