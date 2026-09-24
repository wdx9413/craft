import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { stableDigest } from "../core/digest.ts";
import { RuntimeExecutionAttemptKernel } from "../core/runtime-execution-attempt.ts";
import { ContextWorkingSetKernel } from "../core/context-working-set.ts";
import { ContextResolutionKernel } from "../core/context-resolution.ts";
import { GraphCompilerKernel } from "../core/graph-compiler.ts";
import { WorkflowDagKernel } from "../core/workflow-dag.ts";
import { CapabilityIntakeKernel } from "../core/capability-intake.ts";
import { WorkbenchCommandKernel } from "../core/workbench-command.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store };
}

test("v0.12.35 Runtime Execution Attempt is idempotent and never replays effect_unknown", async () => {
  const f = await fixture("craft-v01235-runtime-");
  try {
    const kernel = new RuntimeExecutionAttemptKernel(f.store);
    const input = { attempt_id: "attempt-1", task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "sha256:env", effect_class: "external_write", idempotency_key: "idem-1" } as JsonObject;
    const prepared = kernel.prepare(input); assert.equal((prepared.attempt as JsonObject).status, "prepared");
    assert.equal(kernel.prepare(input).idempotent, true);
    assert.throws(() => kernel.prepare({ ...input, attempt_id: "attempt-2" }), /already bound/);
    assert.throws(() => kernel.prepare({ ...input, environment_digest: "changed" }), /idempotency conflict/);
    assert.throws(() => kernel.prepare({ ...input, environment_digest: "authorization: secret" }), /credentials/);
    assert.throws(() => kernel.prepare({ ...input, attempt_id: "bad-effect", idempotency_key: "idem-effect", effect_class: "bad" }), /effect/);
    assert.throws(() => kernel.prepare({ ...input, attempt_id: "bad id", idempotency_key: "idem-bad-id" }), /letters/);
    const autoAttempt = kernel.prepare({ task_id: "task", work_loop_id: "loop", run_id: "run", host_id: "codex", environment_digest: "sha256:auto", idempotency_key: "idem-auto" }).attempt as JsonObject;
    assert.equal(autoAttempt.effect_class, "read_only");
    kernel.dispatch({ attempt_id: autoAttempt.id, dispatch_ref: "auto" });
    assert.equal((kernel.recordReceipt({ attempt_id: autoAttempt.id }).receipt as JsonObject).result_digest, "result");
    assert.equal((kernel.dispatch({ attempt_id: "attempt-1", dispatch_ref: "dispatch-1" }).attempt as JsonObject).status, "dispatched");
    assert.equal(kernel.dispatch({ attempt_id: "attempt-1", dispatch_ref: "dispatch-1" }).idempotent, true);
    assert.equal((kernel.receiptPending({ attempt_id: "attempt-1", receipt_id: "receipt-1" }).attempt as JsonObject).status, "receipt_pending");
    const recorded = kernel.recordReceipt({ attempt_id: "attempt-1", result_digest: "sha256:result" });
    assert.equal((recorded.attempt as JsonObject).status, "observing"); assert.equal((recorded.receipt as JsonObject).attempt_id, "attempt-1");
    assert.equal(kernel.recordReceipt({ attempt_id: "attempt-1", receipt_id: "receipt-1", result_digest: "sha256:result" }).idempotent, true);
    assert.equal((kernel.observe({ attempt_id: "attempt-1", observation_id: "obs-same", observed_status: "observed", evidence_digest: "sha256:obs" }).attempt as JsonObject).status, "observing");
    assert.equal((kernel.observe({ attempt_id: "attempt-1", observation_id: "obs-same", observed_status: "observed", evidence_digest: "sha256:obs" }).idempotent), true);
    const unknown = kernel.observe({ attempt_id: "attempt-1", observation_id: "obs-1", observed_status: "unknown", evidence_digest: "sha256:obs" });
    assert.equal((unknown.attempt as JsonObject).status, "effect_unknown");
    assert.equal(kernel.recover({ attempt_id: "attempt-1", reason: "worker restart" }).replay_allowed, false);
    assert.equal((kernel.resolveEffect({ attempt_id: "attempt-1", resolution: "still_unknown" }).attempt as JsonObject).status, "reconcile_required");
    assert.equal((kernel.resolveEffect({ attempt_id: "attempt-1", resolution: "confirmed_success", receipt_id: "receipt-1" }).attempt as JsonObject).status, "accepted");
    assert.equal(kernel.cancel({ attempt_id: "attempt-1", reason: "late" }).idempotent, true);
    assert.throws(() => kernel.get({}), /attempt_id/);

    const failed = kernel.prepare({ ...input, attempt_id: "attempt-failed", idempotency_key: "idem-failed" });
    kernel.dispatch({ attempt_id: "attempt-failed", dispatch_ref: "dispatch-failed" });
    const observation = kernel.observe({ attempt_id: "attempt-failed", observation_id: "obs-failed", observed_status: "failed", evidence_digest: "sha256:failed" });
    assert.equal((observation.attempt as JsonObject).status, "failed");
    assert.equal(kernel.resolveEffect({ attempt_id: "attempt-failed", resolution: "confirmed_failure" }).idempotent, false);
    assert.throws(() => kernel.resolveEffect({ attempt_id: "attempt-failed", resolution: "bad" }), /resolution/);
    assert.equal(kernel.cancel({ attempt_id: "attempt-failed", reason: "late" }).idempotent, true);
    const cancelled = kernel.prepare({ ...input, attempt_id: "attempt-cancelled", idempotency_key: "idem-cancelled" });
    assert.equal((kernel.cancel({ attempt_id: "attempt-cancelled", reason: "user" }).attempt as JsonObject).status, "cancelled");
    assert.throws(() => kernel.dispatch({ attempt_id: "attempt-cancelled", dispatch_ref: "late" }), /from cancelled/);
    assert.throws(() => kernel.recordReceipt({ attempt_id: "attempt-failed", receipt_id: "receipt-1", result_digest: "sha256:other" }), /conflict/);
    const invalidObserve = kernel.prepare({ ...input, attempt_id: "attempt-invalid-observe", idempotency_key: "idem-invalid-observe" });
    kernel.dispatch({ attempt_id: "attempt-invalid-observe", dispatch_ref: "invalid" });
    assert.throws(() => kernel.observe({ attempt_id: "attempt-invalid-observe", observation_id: "obs-invalid", observed_status: "not-a-status" }), /observed_status/);
    const mismatchObserve = kernel.prepare({ ...input, attempt_id: "attempt-mismatch-observe", idempotency_key: "idem-mismatch-observe" });
    kernel.dispatch({ attempt_id: "attempt-mismatch-observe", dispatch_ref: "mismatch" });
    kernel.observe({ attempt_id: "attempt-mismatch-observe", observation_id: "obs-mismatch", observed_status: "observed" });
    const mismatchOther = kernel.prepare({ ...input, attempt_id: "attempt-mismatch-other", idempotency_key: "idem-mismatch-other" });
    kernel.dispatch({ attempt_id: "attempt-mismatch-other", dispatch_ref: "other" });
    assert.throws(() => kernel.observe({ attempt_id: "attempt-mismatch-other", observation_id: "obs-mismatch", observed_status: "observed" }), /belong/);
    assert.throws(() => kernel.resolveEffect({ attempt_id: "attempt-failed", resolution: "confirmed_success", receipt_id: "receipt-1" }), /belong/);
    const pending = kernel.prepare({ ...input, attempt_id: "attempt-pending", idempotency_key: "idem-pending" });
    kernel.dispatch({ attempt_id: "attempt-pending", dispatch_ref: "dispatch-pending" });
    kernel.receiptPending({ attempt_id: "attempt-pending" });
    assert.equal(kernel.recover({ attempt_id: "attempt-pending", reason: "timeout" }).replay_allowed, false);
    const defaults = kernel.prepare({ ...input, attempt_id: "attempt-defaults", idempotency_key: "idem-defaults" });
    kernel.dispatch({ attempt_id: "attempt-defaults" });
    assert.equal((kernel.observe({ attempt_id: "attempt-defaults", observation_id: "obs-defaults", evidence_digest: "sha256:e" }).attempt as JsonObject).status, "observing");
    assert.equal(kernel.recover({ attempt_id: "attempt-defaults" }).replay_allowed, false);
    assert.equal((kernel.cancel({ attempt_id: "attempt-defaults" }).attempt as JsonObject).status, "cancelled");
    assert.equal(defaults.attempt !== undefined, true);
    f.store.create("runtime_execution_attempt", "malformed", { status: "bad" });
    assert.throws(() => kernel.dispatch({ attempt_id: "malformed", dispatch_ref: "bad" }), /Unsupported runtime attempt status/);
    assert.equal((failed.attempt as JsonObject).id, "attempt-failed"); assert.equal((cancelled.attempt as JsonObject).id, "attempt-cancelled");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.35 Context Working Set explains selection and keeps host members fixed", async () => {
  const f = await fixture("craft-v01235-context-");
  try {
    const resolver = new ContextResolutionKernel(f.store);
    const kernel = new ContextWorkingSetKernel(f.store, resolver);
    const hostOnly = await kernel.resolve({ working_set_id: "host-only", query: "current", members: ["history", "state"] });
    assert.equal(hostOnly.skipped, undefined); assert.deepEqual(hostOnly.selected_refs, []);
    const source = f.store.create("knowledge_source", "source", { status: "active", trust: "trusted" });
    f.store.create("memory_ledger", "memory", { status: "active", source_id: source.id, scope: { kind: "project", id: "p" }, valid_until: null, sensitivity: "internal", content: "focused tests", content_digest: "sha256:memory" });
    const selected = await kernel.resolve({ working_set_id: "selected", query: "focused tests", members: ["knowledge", "memory", "history"], scope_kind: "project", scope_id: "p" });
    assert.equal((selected.selected_refs as string[]).length, 1); assert.equal((selected.selection_reasons as JsonObject[])[0]!.reason, "scoped_retrieval");
    assert.equal(kernel.get({ working_set_id: "selected" }).working_set !== undefined, true);
    assert.equal((await kernel.resolve({ working_set_id: "selected", query: "focused tests", members: ["knowledge", "memory", "history"], scope_kind: "project", scope_id: "p" })).idempotent, true);
    const required = await kernel.resolve({ working_set_id: "required", query: "focused", members: ["memory"], scope_kind: "project", scope_id: "p", required_refs: ["source"] });
    assert.equal((required.selected_refs as string[]).length, 1);
    await assert.rejects(() => kernel.resolve({ working_set_id: "selected", query: "changed", members: ["memory"], scope_kind: "project", scope_id: "p" }), /idempotency conflict/);
    assert.throws(() => kernel.get({ working_set_id: "missing" }), /context_working_set_receipt/);
    const defaults = await kernel.resolve({ query: "none" });
    assert.ok((defaults.working_set as JsonObject).id);
    assert.ok((await kernel.get({ working_set_id: String((defaults.working_set as JsonObject).id), version: 1 })).working_set);
    await assert.rejects(() => kernel.resolve({ query: "x", members: [] }), /non-empty/);
    await assert.rejects(() => kernel.resolve({ query: "x", members: ["unsupported"] }), /unsupported/);
    const contributingResolver = new ContextResolutionKernel(f.store, [{ member: "experience", contribute: async () => ({ member: "experience", items: [{ ref_id: "exp" }], receipt_id: "exp-receipt", omitted_count: 1 }) }]);
    const contributingKernel = new ContextWorkingSetKernel(f.store, contributingResolver);
    const contributed = await contributingKernel.resolve({ working_set_id: "contributed", query: "focused", members: ["experience"], scope_kind: "project", scope_id: "p" });
    assert.equal((contributed.selected_refs as string[]).includes("exp@latest"), true);
    const fakeKernel = new ContextWorkingSetKernel(f.store, { resolve: async () => ({ items: [{ memory_id: "memory-only" }], contributions: [{ items: [{ memory_id: "memory-ref" }, { id: "id-ref" }, { ref_id: "full", version: 2 }] }, { items: "not-an-array" }], receipt: {} }) } as never);
    const fake = await fakeKernel.resolve({ working_set_id: "fake", query: "fake", members: ["memory"], scope_kind: "project", scope_id: "p" });
    assert.equal((fake.selected_refs as string[]).length, 4);
    const emptyFake = new ContextWorkingSetKernel(f.store, { resolve: async () => ({}) } as never);
    assert.deepEqual((await emptyFake.resolve({ working_set_id: "empty-fake", query: "fake", members: ["memory"], scope_kind: "project", scope_id: "p" })).selected_refs, []);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.35 Graph compiler lowers only to a VerifiedWorkLoop plan", async () => {
  const f = await fixture("craft-v01235-graph-");
  try {
    const compiler = new GraphCompilerKernel(new WorkflowDagKernel(f.store));
    const args = { plan_id: "plan", nodes: [
      { id: "a", type: "action", side_effect: "read_only", title: "Read", objective: "read" },
      { id: "r", type: "retry", side_effect: "local_write", max_attempts: 2, depends_on: ["a"] },
      { id: "c", type: "compensation", side_effect: "read_only", depends_on: ["r"] },
      { id: "h", type: "human_gate", side_effect: "read_only", depends_on: ["c"] },
      { id: "action", type: "action", side_effect: "read_only", action: "do", depends_on: ["h"] },
    ], edges: [
      { id: "retry", from: "r", to: "a", kind: "retry", max_attempts: 2 },
      { id: "comp", from: "r", to: "c", kind: "compensation", compensation_ref: "c" },
      { id: "human", from: "c", to: "h", kind: "human_resume", approval_ref: "approval" },
    ] } as JsonObject;
    const result = compiler.compile(args); const plan = result.plan as JsonObject;
    assert.equal(plan.executable_by, "verified_work_loop"); assert.equal(plan.automation_authority, false);
    assert.deepEqual(plan.analysis, { node_count: 5, edge_count: 3, retry_count: 2, compensation_count: 2, human_gate_count: 2, effects: ["local_write", "read_only"], cycle_policy: "bounded_only" });
    assert.equal(String((compiler.compile({ ...args, plan_id: undefined }).plan as JsonObject).plan_id).startsWith("plan_"), true);
    assert.throws(() => compiler.compile({ nodes: [{ id: "a", type: "action", depends_on: ["b"] }, { id: "b", type: "action", depends_on: ["a"] }] }), /cycle/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.35 Capability Intake is discovered, scanned, conformance-gated and revocable", async () => {
  const f = await fixture("craft-v01235-capability-");
  try {
    const kernel = new CapabilityIntakeKernel(f.store);
    const base = { capability_id: "kit", name: "Kit", source: "github:kit", publisher: "author", version: "1.0.0", content_digest: "sha256:kit", effect: "read_only", dependencies: ["node"], permissions: ["read"], hosts: ["codex"] } as JsonObject;
    assert.equal((kernel.discover(base).capability as JsonObject).state, "discovered"); assert.equal(kernel.discover(base).idempotent, true);
    const scanned = kernel.scan({ capability_id: "kit", evidence: { files: ["SKILL.md"] } }); assert.equal((scanned.scan as JsonObject).verdict, "passed");
    assert.equal((kernel.conformance({ capability_id: "kit", checks: [true, true] }).conformance as JsonObject).verdict, "passed");
    assert.equal((kernel.approve({ capability_id: "kit", approved_by: "user" }).capability as JsonObject).state, "approved");
    assert.equal((kernel.activate({ capability_id: "kit" }).capability as JsonObject).state, "active"); assert.equal(kernel.activate({ capability_id: "kit" }).idempotent, true);
    assert.equal((kernel.upgradePlan({ capability_id: "kit", next_version: "2.0.0", next_digest: "sha256:new" }).plan as JsonObject).status, "planned");
    assert.equal((kernel.revoke({ capability_id: "kit", reason: "withdrawn" }).capability as JsonObject).state, "revoked"); assert.equal(kernel.revoke({ capability_id: "kit", reason: "again" }).idempotent, true);
    const bad = kernel.discover({ ...base, capability_id: "bad", name: "Bad", content_digest: "sha256:bad" });
    assert.equal((kernel.scan({ capability_id: "bad", evidence: "token: secret" }).scan as JsonObject).verdict, "rejected");
    assert.equal((kernel.conformance({ capability_id: "bad", checks: [true, false] }).conformance as JsonObject).verdict, "rejected");
    assert.throws(() => kernel.approve({ capability_id: "bad", approved_by: "user" }), /passed conformance/);
    f.store.save("capability_intake", "bad", { ...(f.store.get("capability_intake", "bad")), state: "degraded" });
    assert.equal((kernel.activate({ capability_id: "bad" }).capability as JsonObject).state, "active");
    f.store.save("capability_intake", "bad", { ...(f.store.get("capability_intake", "bad")), state: "retired" });
    assert.throws(() => kernel.activate({ capability_id: "bad" }), /approved/);
    assert.equal((kernel.list({ state: "revoked" }).capabilities as JsonObject[]).length, 1); assert.equal(kernel.get({ capability_id: String((bad.capability as JsonObject).id) }).id, "bad");
    assert.equal((kernel.list().capabilities as JsonObject[]).length, 2);
    assert.equal(String((kernel.discover({ name: "Auto", source: "local", content_digest: "sha256:auto" }).capability as JsonObject).id).startsWith("capability_intake_"), true);
    assert.throws(() => kernel.list({ state: "unknown" }), /Unsupported/);
    assert.throws(() => kernel.discover({ ...base, capability_id: "kit", version: "9.0.0" }), /identity conflict/);
    f.store.save("capability_intake", "auto-scan", { name: "Auto", source: "token: secret", publisher: "x", version: "1", content_digest: "sha256:x", effect: "read_only", dependencies: [], permissions: [], hosts: [], manifest_digest: "x", state: "discovered" });
    assert.equal((kernel.scan({ capability_id: "auto-scan" }).scan as JsonObject).verdict, "rejected");
    kernel.discover({ capability_id: "empty", name: "Empty", source: "local", content_digest: "sha256:empty" });
    kernel.scan({ capability_id: "empty" });
    assert.throws(() => kernel.conformance({ capability_id: "empty" }), /at least one/);
    assert.throws(() => kernel.discover({ ...base, capability_id: "bad-effect", effect: "bad" }), /effect/);
    assert.throws(() => kernel.conformance({ capability_id: "kit", checks: [] }), /scanned/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.35 Workbench commands are versioned and MCP-exposed", async () => {
  const f = await fixture("craft-v01235-workbench-");
  try {
    const kernel = new WorkbenchCommandKernel(f.store, async (command) => ({ applied_command: command.command, accepted: true }));
    const args = { command_id: "cmd", task_id: "task", command: "approve", actor: "user", decision: "yes", expected_version: 1, reason_digest: "sha256:reason" } as JsonObject;
    assert.equal((await kernel.execute(args)).idempotent, false); assert.equal((await kernel.execute(args)).idempotent, true);
    await assert.rejects(() => kernel.execute({ ...args, command_id: "cmd", decision: "no" }), /idempotency conflict/);
    assert.equal((await kernel.execute({ ...args, command_id: "cmd-2", command: "pause", expected_version: 2 })).idempotent, false);
    await assert.rejects(() => kernel.execute({ ...args, command_id: "cmd-3", expected_version: 2 }), /version conflict/);
    await assert.rejects(() => kernel.execute({ ...args, command_id: "cmd-version", expected_version: 0 }), /expected_version/);
    await assert.rejects(() => kernel.execute({ ...args, command_id: "cmd-bad", command: "nope" }), /Unsupported/);
    assert.equal((kernel.list({ task_id: "task" }).commands as JsonObject[]).length, 2); assert.equal((kernel.list().commands as JsonObject[]).length, 2); assert.equal(kernel.get({ command_id: "cmd" }).command !== undefined, true);
    const noDispatch = new WorkbenchCommandKernel(f.store);
    const generated = await noDispatch.execute({ task_id: "generated", command: "approve", actor: "user", decision: "yes", expected_version: 1, reason_digest: "sha256:reason" });
    assert.match(String((generated.command as JsonObject).id), /^command_/u);
    const existingTarget = { task_id: "pre", command: "approve", actor: "user", decision: "yes", expected_version: 1, reason_digest: "sha256:reason" };
    f.store.create("workbench_command", "preexisting", { ...existingTarget, command_digest: stableDigest(existingTarget), status: "prepared", result: null });
    assert.equal((await kernel.execute({ ...existingTarget, command_id: "preexisting" })).idempotent, true);
    const failing = new WorkbenchCommandKernel(f.store, () => { throw new Error("blocked"); });
    await assert.rejects(() => failing.execute({ ...args, command_id: "cmd-fail", task_id: "task-fail" }), /dispatch failed/);
    const service = new CraftService(f.store); const mcp = new McpServer(service, "full");
    assert.ok(mcp.tools.some((tool) => tool.name === "craft_runtime_attempt_prepare")); assert.ok(mcp.tools.some((tool) => tool.name === "craft_graph_compile"));
    const response = await mcp.handle({ id: 1, method: "tools/call", params: { name: "craft_graph_compile", arguments: { nodes: [{ id: "a", type: "action", side_effect: "read_only" }] } } });
    assert.equal(((response!.result as JsonObject).isError), false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
