import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { DurableActionLoopKernel } from "../src/durable-action-loop.ts";
import { ExperienceLedgerKernel } from "../capability/craft-experience/experience-ledger.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-durable-experience-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  store.create("task", "task", { title: "Durable work", goal: "prove progress" });
  store.create("task_control_contract", "contract", { task_id: "task" }); store.create("task_run", "run", { contract_id: "contract", launch_id: "launch" });
  store.create("state_snapshot", "before", { workspace_id: "workspace", snapshot_digest: "sha256:before", workspace_state_revision: 1 });
  store.create("verified_work_loop", "loop", { task_id: "task", contract_id: "contract", task_run_id: "run", workspace_id: "workspace", latest_snapshot_id: "before", latest_task_run_state_id: null, lifecycle: "active" });
  store.create("verified_work_loop_receipt", "receipt", { work_loop_id: "loop" }); store.create("evidence", "confirmed", { confidence: "confirmed" }); store.create("evidence", "unverified", { confidence: "unverified" });
  store.create("workflow", "workflow", { name: "candidate" }); store.create("evaluation_reliability", "eligible", { status: "eligible" }); store.create("evaluation_reliability", "rejected", { status: "rejected" });
  return { root, store, service };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }

test("Durable Action Loop only advances a work item after a receipt, re-observation, and passed acceptance", async () => {
  const f = await fixture();
  try {
    const created = f.service.durableActionLoopCreate({ action_loop_id: "actions", work_loop_id: "loop", work_items: [{ id: "inspect", acceptance_digest: "sha256:inspect" }, { id: "deliver", depends_on: ["inspect"], acceptance_digest: "sha256:deliver" }] });
    assert.equal((created.loop as JsonObject).lifecycle, "active"); assert.equal(f.service.durableActionLoopCreate({ action_loop_id: "actions", work_loop_id: "loop", work_items: [{ id: "inspect", acceptance_digest: "sha256:inspect" }, { id: "deliver", depends_on: ["inspect"], acceptance_digest: "sha256:deliver" }] }).idempotent, true);
    assert.throws(() => f.service.durableActionLoopCreate({ work_loop_id: "loop", work_items: [{ id: "x", depends_on: ["y"], acceptance_digest: "a" }] }), /dependencies/);
    const execute = f.service.durableActionLoopPropose({ action_id: "execute", action_loop_id: "actions", item_key: "inspect", kind: "execute", effect: "read_only", action_digest: "sha256:execute" }).action as JsonObject;
    assert.equal(f.service.durableActionLoopNext({ action_loop_id: "actions" }).next_action, "await_receipt"); assert.equal((f.service.durableActionLoopDispatch({ action_id: execute.id, dispatch_ref: "host:dispatch" }).action as JsonObject).lifecycle, "dispatched");
    f.store.create("state_snapshot", "after-execute", { workspace_id: "workspace", snapshot_digest: "sha256:after-execute", workspace_state_revision: 2 });
    const executed = f.service.durableActionLoopReport({ action_id: execute.id, outcome: "succeeded", snapshot_id: "after-execute", receipt_ref: { kind: "verified_work_loop_receipt", id: "receipt", version: 1 } });
    assert.equal(executed.progress_proved, false); assert.equal(f.service.durableActionLoopNext({ action_loop_id: "actions" }).next_action, "propose_action");
    const verify = f.service.durableActionLoopPropose({ action_id: "verify", action_loop_id: "actions", item_key: "inspect", kind: "verify", action_digest: "sha256:verify" }).action as JsonObject;
    f.store.create("acceptance_gate", "acceptance", { verdict: "passed" }); f.store.create("state_snapshot", "after-verify", { workspace_id: "workspace", snapshot_digest: "sha256:after-verify", workspace_state_revision: 3 });
    const verified = f.service.durableActionLoopReport({ action_id: verify.id, outcome: "succeeded", snapshot_id: "after-verify", receipt_ref: { kind: "verified_work_loop_receipt", id: "receipt", version: 1 }, acceptance_ref: { kind: "acceptance_gate", id: "acceptance", version: 1 } });
    assert.equal(verified.progress_proved, true); assert.deepEqual((f.service.durableActionLoopNext({ action_loop_id: "actions" }).ready_items as JsonObject[]).map((item) => item.item_key), ["deliver"]);
    assert.throws(() => f.service.durableActionLoopReport({ action_id: "verify", outcome: "succeeded", snapshot_id: "after-verify", receipt_ref: { kind: "verified_work_loop_receipt", id: "receipt", version: 1 }, acceptance_ref: { kind: "acceptance_gate", id: "acceptance", version: 1 } }), /terminal/);
    const loaded = f.service.durableActionLoopGet({ action_loop_id: "actions" }); assert.equal((loaded.actions as JsonObject[]).length, 2); assert.equal((loaded.work_items as JsonObject[]).find((item) => item.item_key === "inspect")?.status, "verified");
    const deliver = (loaded.work_items as JsonObject[]).find((item) => item.item_key === "deliver")!; f.store.save("durable_work_item", String(deliver.id), { ...deliver, status: "verified" });
    assert.equal((f.service.durableActionLoopNext({ action_loop_id: "actions" }).loop as JsonObject).lifecycle, "completed");
    const trace = f.service.traceGet({ trace_id: "durable_action_loop:actions" }); assert.equal((trace.trace as JsonObject).status, "completed"); assert.deepEqual((trace.events as JsonObject[]).map((event) => event.event_kind), ["durable.loop.created", "durable.action.proposed", "durable.action.dispatched", "durable.action.observed", "durable.action.proposed", "durable.action.observed", "durable.loop.completed", "trace.finalized"]);
  } finally { await close(f); }
});

test("Durable Action Loop detects drift on resume and rejects missing receipt or cross-workspace state", async () => {
  const f = await fixture();
  try {
    f.service.durableActionLoopCreate({ action_loop_id: "actions", work_loop_id: "loop", work_items: [{ id: "one", acceptance_digest: "one" }] });
    const action = f.service.durableActionLoopPropose({ action_loop_id: "actions", item_key: "one", kind: "execute", action_digest: "execute" }).action as JsonObject;
    f.store.create("state_snapshot", "other", { workspace_id: "other", snapshot_digest: "other", workspace_state_revision: 1 });
    assert.throws(() => f.service.durableActionLoopReport({ action_id: action.id, outcome: "succeeded", snapshot_id: "before" }), /Receipt/);
    assert.throws(() => f.service.durableActionLoopReport({ action_id: action.id, outcome: "succeeded", snapshot_id: "other", receipt_ref: { kind: "verified_work_loop_receipt", id: "receipt", version: 1 } }), /another Workspace/);
    assert.equal(f.service.durableActionLoopResume({ action_loop_id: "actions", snapshot_id: "before" }).resumed, true);
    f.store.create("state_snapshot", "drift", { workspace_id: "workspace", snapshot_digest: "drift", workspace_state_revision: 2 });
    const resumed = f.service.durableActionLoopResume({ action_loop_id: "actions", snapshot_id: "drift" }); assert.equal(resumed.resumed, false); assert.equal((resumed.loop as JsonObject).lifecycle, "needs_replan");
    assert.equal(f.service.durableActionLoopNext({ action_loop_id: "actions" }).next_action, "replan");
  } finally { await close(f); }
});

test("Experience Ledger keeps execution observations, diagnostic patterns, rejected alternatives, and exact Signoff separate from active assets", async () => {
  const f = await fixture();
  try {
    f.store.create("outcome", "outcome", { verdict: "failed" }); f.store.create("acceptance_gate", "gate", { verdict: "failed" });
    const first = f.service.experienceLedgerObserve({ observation_id: "one", source_ref: { kind: "outcome", id: "outcome", version: 1 }, kind: "failure", scenario_key: "coding", finding: "verification was missing", evidence_ids: ["confirmed"] }).observation as JsonObject;
    const second = f.service.experienceLedgerObserve({ observation_id: "two", source_ref: { kind: "acceptance_gate", id: "gate", version: 1 }, kind: "correction", scenario_key: "coding", finding: "add acceptance", evidence_ids: ["confirmed"] }).observation as JsonObject;
    assert.equal(f.service.experienceLedgerObserve({ observation_id: "one", source_ref: { kind: "outcome", id: "outcome", version: 1 }, kind: "failure", scenario_key: "coding", finding: "verification was missing", evidence_ids: ["confirmed"] }).idempotent, true);
    assert.throws(() => f.service.experienceLedgerObserve({ source_ref: { kind: "outcome", id: "outcome", version: 1 }, kind: "failure", scenario_key: "coding", finding: "x", evidence_ids: ["unverified"] }), /confirmed or bounded/);
    const pattern = f.service.experienceLedgerCompile({ pattern_id: "pattern", scenario_key: "coding", observation_ids: [first.id, second.id], kind: "failure_pattern", hypothesis: "verify real state", applicability: "workspace changes", counterexample: "read-only answer" }).pattern as JsonObject;
    assert.equal(pattern.execution_visible, false); assert.throws(() => f.service.experienceLedgerCompile({ scenario_key: "coding", observation_ids: [first.id, first.id], kind: "failure_pattern", hypothesis: "x", applicability: "x", counterexample: "x" }), /unique/);
    const intervention = f.service.experienceLedgerPropose({ intervention_id: "proposal", pattern_ids: [pattern.id], subject_ref: { kind: "workflow", id: "workflow", version: 1 }, design_axes: ["orchestration"], diff_summary: "add verification", hypothesis: "raises outcome quality" }).intervention as JsonObject;
    assert.equal(intervention.publication_allowed, false); const rejected = f.service.experienceLedgerEvaluate({ intervention_id: intervention.id, assessment_id: "rejected", retry_condition: "new held-out failures" }).intervention as JsonObject;
    assert.equal(rejected.lifecycle, "rejected"); assert.equal((f.service.experienceLedgerDecide({ intervention_id: rejected.id, decision: "reject", reason: "regressed", retry_condition: "new evidence" }).intervention as JsonObject).lifecycle, "rejected");
    const secondIntervention = f.service.experienceLedgerPropose({ intervention_id: "proposal-two", pattern_ids: [pattern.id], subject_ref: { kind: "workflow", id: "workflow", version: 1 }, design_axes: ["orchestration"], diff_summary: "independent evaluator", hypothesis: "raises outcome quality" }).intervention as JsonObject;
    const ready = f.service.experienceLedgerEvaluate({ intervention_id: secondIntervention.id, assessment_id: "eligible" }).intervention as JsonObject; f.store.create("signoff", "signoff", { decision: "passed", subject_type: "experience_intervention", subject_id: ready.id, subject_version: ready.version });
    const accepted = f.service.experienceLedgerDecide({ intervention_id: ready.id, decision: "accept", signoff_id: "signoff", reason: "held-out eligible" }); assert.equal(accepted.active_asset_changed, false); assert.equal((accepted.intervention as JsonObject).lifecycle, "accepted");
    assert.equal(((f.service.experienceLedgerGet({ intervention_id: ready.id }).patterns as JsonObject[])[0]).id, pattern.id);
  } finally { await close(f); }
});

test("The bounded durable and experience surfaces are independently callable over MCP", async () => {
  const f = await fixture();
  try {
    const server = new McpServer(f.service, "full"); assert.ok(server.tools.some((tool) => tool.name === "craft_durable_action_loop_create")); assert.ok(server.tools.some((tool) => tool.name === "craft_experience_ledger_observe"));
    const response = await server.handle({ id: "create", method: "tools/call", params: { name: "craft_durable_action_loop_create", arguments: { action_loop_id: "mcp", work_loop_id: "loop", work_items: [{ id: "one", acceptance_digest: "one" }] } } }); assert.equal((response?.result as JsonObject).isError, false);
  } finally { await close(f); }
});

test("Durable Action Loop covers defensive and non-executing paths", async () => {
  const f = await fixture();
  try {
    const kernel = new DurableActionLoopKernel(f.store);
    assert.throws(() => kernel.create({ work_loop_id: "loop", work_items: [] }), /at least one/);
    assert.throws(() => kernel.create({ work_loop_id: "loop", work_items: [{ id: "a", depends_on: ["b"], acceptance_digest: "a" }, { id: "b", depends_on: ["a"], acceptance_digest: "b" }] }), /cycle/);
    const loop = kernel.create({ work_loop_id: "loop", work_items: [{ id: "one", acceptance_digest: "one" }] }).loop as JsonObject;
    assert.match(String(loop.id), /^durable_action_loop_/); assert.throws(() => kernel.propose({ action_loop_id: loop.id, item_key: "missing", kind: "observe", action_digest: "x" }), /not ready/);
    assert.throws(() => kernel.propose({ action_loop_id: loop.id, item_key: "one", kind: "bad", action_digest: "x" }), /unsupported/);
    assert.throws(() => kernel.propose({ action_loop_id: loop.id, item_key: "one", kind: "observe", effect: "local_write", action_digest: "x" }), /effect/);
    const observe = kernel.propose({ action_loop_id: loop.id, item_key: "one", kind: "observe", action_digest: "observe" }).action as JsonObject;
    assert.equal(kernel.propose({ action_id: observe.id, action_loop_id: loop.id, item_key: "one", kind: "observe", action_digest: "observe" }).idempotent, true);
    assert.throws(() => kernel.report({ action_id: observe.id, outcome: "bad", snapshot_id: "before" }), /unsupported/);
    assert.equal((kernel.report({ action_id: observe.id, outcome: "waiting", snapshot_id: "before" }).action as JsonObject).lifecycle, "observed"); assert.throws(() => kernel.dispatch({ action_id: observe.id, dispatch_ref: "late" }), /proposed/);
    const execute = kernel.propose({ action_loop_id: loop.id, item_key: "one", kind: "execute", effect: "local_write", action_digest: "execute" }).action as JsonObject;
    assert.throws(() => kernel.report({ action_id: execute.id, outcome: "succeeded", snapshot_id: "before", receipt_ref: { kind: "other", id: "receipt", version: 1 } }), /unsupported/);
    const drift = kernel.report({ action_id: execute.id, outcome: "failed", snapshot_id: "before", receipt_ref: { kind: "verified_work_loop_receipt", id: "receipt", version: 1 }, input_drift: true, replan_reason: "new input" });
    assert.equal((drift.loop as JsonObject).lifecycle, "needs_replan"); assert.equal(kernel.resume({ action_loop_id: loop.id, snapshot_id: "before" }).resumed, false);
  } finally { await close(f); }
});

test("Durable Action Loop rejects malformed inputs and records blocked or failed verification without claiming progress", async () => {
  const f = await fixture();
  try {
    const kernel = new DurableActionLoopKernel(f.store);
    assert.throws(() => kernel.create({ work_loop_id: "loop", work_items: "bad" as unknown as JsonObject[] }), /at least one/);
    assert.throws(() => kernel.create({ work_loop_id: "loop", work_items: [[] as unknown as JsonObject] }), /must be an object/);
    assert.throws(() => kernel.create({ work_loop_id: "loop", work_items: [{ id: "", acceptance_digest: "x" }] }), /must not be empty/);
    assert.throws(() => kernel.create({ work_loop_id: "loop", work_items: [{ id: "one", depends_on: "bad", acceptance_digest: "x" }] }), /must be an array/);
    assert.throws(() => kernel.create({ work_loop_id: "loop", work_items: [{ id: "one", depends_on: ["one"], acceptance_digest: "x" }] }), /cannot reference itself/);
    assert.throws(() => kernel.create({ work_loop_id: "loop", work_items: [{ id: "one", acceptance_digest: "x" }, { id: "one", acceptance_digest: "y" }] }), /unique declared/);
    const conflict = kernel.create({ action_loop_id: "conflict", work_loop_id: "loop", work_items: [{ id: "one", acceptance_digest: "x" }] });
    assert.equal(kernel.create({ action_loop_id: "conflict", work_loop_id: "loop", work_items: [{ id: "one", acceptance_digest: "x" }] }).idempotent, true);
    assert.throws(() => kernel.create({ action_loop_id: "conflict", work_loop_id: "loop", work_items: [{ id: "one", acceptance_digest: "changed" }] }), /conflict/);
    assert.ok(conflict.loop);

    const blockedLoop = kernel.create({ action_loop_id: "blocked", work_loop_id: "loop", work_items: [{ id: "one", acceptance_digest: "x" }] }).loop as JsonObject;
    const blocked = kernel.propose({ action_loop_id: blockedLoop.id, item_key: "one", kind: "observe", action_digest: "observe" }).action as JsonObject;
    assert.throws(() => kernel.propose({ action_id: blocked.id, action_loop_id: blockedLoop.id, item_key: "one", kind: "observe", action_digest: "changed" }), /conflict/);
    const blockedReport = kernel.report({ action_id: blocked.id, outcome: "blocked", snapshot_id: "before" });
    assert.equal((blockedReport.action as JsonObject).lifecycle, "blocked"); assert.equal(blockedReport.next_action, "resolve_blocker");

    const verifyLoop = kernel.create({ action_loop_id: "verify-fail", work_loop_id: "loop", work_items: [{ id: "one", acceptance_digest: "x" }] }).loop as JsonObject;
    const failedVerify = kernel.propose({ action_loop_id: verifyLoop.id, item_key: "one", kind: "verify", action_digest: "verify-fail" }).action as JsonObject;
    assert.equal((kernel.report({ action_id: failedVerify.id, outcome: "failed", snapshot_id: "before", receipt_ref: { kind: "verified_work_loop_receipt", id: "receipt", version: 1 } }).action as JsonObject).progress_proved, false);

    const gateLoop = kernel.create({ action_loop_id: "verify-gate", work_loop_id: "loop", work_items: [{ id: "one", acceptance_digest: "x" }] }).loop as JsonObject;
    const gated = kernel.propose({ action_loop_id: gateLoop.id, item_key: "one", kind: "verify", action_digest: "verify-gate" }).action as JsonObject;
    assert.throws(() => kernel.report({ action_id: gated.id, outcome: "succeeded", snapshot_id: "before", receipt_ref: { kind: "verified_work_loop_receipt", id: "receipt", version: 1 }, acceptance_ref: { kind: "verified_work_loop_receipt", id: "receipt", version: 1 } }), /Acceptance Gate/);
    f.store.create("acceptance_gate", "failed-gate", { verdict: "failed" });
    assert.throws(() => kernel.report({ action_id: gated.id, outcome: "succeeded", snapshot_id: "before", receipt_ref: { kind: "verified_work_loop_receipt", id: "receipt", version: 1 }, acceptance_ref: { kind: "acceptance_gate", id: "failed-gate", version: 1 } }), /passed Acceptance Gate/);
    f.store.create("acceptance_gate", "passed-gate", { verdict: "passed" });
    assert.equal((kernel.report({ action_id: gated.id, outcome: "succeeded", snapshot_id: "before", receipt_ref: { kind: "verified_work_loop_receipt", id: "receipt", version: 1 }, acceptance_ref: { kind: "acceptance_gate", id: "passed-gate", version: 1 } }).action as JsonObject).progress_proved, true);

    const resumeLoop = kernel.create({ action_loop_id: "resume-scope", work_loop_id: "loop", work_items: [{ id: "one", acceptance_digest: "x" }] }).loop as JsonObject;
    f.store.create("state_snapshot", "other-resume", { workspace_id: "other", snapshot_digest: "other", workspace_state_revision: 1 });
    assert.throws(() => kernel.resume({ action_loop_id: resumeLoop.id, snapshot_id: "other-resume" }), /another Workspace/);

    const secretLoop = kernel.create({ action_loop_id: "secret-input", work_loop_id: "loop", work_items: [{ id: "one", acceptance_digest: "x" }] }).loop as JsonObject;
    assert.throws(() => kernel.propose({ action_loop_id: secretLoop.id, item_key: "one", kind: "observe", action_digest: "token=abcdefgh" }), /credentials/);
    const driftAction = kernel.propose({ action_loop_id: secretLoop.id, item_key: "one", kind: "execute", action_digest: "execute" }).action as JsonObject;
    assert.throws(() => kernel.report({ action_id: driftAction.id, outcome: "succeeded", snapshot_id: "before", receipt_ref: { kind: "verified_work_loop_receipt", id: "receipt", version: 0 } }), /positive integer/);
    assert.equal((kernel.report({ action_id: driftAction.id, outcome: "failed", snapshot_id: "before", receipt_ref: { kind: "verified_work_loop_receipt", id: "receipt", version: 1 }, input_drift: true }).loop as JsonObject).needs_replan_reason, "input_drift");
    assert.equal(kernel.next({ action_loop_id: secretLoop.id }).next_action, "replan");
    const replanWithPending = kernel.create({ action_loop_id: "replan-pending", work_loop_id: "loop", work_items: [{ id: "one", acceptance_digest: "x" }] }).loop as JsonObject;
    const pending = kernel.propose({ action_loop_id: replanWithPending.id, item_key: "one", kind: "observe", action_digest: "pending" }).action as JsonObject;
    f.store.save("durable_action_loop", String(replanWithPending.id), { ...replanWithPending, lifecycle: "needs_replan" });
    assert.equal((kernel.next({ action_loop_id: replanWithPending.id }).pending_action as JsonObject).id, pending.id);
    assert.throws(() => kernel.propose({ action_id: "new-pending", action_loop_id: replanWithPending.id, item_key: "one", kind: "observe", action_digest: "new" }), /not ready/);
    const completedLoop = kernel.create({ action_loop_id: "already-complete", work_loop_id: "loop", work_items: [{ id: "one", acceptance_digest: "x" }] }).loop as JsonObject;
    const completeItem = f.store.get("durable_work_item", `${completedLoop.id}:one`); f.store.save("durable_work_item", String(completeItem.id), { ...completeItem, status: "verified" });
    kernel.next({ action_loop_id: completedLoop.id }); assert.equal(kernel.next({ action_loop_id: completedLoop.id }).next_action, "none"); assert.equal(kernel.resume({ action_loop_id: completedLoop.id, snapshot_id: "before" }).next_action, "none");
  } finally { await close(f); }
});

test("Experience Ledger covers generated records and inconclusive maintenance outcomes", async () => {
  const f = await fixture();
  try {
    const kernel = new ExperienceLedgerKernel(f.store); f.store.create("outcome", "outcome-two", { verdict: "passed" }); f.store.create("acceptance_gate", "gate-two", { verdict: "passed" }); f.store.create("evaluation_reliability", "inconclusive", { status: "inconclusive" });
    assert.throws(() => kernel.observe({ source_ref: { kind: "other", id: "x", version: 1 }, kind: "success", scenario_key: "x", finding: "x", evidence_ids: ["confirmed"] }), /unsupported/);
    const first = kernel.observe({ source_ref: { kind: "outcome", id: "outcome-two", version: 1 }, kind: "success", scenario_key: "generated", finding: "works", evidence_ids: ["confirmed"] }).observation as JsonObject;
    const second = kernel.observe({ source_ref: { kind: "acceptance_gate", id: "gate-two", version: 1 }, kind: "correction", scenario_key: "generated", finding: "verified", evidence_ids: ["confirmed"] }).observation as JsonObject;
    const pattern = kernel.compile({ scenario_key: "generated", observation_ids: [first.id, second.id], kind: "success_strategy", hypothesis: "small change", applicability: "same contract", counterexample: "changed policy" }).pattern as JsonObject;
    assert.match(String(pattern.id), /^experience_pattern_/); assert.throws(() => kernel.propose({ pattern_ids: [pattern.id], subject_ref: { kind: "workflow", id: "workflow", version: 1 }, design_axes: ["context", "tools", "memory"], diff_summary: "x", hypothesis: "x" }), /two/);
    const proposal = kernel.propose({ pattern_ids: [pattern.id], subject_ref: { kind: "workflow", id: "workflow", version: 1 }, design_axes: ["context"], diff_summary: "x", hypothesis: "x" }).intervention as JsonObject;
    assert.throws(() => kernel.decide({ intervention_id: proposal.id, decision: "accept", signoff_id: "missing", reason: "x" }), /not ready/);
    assert.equal((kernel.evaluate({ intervention_id: proposal.id, assessment_id: "inconclusive" }).intervention as JsonObject).lifecycle, "inconclusive"); assert.throws(() => kernel.decide({ intervention_id: proposal.id, decision: "other", reason: "x" }), /unsupported/);
  } finally { await close(f); }
});

test("Experience Ledger rejects malformed, conflicting, uncalibrated, and stale evolution decisions", async () => {
  const f = await fixture();
  try {
    const kernel = new ExperienceLedgerKernel(f.store);
    f.store.create("outcome", "outcome-three", { verdict: "passed" }); f.store.create("outcome", "outcome-four", { verdict: "failed" }); f.store.create("acceptance_gate", "gate-three", { verdict: "passed" }); f.store.create("evidence", "bounded", { confidence: "bounded" }); f.store.create("evaluation_reliability", "unsupported", { status: "running" }); f.store.create("evaluation_reliability", "inconclusive", { status: "inconclusive" });
    assert.throws(() => kernel.observe({ source_ref: [] as unknown as JsonObject, kind: "success", scenario_key: "x", finding: "x", evidence_ids: ["confirmed"] }), /must be an object/);
    assert.throws(() => kernel.observe({ source_ref: { kind: "outcome", id: "outcome-three", version: 0 }, kind: "success", scenario_key: "x", finding: "x", evidence_ids: ["confirmed"] }), /positive integer/);
    assert.throws(() => kernel.observe({ source_ref: { kind: "outcome", id: "outcome-three", version: 1 }, kind: "bad", scenario_key: "x", finding: "x", evidence_ids: ["confirmed"] }), /kind is unsupported/);
    assert.throws(() => kernel.observe({ source_ref: { kind: "outcome", id: "outcome-three", version: 1 }, kind: "success", scenario_key: "", finding: "x", evidence_ids: ["confirmed"] }), /must not be empty/);
    assert.throws(() => kernel.observe({ source_ref: { kind: "outcome", id: "outcome-three", version: 1 }, kind: "success", scenario_key: "x", finding: "token=abcdefgh", evidence_ids: ["confirmed"] }), /credentials/);
    assert.throws(() => kernel.observe({ source_ref: { kind: "outcome", id: "outcome-three", version: 1 }, kind: "success", scenario_key: "x", finding: "x", evidence_ids: [] }), /at least 1/);
    assert.throws(() => kernel.observe({ source_ref: { kind: "outcome", id: "outcome-three", version: 1 }, kind: "success", scenario_key: "x", finding: "x", evidence_ids: ["confirmed", "confirmed"] }), /unique/);
    const first = kernel.observe({ observation_id: "collision", source_ref: { kind: "outcome", id: "outcome-three", version: 1 }, kind: "success", scenario_key: "strict", finding: "first", evidence_ids: ["confirmed", "bounded"] }).observation as JsonObject;
    assert.equal(kernel.observe({ observation_id: "collision", source_ref: { kind: "outcome", id: "outcome-three", version: 1 }, kind: "success", scenario_key: "strict", finding: "first", evidence_ids: ["confirmed", "bounded"] }).idempotent, true);
    assert.throws(() => kernel.observe({ observation_id: "collision", source_ref: { kind: "outcome", id: "outcome-three", version: 1 }, kind: "success", scenario_key: "strict", finding: "changed", evidence_ids: ["confirmed"] }), /conflict/);
    const sameSource = kernel.observe({ observation_id: "same-source", source_ref: { kind: "outcome", id: "outcome-three", version: 1 }, kind: "failure", scenario_key: "strict", finding: "second", evidence_ids: ["confirmed"] }).observation as JsonObject;
    assert.throws(() => kernel.compile({ scenario_key: "strict", observation_ids: [first.id, sameSource.id], kind: "success_strategy", hypothesis: "x", applicability: "x", counterexample: "x" }), /independent source/);
    const otherScenario = kernel.observe({ observation_id: "other-scenario", source_ref: { kind: "outcome", id: "outcome-four", version: 1 }, kind: "failure", scenario_key: "other", finding: "other", evidence_ids: ["confirmed"] }).observation as JsonObject;
    assert.throws(() => kernel.compile({ scenario_key: "strict", observation_ids: [first.id, otherScenario.id], kind: "success_strategy", hypothesis: "x", applicability: "x", counterexample: "x" }), /do not match/);
    const second = kernel.observe({ observation_id: "independent", source_ref: { kind: "acceptance_gate", id: "gate-three", version: 1 }, kind: "correction", scenario_key: "strict", finding: "verified", evidence_ids: ["confirmed"] }).observation as JsonObject;
    assert.throws(() => kernel.compile({ scenario_key: "strict", observation_ids: [first.id, second.id], kind: "bad", hypothesis: "x", applicability: "x", counterexample: "x" }), /kind is unsupported/);
    const pattern = kernel.compile({ pattern_id: "pattern-collision", scenario_key: "strict", observation_ids: [first.id, second.id], kind: "success_strategy", hypothesis: "x", applicability: "x", counterexample: "x" }).pattern as JsonObject;
    assert.equal(kernel.compile({ pattern_id: "pattern-collision", scenario_key: "strict", observation_ids: [first.id, second.id], kind: "success_strategy", hypothesis: "x", applicability: "x", counterexample: "x" }).idempotent, true);
    assert.throws(() => kernel.compile({ pattern_id: "pattern-collision", scenario_key: "strict", observation_ids: [first.id, second.id], kind: "success_strategy", hypothesis: "changed", applicability: "x", counterexample: "x" }), /conflict/);
    assert.throws(() => kernel.propose({ pattern_ids: [] as unknown as string[], subject_ref: { kind: "workflow", id: "workflow", version: 1 }, design_axes: ["context"], diff_summary: "x", hypothesis: "x" }), /at least 1/);
    assert.throws(() => kernel.propose({ pattern_ids: [pattern.id], subject_ref: { kind: "bad", id: "workflow", version: 1 }, design_axes: ["context"], diff_summary: "x", hypothesis: "x" }), /unsupported/);
    assert.throws(() => kernel.propose({ pattern_ids: [pattern.id], subject_ref: { kind: "workflow", id: "workflow", version: 1 }, design_axes: ["bad"], diff_summary: "x", hypothesis: "x" }), /two design axes/);
    const proposal = kernel.propose({ intervention_id: "proposal-collision", pattern_ids: [pattern.id], subject_ref: { kind: "workflow", id: "workflow", version: 1 }, design_axes: ["context"], diff_summary: "x", hypothesis: "x" }).intervention as JsonObject;
    assert.equal(kernel.propose({ intervention_id: "proposal-collision", pattern_ids: [pattern.id], subject_ref: { kind: "workflow", id: "workflow", version: 1 }, design_axes: ["context"], diff_summary: "x", hypothesis: "x" }).idempotent, true);
    assert.throws(() => kernel.propose({ intervention_id: "proposal-collision", pattern_ids: [pattern.id], subject_ref: { kind: "workflow", id: "workflow", version: 1 }, design_axes: ["tools"], diff_summary: "x", hypothesis: "x" }), /conflict/);
    assert.throws(() => kernel.evaluate({ intervention_id: proposal.id, assessment_id: "unsupported" }), /status is unsupported/);
    const signed = kernel.propose({ intervention_id: "signoff", pattern_ids: [pattern.id], subject_ref: { kind: "workflow", id: "workflow", version: 1 }, design_axes: ["tools"], diff_summary: "x", hypothesis: "x" }).intervention as JsonObject;
    kernel.evaluate({ intervention_id: signed.id, assessment_id: "eligible" });
    f.store.create("signoff", "wrong-decision", { decision: "failed", subject_type: "experience_intervention", subject_id: signed.id, subject_version: 2 });
    assert.throws(() => kernel.decide({ intervention_id: signed.id, decision: "accept", signoff_id: "wrong-decision", reason: "x" }), /exact passed/);
    f.store.create("signoff", "wrong-subject", { decision: "passed", subject_type: "workflow", subject_id: signed.id, subject_version: 2 });
    assert.throws(() => kernel.decide({ intervention_id: signed.id, decision: "accept", signoff_id: "wrong-subject", reason: "x" }), /exact passed/);
    f.store.create("signoff", "wrong-version", { decision: "passed", subject_type: "experience_intervention", subject_id: signed.id, subject_version: 999 });
    assert.throws(() => kernel.decide({ intervention_id: signed.id, decision: "accept", signoff_id: "wrong-version", reason: "x" }), /exact passed/);
    f.store.create("signoff", "exact", { decision: "passed", subject_type: "experience_intervention", subject_id: signed.id, subject_version: 2 });
    assert.equal((kernel.decide({ intervention_id: signed.id, decision: "accept", signoff_id: "exact", reason: "x" }).intervention as JsonObject).lifecycle, "accepted");
    assert.throws(() => kernel.decide({ intervention_id: signed.id, decision: "reject", reason: "x" }), /without rollback/);
    assert.equal((kernel.evaluate({ intervention_id: proposal.id, assessment_id: "inconclusive" }).intervention as JsonObject).lifecycle, "inconclusive"); assert.throws(() => kernel.evaluate({ intervention_id: proposal.id, assessment_id: "eligible" }), /Only a draft/);
  } finally { await close(f); }
});
