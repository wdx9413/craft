import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProcedureDefinitionStore } from "../capability/craft-experience/procedure-definition.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { McpServer } from "../core/mcp.ts";
import { CraftService } from "../core/service.ts";
import { payload, stableDigest } from "../core/digest.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-procedure-automation-"));
  const workspace = join(root, "workspace");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  store.create("task", "automation-task", { status: "active" });
  store.create("capability_kit_activation", "automation-activation", { task_id: "automation-task", status: "active" });
  return { root, workspace, store, service: new CraftService(store) };
}
const binding = { task_id: "automation-task", activation_id: "automation-activation" };

async function routeableWorkflow(f: Awaited<ReturnType<typeof fixture>>, id: string, path: string, effects = ["read"], spec?: JsonObject) {
  const definition = new ProcedureDefinitionStore(f.store.paths).write({
    schema_version: "craft.procedure.v1", procedure_id: id, procedure_version: 1, kind: "workflow",
    scope: "project:automation", trigger: "verify generated artifact", preconditions: ["workspace exists"],
    allowed_effects: effects, acceptance_ref: "assertion:artifact", failure_disposition: "checkpoint_and_handoff",
    scenario_signature: { target_class: "fixture", effect: "read_only" }, evidence_ids: ["evidence"],
    proposal_ref: { id: "proposal", version: 1 }, definition: spec ?? { inputs: [], steps: [
      { id: "verify-artifact", type: "assertion", evaluator: "file_exists", path },
    ] },
  }, id);
  const content = f.store.contentStore.writeSync({ kind: "experience", record_id: id, version: 1, scope: "project:automation", status: "routeable", sensitivity: "internal", source_id: "fixture", title: id, folder: "workflows", body: "# Routeable fixture\n" });
  return f.store.create("experience_procedure", id, {
    procedure_kind: "workflow", scope: "project:automation", trigger: "verify generated artifact", title: id,
    acceptance_ref: "assertion:artifact", scenario_signature: { target_class: "fixture" }, lifecycle: "routeable", routeable: true,
    content_ref: content, content_digest: content.digest, definition_ref: definition, definition_digest: definition.digest,
  });
}

function externalReceipt(f: Awaited<ReturnType<typeof fixture>>, runId: string, verdict: "passed" | "failed", suffix = runId, beforeImport?: () => void) {
  const digest = stableDigest(payload(f.store.get("procedure_automation_dispatch", `procedure_automation_dispatch_${runId}`)));
  f.store.create("host_session", `session-${suffix}`, { task_id: binding.task_id, capability_fingerprint: digest, host_id: "codex", trace_id: `trace-${suffix}`, status: "terminal", next_sequence: 1 });
  f.store.create("host_session_event", `terminal-${suffix}`, { session_id: `session-${suffix}`, sequence: 1, kind: verdict === "passed" ? "session.completed" : "session.failed" });
  f.store.create("outcome_observation", `observation-${suffix}`, { subject_digest: digest, trace_id: `trace-${suffix}`, host_id: "codex", observer_id: "workspace-verifier", verdict });
  f.store.create("evidence", `evidence-${suffix}`, { source_type: "program", confidence: "confirmed", metadata: { dispatch_digest: digest, verifier_step_id: "verify-artifact", status: verdict, state_after_digest: stableDigest("workspace-result") } });
  beforeImport?.();
  return f.service.procedureAutomationReceiptRecord({ run_id: runId, host_session_id: `session-${suffix}`, observation_id: `observation-${suffix}`, acceptance_evidence_ids: [`evidence-${suffix}`], observed_at: "2030-01-01T00:00:00.000Z" });
}

test("Automation only dispatches work and accepts an independent terminal Host receipt", async () => {
  const f = await fixture();
  try {
    await routeableWorkflow(f, "external", "result.txt");
    f.service.procedureAutomationSave({ ...binding, job_id: "external-job", procedure_id: "external", workspace: f.workspace, verifier_step_id: "verify-artifact" });
    const prepared = f.service.procedureAutomationRun({ job_id: "external-job", run_id: "external-run" });
    assert.equal((prepared.run as JsonObject).status, "awaiting_host_dispatch");
    assert.ok((prepared.dispatch as JsonObject).id);
    assert.equal(f.service.procedureAutomationRun({ job_id: "external-job", run_id: "parallel-run" }).reason, "awaiting_host_receipt");
    const completed = externalReceipt(f, "external-run", "passed", "external-run", () => {
      assert.throws(() => f.service.procedureAutomationReceiptRecord({ run_id: "external-run", host_session_id: "session-external-run", observation_id: "observation-external-run", acceptance_evidence_ids: ["evidence-external-run"], observed_at: "invalid-date" }), /ISO timestamp/);
      assert.equal(f.store.find("procedure_automation_receipt", "procedure_automation_receipt_external-run"), null);
      assert.equal(f.store.find("procedure_automation_outcome", "procedure_automation_outcome_external-run"), null);
    });
    assert.equal((completed.run as JsonObject).status, "completed");
    assert.equal((completed.outcome as JsonObject).acceptance_source, "independent_host_observation");
    f.service.procedureAutomationRun({ job_id: "external-job", run_id: "next-run" });
    assert.equal((f.service.procedureAutomationGet({ job_id: "external-job" }).runs as JsonObject[]).length, 2);
    assert.throws(() => f.service.procedureAutomationReceiptRecord({ run_id: "external-run", host_session_id: "external-session", observation_id: "external-observation", acceptance_evidence_ids: [] }), /not awaiting/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("two Host processes cannot claim the same Automation job", async () => {
  const f = await fixture();
  try {
    await routeableWorkflow(f, "concurrent", "result.txt");
    f.service.procedureAutomationSave({ ...binding, job_id: "concurrent", procedure_id: "concurrent", workspace: f.workspace, verifier_step_id: "verify-artifact" });
    const code = `import { CraftStore } from ${JSON.stringify(new URL("../core/infrastructure/store.ts", import.meta.url).href)};
      import { craftPaths } from ${JSON.stringify(new URL("../core/infrastructure/paths.ts", import.meta.url).href)};
      import { ProcedureAutomationKernel } from ${JSON.stringify(new URL("../capability/craft-experience/procedure-automation.ts", import.meta.url).href)};
      const store = await new CraftStore(craftPaths(${JSON.stringify(join(f.root, "data"))})).open();
      try { console.log(JSON.stringify(new ProcedureAutomationKernel(store).run({job_id:"concurrent"}))); } finally { store.close(); }`;
    const results = await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code])));
    const claims = results.map(item => JSON.parse(item.stdout));
    assert.equal(claims.filter(item => item.dispatch).length, 1);
    assert.equal(claims.filter(item => item.reason === "awaiting_host_receipt").length, 1);
    assert.equal((f.service.procedureAutomationGet({ job_id: "concurrent" }).runs as JsonObject[]).length, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("expired dispatches hand off without replay and reconcile only their original receipt", async () => {
  const f = await fixture();
  try {
    await routeableWorkflow(f, "timeout", "result.txt");
    f.service.procedureAutomationSave({ ...binding, job_id: "timeout", procedure_id: "timeout", workspace: f.workspace, verifier_step_id: "verify-artifact", dispatch_timeout_seconds: 1 });
    f.service.procedureAutomationRun({ job_id: "timeout", run_id: "timeout", now: "2030-01-01T00:00:00Z" });
    const expired = f.service.procedureAutomationRun({ job_id: "timeout", now: "2030-01-01T00:00:01Z" });
    assert.equal(expired.reason, "host_receipt_timeout");
    assert.equal((expired.run as JsonObject).status, "effect_unknown");
    f.service.procedureAutomationPause({ job_id: "timeout", paused: false });
    assert.equal(f.service.procedureAutomationRun({ job_id: "timeout" }).reason, "reconciliation_required");
    const completed = externalReceipt(f, "timeout", "passed");
    assert.equal((completed.run as JsonObject).status, "completed");
    assert.equal(f.store.get("procedure_automation_handoff", String((expired.handoff as JsonObject).id)).status, "resolved");
    assert.equal((f.service.procedureAutomationGet({ job_id: "timeout" }).runs as JsonObject[]).length, 1);
    f.service.procedureAutomationRun({ job_id: "timeout", run_id: "legacy-timeout" });
    const legacy = { ...payload(f.store.get("procedure_automation_run", "legacy-timeout")) }; delete legacy.lease_expires_at;
    f.store.save("procedure_automation_run", "legacy-timeout", legacy);
    assert.equal(f.service.procedureAutomationRun({ job_id: "timeout" }).reason, "host_receipt_timeout");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Automation rejects foreign tasks, stale bindings, weak evidence and replayed observations", async () => {
  const mutations: Array<[string, string, JsonObject]> = [
    ["host_session", "session-proof", { task_id: "foreign-task" }],
    ["host_session", "session-proof", { capability_fingerprint: "wrong-dispatch" }],
    ["host_session", "session-proof", { status: "running" }],
    ["host_session", "session-proof", { next_sequence: 2 }],
    ["host_session", "session-proof", { trace_id: null }],
    ["host_session_event", "terminal-proof", { kind: "session.started" }],
    ["capability_kit_activation", "automation-activation", { status: "revoked" }],
    ["capability_kit_activation", "automation-activation", { task_id: "other" }],
    ["capability_kit_activation", "automation-activation", {}],
    ["experience_procedure", "proof", {}],
    ["task", "automation-task", { status: "closed" }],
    ["outcome_observation", "observation-proof", { subject_digest: "wrong-dispatch" }],
    ["outcome_observation", "observation-proof", { observer_id: "codex" }],
    ["outcome_observation", "observation-proof", { observer_id: null }],
    ["outcome_observation", "observation-proof", { trace_id: "foreign-trace" }],
    ["evidence", "evidence-proof", { confidence: "unverified" }],
    ["evidence", "evidence-proof", { metadata: { status: "passed" } }],
  ];
  for (const [kind, id, change] of mutations) {
    const f = await fixture();
    try {
      await routeableWorkflow(f, "proof", "result.txt");
      f.service.procedureAutomationSave({ ...binding, job_id: "job", procedure_id: "proof", workspace: f.workspace, verifier_step_id: "verify-artifact" });
      f.service.procedureAutomationRun({ job_id: "job", run_id: "proof" });
      assert.throws(() => externalReceipt(f, "proof", "passed", "proof", () => f.store.save(kind, id, { ...payload(f.store.get(kind, id)), ...change })), /binding|independent|Evidence|terminal/);
      assert.equal(f.store.list("procedure_automation_outcome", 100).length, 0);
    } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
  }
  const f = await fixture();
  try {
    await routeableWorkflow(f, "legacy", "result.txt");
    f.service.procedureAutomationSave({ job_id: "legacy", procedure_id: "legacy", workspace: f.workspace, verifier_step_id: "verify-artifact" });
    f.service.procedureAutomationRun({ job_id: "legacy", run_id: "legacy" });
    assert.throws(() => externalReceipt(f, "legacy", "passed"), /revalidation/);
    f.service.procedureAutomationSave({ ...binding, job_id: "bound", procedure_id: "legacy", workspace: f.workspace, verifier_step_id: "verify-artifact" });
    f.service.procedureAutomationRun({ job_id: "bound", run_id: "one" }); externalReceipt(f, "one", "passed");
    f.service.procedureAutomationRun({ job_id: "bound", run_id: "two" });
    const session = f.store.get("host_session", "session-one");
    f.store.save("host_session", "session-one", { ...payload(session), capability_fingerprint: stableDigest(payload(f.store.get("procedure_automation_dispatch", "procedure_automation_dispatch_two"))) });
    assert.throws(() => f.service.procedureAutomationReceiptRecord({ run_id: "two", host_session_id: "session-one", observation_id: "observation-one", acceptance_evidence_ids: ["evidence-one"] }), /replayed/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Automation validates scheduling inputs, idempotency, pauses and non-executable definitions", async () => {
  const f = await fixture();
  try {
    const procedure = await routeableWorkflow(f, "config", "result.txt");
    const args = { ...binding, job_id: "job", procedure_id: procedure.id, workspace: f.workspace, verifier_step_id: "verify-artifact" };
    for (const changes of [{ workspace: " " }, { inputs: [] }, { max_attempts: 0 }, { now: "invalid" }, { verifier_step_id: "absent" }]) {
      assert.throws(() => f.service.procedureAutomationSave({ ...args, ...changes }));
    }
    f.service.procedureAutomationSave(args);
    assert.equal(f.service.procedureAutomationSave(args).idempotent, true);
    assert.throws(() => f.service.procedureAutomationSave({ ...args, quota_slots: 10 }), /conflict/);
    f.service.procedureAutomationPause({ job_id: "job" });
    assert.equal(f.service.procedureAutomationRun({ job_id: "job" }).reason, "job_paused");
    assert.equal((f.service.procedureAutomationEligibility({ job_id: "job" }).eligibility as JsonObject).reason, "job_paused");
    f.service.procedureAutomationPause({ job_id: "job", paused: false });
    const prepared = f.service.procedureAutomationRun({ job_id: "job", run_id: "replay" });
    assert.equal(f.service.procedureAutomationRun({ job_id: "job", run_id: "replay" }).idempotent, true);
    f.service.procedureAutomationSave({ ...args, job_id: "other" });
    assert.throws(() => f.service.procedureAutomationRun({ job_id: "other", run_id: "replay" }), /conflict/);
    assert.equal((prepared.run as JsonObject).status, "awaiting_host_dispatch");
    const kernel = f.service.procedureAutomation;
    assert.equal(kernel.tick({ service_id: "missing" }).status, "skipped");
    assert.equal(kernel.tick().count, 0);
    const job = f.store.get("procedure_automation_job", "other");
    f.store.save("procedure_automation_job", "other", { ...payload(job), no_progress_count: 2 });
    assert.equal((kernel.eligibility({ job_id: "other" }).eligibility as JsonObject).reason, "no_progress_limit");
    for (const kind of ["graph", "prompt"]) {
      f.store.save("experience_procedure", "config", { ...payload(procedure), procedure_kind: kind });
      assert.throws(() => kernel.save({ ...args, job_id: kind }), /Graph and Prompt/);
    }
    f.store.save("experience_procedure", "config", { ...payload(procedure), definition_ref: null });
    assert.throws(() => kernel.save({ ...args, job_id: "no-definition" }), /checked definition/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Automation hands off unchanged worlds and bounds interval retries", async () => {
  const f = await fixture();
  try {
    await routeableWorkflow(f, "unchanged", "result.txt");
    f.service.procedureAutomationSave({ ...binding, job_id: "unchanged", procedure_id: "unchanged", workspace: f.workspace, verifier_step_id: "verify-artifact", max_no_progress: 1 });
    f.service.procedureAutomationRun({ job_id: "unchanged", run_id: "initial" }); externalReceipt(f, "initial", "passed");
    const legacyJob = { ...payload(f.store.get("procedure_automation_job", "unchanged")) };
    delete legacyJob.no_progress_count;
    f.store.save("procedure_automation_job", "unchanged", legacyJob);
    f.service.procedureAutomationRun({ job_id: "unchanged", run_id: "unchanged" });
    assert.equal((externalReceipt(f, "unchanged", "passed").job as JsonObject).status, "requires_handoff");
    assert.equal((f.service.procedureAutomationEligibility({ job_id: "unchanged" }).eligibility as JsonObject).decision, "handoff");
    f.service.procedureAutomationSave({ ...binding, job_id: "retry", procedure_id: "unchanged", workspace: f.workspace, verifier_step_id: "verify-artifact", trigger: "interval", max_attempts: 2 });
    f.service.procedureAutomationRun({ job_id: "retry", run_id: "retry" });
    const retried = externalReceipt(f, "retry", "failed");
    assert.equal((retried.job as JsonObject).next_run_at, "2030-01-01T00:01:00.000Z");
    f.service.procedureAutomationSave({ ...binding, job_id: "manual-retry", procedure_id: "unchanged", workspace: f.workspace, verifier_step_id: "verify-artifact", max_attempts: 2 });
    f.service.procedureAutomationRun({ job_id: "manual-retry", run_id: "manual-retry" });
    assert.equal((externalReceipt(f, "manual-retry", "failed").job as JsonObject).next_run_at, null);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Automation effects and legacy scheduling records fail closed without executing commands", async () => {
  const f = await fixture();
  try {
    const kernel = f.service.procedureAutomation;
    const args = { ...binding, workspace: f.workspace, verifier_step_id: "verify-artifact", notification: "record_only" };
    await routeableWorkflow(f, "external", "x", ["external_write"]);
    assert.throws(() => kernel.save({ ...args, procedure_id: "external" }), /Effects/);
    await routeableWorkflow(f, "write", "x", ["local_write"]);
    assert.throws(() => kernel.save({ ...args, procedure_id: "write" }), /local_write/);
    const job = kernel.save({ ...args, procedure_id: "write", allow_local_write: true }).job as JsonObject;
    const legacy = { ...payload(job) }; delete legacy.failure_count; delete legacy.dispatch_timeout_seconds;
    f.store.save("procedure_automation_job", String(job.id), legacy);
    const prepared = kernel.run({ job_id: job.id, run_id: "write" });
    assert.deepEqual((prepared.dispatch as JsonObject).allowed_effects, ["read_only", "local_write"]);
    externalReceipt(f, "write", "failed", "write", () => {
      for (const acceptance_evidence_ids of [undefined, []]) {
        assert.throws(() => kernel.receiptRecord({ run_id: "write", host_session_id: "session-write", observation_id: "observation-write", acceptance_evidence_ids }), /acceptance Evidence/);
      }
    });
    for (const steps of [undefined, []]) {
      const id = steps ? "empty" : "absent";
      await routeableWorkflow(f, id, "x", [], steps ? { steps } : {});
      assert.throws(() => kernel.save({ ...args, procedure_id: id }), /contain steps/);
    }
    await routeableWorkflow(f, "no-effects", "x", [], { steps: [{ id: "verify-artifact", type: "assertion", evaluator: "file_exists", path: "x" }] });
    const empty = kernel.save({ ...args, procedure_id: "no-effects", trigger: "interval", job_id: "empty-effects" }).job as JsonObject;
    assert.deepEqual((kernel.run({ job_id: empty.id, run_id: "empty-effects" }).dispatch as JsonObject).allowed_effects, []);
    assert.throws(() => externalReceipt(f, "empty-effects", "passed", "empty-effects", () => {
      const activation = f.store.get("capability_kit_activation", binding.activation_id);
      f.store.save("capability_kit_activation", binding.activation_id, { ...payload(activation), status: "revoked" });
    }), /binding/);
    kernel.save({ ...args, procedure_id: "no-effects", job_id: "revoked-job" });
    assert.throws(() => kernel.run({ job_id: "revoked-job" }), /Activation/);
    const activation = f.store.get("capability_kit_activation", binding.activation_id);
    f.store.save("capability_kit_activation", binding.activation_id, { ...payload(activation), status: "active" });
    kernel.save({ ...args, procedure_id: "no-effects", trigger: "interval", job_id: "second-interval" });
    assert.equal(kernel.tick().count, 2);
    assert.equal((kernel.get({ job_id: "empty-effects" }).runs as JsonObject[]).length, 1);
    f.store.create("procedure_automation_quota_settlement", "legacy-quota", { job_id: "empty-effects", settled_at: "2100-01-01T00:00:00Z" });
    assert.equal((kernel.eligibility({ job_id: "empty-effects" }).eligibility as JsonObject).decision, "run");
    f.store.save("procedure_automation_job", "empty-effects", { ...payload(f.store.get("procedure_automation_job", "empty-effects")), status: "requires_handoff" });
    assert.equal((kernel.eligibility({ job_id: "empty-effects" }).eligibility as JsonObject).handoff_id, null);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("routeable Workflow jobs dispatch through Local Runtime ticks and await external receipts", async () => {
  const f = await fixture();
  try {
    await mkdir(f.workspace, { recursive: true });
    await writeFile(join(f.workspace, "result.txt"), "ok", "utf8");
    await routeableWorkflow(f, "good", "result.txt");
    const job = f.service.procedureAutomationSave({ ...binding, job_id: "good-job", procedure_id: "good", workspace: f.workspace,
      verifier_step_id: "verify-artifact", trigger: "interval", interval_seconds: 60, now: "2030-01-01T00:00:00.000Z" }).job as JsonObject;
    assert.equal(job.next_run_at, "2030-01-01T00:00:00.000Z");
    f.service.localRuntimeServiceConfigure({ service_id: "local" }); f.service.localRuntimeServiceStart({ service_id: "local" });
    const tick = f.service.localRuntimeServiceTick({ service_id: "local", now: "2030-01-01T00:00:00.000Z" });
    assert.equal(((tick.automation as JsonObject).count), 1);
    const view = f.service.procedureAutomationGet({ job_id: "good-job" });
    assert.equal(((view.runs as JsonObject[])[0]!.status), "awaiting_host_dispatch");
    const completed = externalReceipt(f, String((view.runs as JsonObject[])[0]!.id), "passed");
    assert.equal((completed.outcome as JsonObject).status, "accepted");
    assert.equal(((f.service.procedureAutomationGet({ job_id: "good-job" }).runs as JsonObject[])[0]!.status), "completed");
    assert.equal((view.job as JsonObject).failure_count, 0);
    const mcp = new McpServer(f.service, "full");
    const response = await mcp.handle({ id: 1, method: "tools/call", params: { name: "craft_automation_job_get", arguments: { job_id: "good-job" } } });
    assert.equal((response?.result as JsonObject).isError, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Automation fails closed for non-routeable procedures and creates a handoff after external failure", async () => {
  const f = await fixture();
  try {
    const procedure = await routeableWorkflow(f, "missing", "missing.txt");
    assert.throws(() => f.service.procedureAutomationSave({ procedure_id: "missing", workspace: f.workspace, verifier_step_id: "verify-artifact", trigger: "cron" }), /trigger/u);
    const saved = f.service.procedureAutomationSave({ ...binding, job_id: "missing-job", procedure_id: "missing", workspace: f.workspace,
      verifier_step_id: "verify-artifact", max_attempts: 1 }) as JsonObject;
    assert.equal((saved.job as JsonObject).status, "active");
    const run = f.service.procedureAutomationRun({ job_id: "missing-job", now: "2030-01-01T00:00:00.000Z" });
    assert.equal((run.run as JsonObject).status, "awaiting_host_dispatch");
    const failed = externalReceipt(f, String((run.run as JsonObject).id), "failed");
    assert.equal((failed.outcome as JsonObject).status, "failed");
    const view = f.service.procedureAutomationGet({ job_id: "missing-job" });
    assert.equal((view.job as JsonObject).status, "requires_handoff");
    assert.equal((view.notices as JsonObject[]).length, 1);
    f.store.save("experience_procedure", String(procedure.id), { ...procedure, lifecycle: "candidate", routeable: false });
    assert.throws(() => f.service.procedureAutomationSave({ procedure_id: "missing", workspace: f.workspace, verifier_step_id: "verify-artifact" }), /routeable/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Automation spends quota only after accepted external verification and stops at quota", async () => {
  const f = await fixture();
  try {
    await mkdir(f.workspace, { recursive: true });
    await writeFile(join(f.workspace, "result.txt"), "ok", "utf8");
    await routeableWorkflow(f, "bounded", "result.txt");
    f.service.procedureAutomationSave({ ...binding, job_id: "bounded-job", procedure_id: "bounded", workspace: f.workspace,
      verifier_step_id: "verify-artifact", quota_slots: 2, max_no_progress: 2 });
    const first = f.service.procedureAutomationRun({ job_id: "bounded-job", run_id: "first", now: "2030-01-01T00:00:00.000Z" });
    const firstReceipt = externalReceipt(f, "first", "passed");
    assert.equal((firstReceipt.settlement as JsonObject).slots, 1);
    assert.equal((firstReceipt.progress as JsonObject).changed, true);
    const second = f.service.procedureAutomationRun({ job_id: "bounded-job", run_id: "second", now: "2030-01-01T00:01:00.000Z" });
    const secondReceipt = externalReceipt(f, "second", "passed");
    assert.equal((secondReceipt.settlement as JsonObject).slots, 1);
    assert.equal((secondReceipt.progress as JsonObject).changed, false);
    const third = f.service.procedureAutomationRun({ job_id: "bounded-job", run_id: "third", now: "2030-01-01T00:02:00.000Z" });
    assert.equal(third.status, "skipped");
    assert.equal(((f.service.procedureAutomationEligibility({ job_id: "bounded-job", now: "2030-01-01T00:03:00.000Z" }).eligibility as JsonObject).reason), "quota_exhausted");
    const mcp = new McpServer(f.service, "full");
    const response = await mcp.handle({ id: 1, method: "tools/call", params: { name: "craft_automation_job_eligibility", arguments: { job_id: "bounded-job" } } });
    assert.equal((response?.result as JsonObject).isError, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
