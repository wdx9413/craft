import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContinualHarnessKernel } from "../src/continual-harness.ts";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { StatefulComputeKernel } from "../src/stateful-compute.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v1220-")); const store = await new CraftStore(craftPaths(root)).open();
  store.create("task", "task", { title: "Goal", status: "active" });
  store.create("evidence", "confirmed", { confidence: "confirmed" }); store.create("evidence", "bounded", { confidence: "bounded" }); store.create("evidence", "bad", { confidence: "unverified" });
  store.create("memory_ledger", "memory", { status: "active" }); store.create("workflow", "workflow", { lifecycle: "verified" });
  store.create("trial", "trial", { task_id: "task", status: "completed" }); store.create("acceptance_gate", "gate", { task_id: "task", verdict: "failed" });
  store.create("context_resolution_receipt", "context", { content_free: true });
  return { root, store, harness: new ContinualHarnessKernel(store), compute: new StatefulComputeKernel(store) };
}

test("v0.12.20 turns trajectory evidence into bounded or governed Harness refinements", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.harness.viewCreate({ task_id: "task", bindings: [{ kind: "bad", id: "memory" }] }), /unsupported/);
    assert.throws(() => f.harness.viewCreate({ task_id: "task", bindings: [{ kind: "memory_ledger", id: "memory", version: 0 }] }), /positive integer/);
    assert.throws(() => f.harness.viewCreate({ task_id: "task", bindings: [{ kind: "memory_ledger", id: "memory" }, { kind: "memory_ledger", id: "memory" }] }), /unique/);
    const view = f.harness.viewCreate({ view_id: "view", task_id: "task", bindings: [{ kind: "memory_ledger", id: "memory" }] }).view as JsonObject;
    assert.equal((f.harness.viewCreate({ view_id: "view", task_id: "task", bindings: [{ kind: "memory_ledger", id: "memory" }] }) as JsonObject).idempotent, true);
    assert.throws(() => f.harness.viewCreate({ view_id: "view", task_id: "task", bindings: [] }), /conflict/);
    f.store.create("task", "other", { title: "Other" }); const otherView = f.harness.viewCreate({ task_id: "other", bindings: [] }).view as JsonObject;
    f.store.create("task", "third", { title: "Third" }); assert.equal((f.harness.viewCreate({ task_id: "third" }).view as JsonObject).content_free, true);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: otherView.id, source_refs: [{}] }), /does not belong/);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: view.id, source_refs: [] }), /at least one/);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: view.id, source_refs: "bad" }), /at least one/);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: view.id, source_refs: [{ kind: "bad", id: "trial" }], evidence_ids: ["confirmed"], hypothesis: "x", changes: [{}] }), /unsupported/);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: view.id, source_refs: [{ kind: "trial", id: "trial" }], evidence_ids: ["bad"], hypothesis: "x", changes: [{}] }), /confirmed or bounded/);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: view.id, source_refs: [{ kind: "trial", id: "trial" }], evidence_ids: "bad", hypothesis: "x", changes: [{}] }), /array/);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: view.id, source_refs: [{ kind: "trial", id: "trial" }], evidence_ids: [], hypothesis: "x", changes: [{}] }), /at least one/);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: view.id, source_refs: [{ kind: "trial", id: "trial" }], evidence_ids: ["confirmed", "confirmed"], hypothesis: "x", changes: [{}] }), /unique/);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: view.id, source_refs: [{ kind: "trial", id: "trial" }], evidence_ids: ["confirmed"], hypothesis: "x", changes: [] }), /between one and four/);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: view.id, source_refs: [{ kind: "trial", id: "trial" }], evidence_ids: ["confirmed"], hypothesis: "x", changes: "bad" }), /between one and four/);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: view.id, source_refs: [{ kind: "trial", id: "trial" }], evidence_ids: ["confirmed"], hypothesis: "x", changes: ["bad"] }), /object/);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: view.id, session_id: "session", source_refs: [{ kind: "trial", id: "trial" }], evidence_ids: ["confirmed"], hypothesis: "", changes: [{ kind: "memory", action: "create", scope: "session", summary: "x" }] }), /empty/);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: view.id, session_id: "session", source_refs: [{ kind: "trial", id: "trial" }], evidence_ids: ["confirmed"], hypothesis: "token=abcdefgh", changes: [{ kind: "memory", action: "create", scope: "session", summary: "x" }] }), /credentials/);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: view.id, source_refs: [{ kind: "trial", id: "trial" }], evidence_ids: ["confirmed"], hypothesis: "x", changes: [{ kind: "bad", action: "create", scope: "session", summary: "x" }] }), /unsupported/);
    assert.throws(() => f.harness.refine({ task_id: "task", view_id: view.id, source_refs: [{ kind: "trial", id: "trial" }], evidence_ids: ["confirmed"], hypothesis: "x", changes: [{ kind: "memory", action: "create", scope: "session", summary: "x" }, { kind: "skill", action: "create", scope: "project", summary: "x" }, { kind: "workflow", action: "create", scope: "project", summary: "x" }] }), /two Harness/);

    f.store.create("trial", "foreign", { task_id: "other", status: "completed" });
    assert.throws(() => f.harness.refine({ refinement_id: "foreign", task_id: "task", view_id: view.id, source_refs: [{ kind: "trial", id: "foreign" }], evidence_ids: ["bounded"], hypothesis: "wrong task", changes: [{ kind: "memory", action: "create", scope: "session", summary: "x" }], session_id: "session" }), /does not belong/);
    const localArgs = { refinement_id: "local", task_id: "task", view_id: view.id, session_id: "session", source_refs: [{ kind: "trial", id: "trial" }], evidence_ids: ["bounded"], hypothesis: "Remember the successful tactic", changes: [{ kind: "memory", action: "create", scope: "session", summary: "Use the observed tactic" }] };
    const local = f.harness.refine(localArgs).refinement as JsonObject; assert.equal(local.risk, "low");
    assert.equal((f.harness.refine(localArgs) as JsonObject).idempotent, true);
    assert.throws(() => f.harness.refine({ ...localArgs, hypothesis: "changed" }), /conflict/);
    assert.throws(() => f.harness.submit({ refinement_id: local.id }), /privacy review/);
    assert.throws(() => f.harness.submit({ refinement_id: local.id, privacy_reviewed: true, ttl_seconds: 1 }), /between 60/);
    const active = f.harness.submit({ refinement_id: local.id, privacy_reviewed: true, ttl_seconds: 60 }).refinement as JsonObject; assert.equal(active.lifecycle, "bounded_active");
    assert.throws(() => f.harness.submit({ refinement_id: local.id, privacy_reviewed: true }), /draft/);
    assert.equal((f.harness.get({ refinement_id: local.id }).refinement as JsonObject).publication_allowed, false);
    const resolved = f.harness.resolve({ receipt_id: "resolution", view_id: view.id, session_id: "session", now: "2026-01-01T00:00:00.000Z" }); assert.equal(((resolved.receipt as JsonObject).refinement_refs as JsonObject[]).length, 1);
    assert.equal((f.harness.resolve({ receipt_id: "resolution", view_id: view.id, session_id: "session", now: "2026-01-01T00:00:00.000Z" }) as JsonObject).idempotent, true);
    assert.throws(() => f.harness.resolve({ receipt_id: "resolution", view_id: view.id, session_id: "other", now: "2026-01-01T00:00:00.000Z" }), /conflict/);
    assert.throws(() => f.harness.resolve({ view_id: view.id, session_id: "session", now: "never" }), /ISO/);
    assert.equal((f.harness.rollback({ refinement_id: local.id, reason: "not useful", evidence_ids: ["confirmed"] }).refinement as JsonObject).lifecycle, "rolled_back");
    assert.throws(() => f.harness.rollback({ refinement_id: local.id, reason: "again", evidence_ids: ["confirmed"] }), /not active/);

    const governedArgs = { refinement_id: "governed", task_id: "task", view_id: view.id, source_refs: [{ kind: "acceptance_gate", id: "gate" }], evidence_ids: ["confirmed"], hypothesis: "A reusable Skill may prevent the failure", changes: [{ kind: "skill", action: "update", scope: "project", target_id: "skill", summary: "Add the verified recovery rule" }] };
    assert.ok((f.harness.refine({ ...localArgs, refinement_id: undefined }).refinement as JsonObject).id);
    const defaultTtl = f.harness.refine({ ...localArgs, refinement_id: "default-ttl", hypothesis: "A second local tactic" }).refinement as JsonObject; assert.ok((f.harness.submit({ refinement_id: defaultTtl.id, privacy_reviewed: true }).refinement as JsonObject).expires_at);
    assert.equal((f.harness.refine(governedArgs).refinement as JsonObject).risk, "governed");
    assert.equal((f.harness.submit({ refinement_id: "governed" }).refinement as JsonObject).lifecycle, "evaluation_required");
    f.store.create("evaluation_reliability", "ineligible", { status: "inconclusive" });
    assert.throws(() => f.harness.shadow({ refinement_id: defaultTtl.id, assessment_id: "ineligible" }), /not awaiting/);
    assert.throws(() => f.harness.shadow({ refinement_id: "governed", assessment_id: "ineligible" }), /eligible/);
    f.store.create("evaluation_reliability", "eligible", { status: "eligible" }); const ready = f.harness.shadow({ refinement_id: "governed", assessment_id: "eligible" }).refinement as JsonObject;
    f.store.create("signoff", "wrong", { decision: "failed" }); assert.throws(() => f.harness.authorizeCanary({ refinement_id: ready.id, signoff_id: "wrong" }), /exact version/);
    assert.throws(() => f.harness.authorizeCanary({ refinement_id: defaultTtl.id, signoff_id: "wrong" }), /not ready/);
    f.store.create("signoff", "right", { decision: "passed", subject_type: "harness_refinement", subject_id: ready.id, subject_version: ready.version });
    const canary = f.harness.authorizeCanary({ refinement_id: ready.id, signoff_id: "right", canary_id: "canary" }).canary as JsonObject;
    assert.throws(() => f.harness.observeCanary({ canary_id: canary.id, metric: "cost", baseline: -1, candidate: 1 }), /non-negative/);
    assert.equal((f.harness.observeCanary({ canary_id: canary.id, metric: "cost", baseline: 1, candidate: 1, threshold: 0.1 }).canary as JsonObject).status, "running");
    assert.equal((f.harness.observeCanary({ canary_id: canary.id, metric: "cost", baseline: 1, candidate: 1, threshold: 0.1, complete: true }).refinement as JsonObject).lifecycle, "active");
    assert.throws(() => f.harness.observeCanary({ canary_id: canary.id, metric: "cost", baseline: 1, candidate: 1 }), /not running/);
    assert.equal((f.harness.rollback({ refinement_id: ready.id, reason: "manual rollback", evidence_ids: ["bounded"] }).refinement as JsonObject).publication_allowed, false);
    f.store.create("harness_refinement", "regression", { lifecycle: "canary_running", before_snapshot: "before", after_snapshot: "after", publication_allowed: false });
    f.store.create("harness_refinement_canary", "regression-canary", { refinement_id: "regression", refinement_version: 1, status: "running" });
    const regressed = f.harness.observeCanary({ canary_id: "regression-canary", metric: "quality_loss", baseline: 0, candidate: 1, threshold: 0.1 }); assert.equal((regressed.refinement as JsonObject).rollback_snapshot, "before");
    f.store.create("harness_refinement", "quality-regression", { lifecycle: "canary_running", before_snapshot: "before", after_snapshot: "after", publication_allowed: false });
    f.store.create("harness_refinement_canary", "quality-canary", { refinement_id: "quality-regression", refinement_version: 1, status: "running" });
    assert.equal((f.harness.observeCanary({ canary_id: "quality-canary", metric: "quality", direction: "higher_is_better", baseline: 1, candidate: 0, threshold: 0.1 }).refinement as JsonObject).lifecycle, "rolled_back");
    f.store.create("harness_refinement", "bad-direction", { lifecycle: "canary_running", before_snapshot: "before", after_snapshot: "after" });
    f.store.create("harness_refinement_canary", "bad-direction-canary", { refinement_id: "bad-direction", refinement_version: 1, status: "running" });
    assert.throws(() => f.harness.observeCanary({ canary_id: "bad-direction-canary", metric: "x", direction: "unknown", baseline: 1, candidate: 1 }), /direction/);
    f.store.create("harness_refinement", "default-canary", { lifecycle: "signoff_ready", before_snapshot: "before", after_snapshot: "after" });
    f.store.create("signoff", "default-signoff", { decision: "passed", subject_type: "harness_refinement", subject_id: "default-canary", subject_version: 1 });
    assert.ok((f.harness.authorizeCanary({ refinement_id: "default-canary", signoff_id: "default-signoff" }).canary as JsonObject).id);
    f.store.create("outcome", "outcome_trial", { trial_id: "trial", verdict: "passed" }); assert.equal((f.harness.signals({ task_id: "task" }).sources as JsonObject[]).length, 2);
    assert.equal((f.harness.signals({ task_id: "other" }).sources as JsonObject[]).length, 0);
    assert.ok((f.harness.refine({ refinement_id: "outcome-refinement", task_id: "task", view_id: view.id, source_refs: [{ kind: "outcome", id: "outcome_trial" }], evidence_ids: ["confirmed"], hypothesis: "Reuse verified outcome", changes: [{ kind: "workflow", action: "update", scope: "project", summary: "candidate" }] }).refinement as JsonObject).id);
    f.store.create("harness_refinement", "active-global", { view_id: view.id, lifecycle: "active", after_snapshot: "global" });
    f.store.create("harness_refinement", "expired-local", { view_id: view.id, lifecycle: "bounded_active", session_id: "session", expires_at: "2020-01-01T00:00:00.000Z", after_snapshot: "expired" });
    const currentResolution = f.harness.resolve({ view_id: view.id, session_id: "session" }); assert.ok((currentResolution.receipt as JsonObject).id); assert.equal((currentResolution.expired as JsonObject[]).length, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.20 keeps stateful compute and Sub-agent calls generic, receipt-bound and non-executing", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.compute.hostRegister({ kind: "vendor-agent", label: "x" }), /unsupported/);
    assert.throws(() => f.compute.hostRegister({ kind: "agent_host", label: "" }), /empty/);
    assert.throws(() => f.compute.hostRegister({ kind: "agent_host", label: "token=abcdefgh" }), /credentials/);
    assert.throws(() => f.compute.hostRegister({ kind: "agent_host", label: "x", trust: "untrusted" }), /bounded or verified/);
    assert.throws(() => f.compute.hostRegister({ kind: "repl", label: "x", generated_code: true }), /conformance/);
    f.store.create("sandbox_conformance", "bad-conformance", { status: "unverified", isolation: "none", network: "allow" });
    assert.throws(() => f.compute.hostRegister({ kind: "repl", label: "x", generated_code: true, conformance_id: "bad-conformance" }), /not verified/);
    f.store.create("sandbox_conformance", "conformance", { status: "verified", isolation: "verified", network: "deny" });
    const generated = f.compute.hostRegister({ host_id: "generated", kind: "repl", label: "Sandboxed REPL", generated_code: true, conformance_id: "conformance", capabilities: ["snapshot"] }).host as JsonObject;
    assert.equal((f.compute.hostRegister({ host_id: "generated", kind: "repl", label: "Sandboxed REPL", generated_code: true, conformance_id: "conformance", capabilities: ["snapshot"] }) as JsonObject).idempotent, true);
    assert.throws(() => f.compute.hostRegister({ host_id: "generated", kind: "repl", label: "Changed", generated_code: true, conformance_id: "conformance", capabilities: ["snapshot"] }), /conflict/);
    const host = f.compute.hostRegister({ host_id: "host", kind: "agent_host", label: "Generic Host" }).host as JsonObject;
    assert.ok((f.compute.hostRegister({ kind: "notebook", label: "Ephemeral notebook" }).host as JsonObject).id);
    assert.throws(() => f.compute.hostRegister({ kind: "custom", label: "Duplicate capabilities", capabilities: ["state", "state"] }), /unique/);
    assert.throws(() => f.compute.hostRegister({ kind: "custom", label: "Malformed capabilities", capabilities: "state" }), /array/);
    f.store.save("stateful_compute_host", "host", { ...host, status: "disabled" }); assert.throws(() => f.compute.sessionPrepare({ task_id: "task", host_id: "host", context_receipt_id: "context", environment_fingerprint: "env", workspace_snapshot_ref: "snapshot", budget_ref: "budget" }), /not active/);
    const host2 = f.compute.hostRegister({ host_id: "host2", kind: "custom", label: "Host 2" }).host as JsonObject;
    f.store.create("context_resolution_receipt", "raw-context", { content_free: false }); assert.throws(() => f.compute.sessionPrepare({ task_id: "task", host_id: host2.id, context_receipt_id: "raw-context", environment_fingerprint: "env", workspace_snapshot_ref: "snapshot", budget_ref: "budget" }), /content-free/);
    assert.throws(() => f.compute.sessionPrepare({ task_id: "task", host_id: host2.id, context_receipt_id: "context", environment_fingerprint: "env", workspace_snapshot_ref: "snapshot", budget_ref: "budget", allowed_effect: "local_write" }), /conformance/);
    const writeSession = f.compute.sessionPrepare({ session_id: "write", task_id: "task", host_id: generated.id, context_receipt_id: "context", environment_fingerprint: "env", workspace_snapshot_ref: "snapshot", budget_ref: "budget", allowed_effect: "local_write" }).session as JsonObject; assert.equal(writeSession.execution_authority, false);
    assert.ok((f.compute.sessionPrepare({ task_id: "task", host_id: generated.id, context_receipt_id: "context", environment_fingerprint: "env-2", workspace_snapshot_ref: "snapshot", budget_ref: "budget" }).session as JsonObject).id);
    const sessionArgs = { session_id: "session", task_id: "task", host_id: host2.id, context_receipt_id: "context", environment_fingerprint: "env", workspace_snapshot_ref: "snapshot", budget_ref: "budget" };
    const session = f.compute.sessionPrepare(sessionArgs).session as JsonObject; assert.equal((f.compute.sessionPrepare(sessionArgs) as JsonObject).idempotent, true);
    assert.throws(() => f.compute.sessionPrepare({ ...sessionArgs, environment_fingerprint: "changed" }), /conflict/);
    assert.throws(() => f.compute.dispatch({ session_id: session.id, expected_revision: 1, operation: "inspect" }), /revision changed/);
    const dispatchArgs = { dispatch_id: "dispatch", session_id: session.id, expected_revision: 0, operation: "inspect", input_refs: ["artifact:one"] };
    const dispatch = f.compute.dispatch(dispatchArgs).dispatch as JsonObject; assert.equal(dispatch.execution_authority, false);
    assert.throws(() => f.compute.dispatch({ session_id: writeSession.id, expected_revision: 0, operation: "inspect", input_refs: ["same", "same"] }), /unique/);
    assert.ok((f.compute.dispatch({ session_id: writeSession.id, expected_revision: 0, operation: "inspect" }).dispatch as JsonObject).id);
    assert.equal((f.compute.dispatch(dispatchArgs) as JsonObject).idempotent, true);
    assert.throws(() => f.compute.dispatch({ ...dispatchArgs, operation: "changed" }), /conflict/);
    assert.throws(() => f.compute.dispatch({ session_id: session.id, expected_revision: 0, operation: "second" }), /not dispatchable/);
    assert.throws(() => f.compute.observe({ dispatch_id: dispatch.id, observed_revision: 2, environment_fingerprint: "env", state_digest: "state", status: "completed" }), /stale revision/);
    assert.throws(() => f.compute.observe({ dispatch_id: dispatch.id, observed_revision: 1, environment_fingerprint: "changed", state_digest: "state", status: "completed" }), /environment drift/);
    assert.throws(() => f.compute.observe({ dispatch_id: dispatch.id, observed_revision: 1, environment_fingerprint: "env", state_digest: "state", status: "running" }), /unsupported/);
    const observed = f.compute.observe({ dispatch_id: dispatch.id, observed_revision: 1, environment_fingerprint: "env", state_digest: "state", status: "completed", output_refs: ["artifact:result"] }); assert.equal((observed.receipt as JsonObject).reobserved, true);
    assert.throws(() => f.compute.observe({ dispatch_id: dispatch.id, observed_revision: 1, environment_fingerprint: "env", state_digest: "state", status: "completed" }), /awaiting/);
    assert.equal((f.compute.sessionGet({ session_id: session.id }).session as JsonObject).state_revision, 1);
    assert.throws(() => f.compute.delegate({ session_id: session.id, objective: "inspect", result_schema: {} }), /cannot delegate/);

    const delegated = f.compute.sessionPrepare({ session_id: "delegated", task_id: "task", host_id: host2.id, context_receipt_id: "context", environment_fingerprint: "env", workspace_snapshot_ref: "snapshot", budget_ref: "root-budget" }).session as JsonObject;
    assert.throws(() => f.compute.delegate({ session_id: delegated.id, objective: "inspect" }), /result_schema/);
    const callArgs = { call_id: "call-0", session_id: delegated.id, objective: "Inspect module", result_schema: { type: "object" }, context_refs: ["artifact:one"], allocation: { tokens: 100 } };
    const call = f.compute.delegate(callArgs).call as JsonObject; assert.equal(call.effect, "read_only"); assert.equal(call.budget_ref, "root-budget"); assert.equal((f.compute.delegate(callArgs) as JsonObject).idempotent, true);
    assert.throws(() => f.compute.delegate({ ...callArgs, objective: "changed" }), /conflict/);
    for (let index = 1; index < 5; index += 1) f.compute.delegate({ call_id: `call-${index}`, session_id: delegated.id, objective: `Inspect ${index}`, result_schema: {} });
    assert.throws(() => f.compute.delegate({ call_id: "call-5", session_id: delegated.id, objective: "Too many", result_schema: {} }), /at most five/);
    assert.throws(() => f.compute.report({ call_id: call.id, hypotheses: ["h"], counterexamples: ["c"], evidence_ids: [], confidence: "confirmed", next_action: "report" }), /at least one/);
    assert.throws(() => f.compute.report({ call_id: call.id, hypotheses: ["h"], counterexamples: ["c"], evidence_ids: ["confirmed"], confidence: "certain", next_action: "report" }), /unsupported/);
    assert.throws(() => f.compute.report({ call_id: "call-1", hypotheses: ["h"], counterexamples: ["c"], evidence_ids: ["bad"], confidence: "confirmed", next_action: "report" }), /confirmed or bounded/);
    const report = f.compute.report({ call_id: call.id, hypotheses: ["h"], counterexamples: ["c"], evidence_ids: ["confirmed"], confidence: "confirmed", next_action: "report", output_refs: ["artifact:report"] }); assert.equal((report.call as JsonObject).status, "completed");
    assert.throws(() => f.compute.report({ call_id: call.id, hypotheses: ["h"], counterexamples: ["c"], evidence_ids: ["confirmed"], confidence: "confirmed", next_action: "again" }), /awaiting/);
    const another = f.compute.sessionPrepare({ session_id: "another", task_id: "task", host_id: host2.id, context_receipt_id: "context", environment_fingerprint: "env", workspace_snapshot_ref: "snapshot", budget_ref: "budget" }).session as JsonObject;
    const outstanding = f.compute.delegate({ session_id: another.id, objective: "Default call id", result_schema: {} }).call as JsonObject; assert.ok(outstanding.id);
    const cancelled = f.compute.cancel({ session_id: another.id, reason: "parent cancelled" }); assert.equal((cancelled.cancelled_calls as JsonObject[])[0]?.id, outstanding.id);
    assert.throws(() => f.compute.cancel({ session_id: another.id, reason: "again" }), /terminal/);

    const service = new CraftService(f.store); const full = new McpServer(service, "full"); const core = new McpServer(service, "core");
    assert.equal(full.tools.some((tool) => tool.name === "craft_stateful_compute_host_register"), true);
    assert.equal(core.tools.some((tool) => tool.name === "craft_continual_harness_refine"), true);
    const response = await full.handle({ id: 1, method: "tools/call", params: { name: "craft_stateful_compute_session_get", arguments: { session_id: session.id } } }); assert.equal((response?.result as JsonObject).isError, false);
    for (const name of ["craft_continual_harness_view_create", "craft_continual_harness_refine", "craft_continual_harness_submit", "craft_continual_harness_shadow", "craft_continual_harness_authorize_canary", "craft_continual_harness_observe_canary", "craft_continual_harness_rollback", "craft_continual_harness_signals", "craft_continual_harness_resolve", "craft_continual_harness_get", "craft_stateful_compute_host_register", "craft_stateful_compute_session_prepare", "craft_stateful_compute_dispatch", "craft_stateful_compute_observe", "craft_stateful_compute_delegate", "craft_stateful_compute_report", "craft_stateful_compute_cancel"]) {
      const failed = await full.handle({ id: name, method: "tools/call", params: { name, arguments: {} } }); assert.equal((failed?.result as JsonObject).isError, true, name);
    }
    assert.equal(VERSION, "0.12.24");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
