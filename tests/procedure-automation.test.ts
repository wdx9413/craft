import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcedureDefinitionStore } from "../capability/craft-experience/procedure-definition.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { McpServer } from "../core/mcp.ts";
import { CraftService } from "../core/service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-procedure-automation-"));
  const workspace = join(root, "workspace");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  return { root, workspace, store, service: new CraftService(store) };
}

async function routeableWorkflow(f: Awaited<ReturnType<typeof fixture>>, id: string, path: string) {
  const definition = new ProcedureDefinitionStore(f.store.paths).write({
    schema_version: "craft.procedure.v1", procedure_id: id, procedure_version: 1, kind: "workflow",
    scope: "project:automation", trigger: "verify generated artifact", preconditions: ["workspace exists"],
    allowed_effects: ["read"], acceptance_ref: "assertion:artifact", failure_disposition: "checkpoint_and_handoff",
    scenario_signature: { target_class: "fixture", effect: "read_only" }, evidence_ids: ["evidence"],
    proposal_ref: { id: "proposal", version: 1 }, definition: { inputs: [], steps: [
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

function externalReceipt(f: Awaited<ReturnType<typeof fixture>>, runId: string, verdict: "passed" | "failed", suffix = runId) {
  f.store.create("host_session", `session-${suffix}`, { host_id: "codex", trace_id: `trace-${suffix}`, status: "terminal" });
  f.store.create("outcome_observation", `observation-${suffix}`, { trace_id: `trace-${suffix}`, host_id: "codex", observer_id: "workspace-verifier", verdict });
  f.store.create("evidence", `evidence-${suffix}`, { source_type: "program", confidence: "confirmed" });
  return f.service.procedureAutomationReceiptRecord({ run_id: runId, host_session_id: `session-${suffix}`, observation_id: `observation-${suffix}`, acceptance_evidence_ids: [`evidence-${suffix}`], observed_at: "2030-01-01T00:00:00.000Z" });
}

test("Automation only dispatches work and accepts an independent terminal Host receipt", async () => {
  const f = await fixture();
  try {
    await routeableWorkflow(f, "external", "result.txt");
    f.service.procedureAutomationSave({ job_id: "external-job", procedure_id: "external", workspace: f.workspace, verifier_step_id: "verify-artifact" });
    const prepared = f.service.procedureAutomationRun({ job_id: "external-job", run_id: "external-run" });
    assert.equal((prepared.run as JsonObject).status, "awaiting_host_dispatch");
    assert.ok((prepared.dispatch as JsonObject).id);
    f.store.create("host_session", "external-session", { host_id: "codex", trace_id: "external-trace", status: "terminal" });
    f.store.create("outcome_observation", "external-observation", { trace_id: "external-trace", host_id: "codex", observer_id: "workspace-verifier", verdict: "passed" });
    f.store.create("evidence", "external-evidence", { source_type: "program", confidence: "confirmed" });
    const completed = f.service.procedureAutomationReceiptRecord({ run_id: "external-run", host_session_id: "external-session", observation_id: "external-observation", acceptance_evidence_ids: ["external-evidence"] });
    assert.equal((completed.run as JsonObject).status, "completed");
    assert.equal((completed.outcome as JsonObject).acceptance_source, "independent_host_observation");
    assert.throws(() => f.service.procedureAutomationReceiptRecord({ run_id: "external-run", host_session_id: "external-session", observation_id: "external-observation", acceptance_evidence_ids: [] }), /not awaiting/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("routeable Workflow jobs dispatch through Local Runtime ticks and await external receipts", async () => {
  const f = await fixture();
  try {
    await mkdir(f.workspace, { recursive: true });
    await writeFile(join(f.workspace, "result.txt"), "ok", "utf8");
    await routeableWorkflow(f, "good", "result.txt");
    const job = f.service.procedureAutomationSave({ job_id: "good-job", procedure_id: "good", workspace: f.workspace,
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
    const saved = f.service.procedureAutomationSave({ job_id: "missing-job", procedure_id: "missing", workspace: f.workspace,
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
    f.service.procedureAutomationSave({ job_id: "bounded-job", procedure_id: "bounded", workspace: f.workspace,
      verifier_step_id: "verify-artifact", quota_slots: 2, max_no_progress: 2 });
    const first = f.service.procedureAutomationRun({ job_id: "bounded-job", run_id: "first", now: "2030-01-01T00:00:00.000Z" });
    const firstReceipt = externalReceipt(f, "first", "passed");
    assert.equal((firstReceipt.settlement as JsonObject).slots, 1);
    assert.equal((firstReceipt.progress as JsonObject).changed, true);
    const second = f.service.procedureAutomationRun({ job_id: "bounded-job", run_id: "second", now: "2030-01-01T00:01:00.000Z" });
    const secondReceipt = externalReceipt(f, "second", "passed");
    assert.equal((secondReceipt.settlement as JsonObject).slots, 1);
    const third = f.service.procedureAutomationRun({ job_id: "bounded-job", run_id: "third", now: "2030-01-01T00:02:00.000Z" });
    assert.equal(third.status, "skipped");
    assert.equal(((f.service.procedureAutomationEligibility({ job_id: "bounded-job", now: "2030-01-01T00:03:00.000Z" }).eligibility as JsonObject).reason), "quota_exhausted");
    const mcp = new McpServer(f.service, "full");
    const response = await mcp.handle({ id: 1, method: "tools/call", params: { name: "craft_automation_job_eligibility", arguments: { job_id: "bounded-job" } } });
    assert.equal((response?.result as JsonObject).isError, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
