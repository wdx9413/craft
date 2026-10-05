import assert from "node:assert/strict";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { payload, stableDigest } from "../core/digest.ts";
import { validateProcedureComposition } from "../capability/craft-experience/procedure-composition.ts";

import { fixture, spec, scope } from "./helpers/procedure-invocation-fixture.ts";
function parent(child: JsonObject): JsonObject {
  return { ...spec(["approved"]), steps: [
    { id: "implement", type: "instruction", side_effect: "local_write", requires: ["diff"], provides: ["new_diff"], instruction: "Implement" },
    { id: "review", type: "procedure_call", side_effect: "read_only", requires: ["new_diff"], provides: ["report", "alias"], procedure_id: child.id, procedure_version: child.version, definition_digest: child.definition_digest,
      entry_id: "review", exit_id: "reviewed", input_bindings: { diff: "new_diff" }, output_bindings: { report: "report", alias: "report" } },
  ], composition: { ...(spec(["approved"]).composition as JsonObject), entries: [{ id: "review", title: "Full", required_inputs: ["diff"], preconditions: ["approved"], routes: [{ exit_id: "reviewed", step_ids: ["implement", "review"] }] }] } };
}

test("nested invocation uses public seams, defers child evidence, accepts aliases only after child exit and survives restart", async () => {
  const f = await fixture();
  try {
    const child = f.create(spec(["approved"])), p = f.create(parent(child));
    const args = f.args(p);
    const mcp = new McpServer(f.service, "component-experience-daily");
    const bound = await mcp.handlers.craft_procedure_invocation_bind(args);
    assert.equal(bound.host_execution_authority, false);
    assert.equal((bound.invocation as JsonObject).version, 1);
    assert.equal(f.service.procedureInvocationBind(args).idempotent, true);
    assert.throws(() => f.service.procedureInvocationBind({ ...args, ttl_ms: 30_000 }), /idempotency/);
    assert.throws(() => f.dispatch(), /precondition Evidence/);
    const pre = f.precondition("invoke", "root", { diff: "artifact:diff" });
    const prepared = f.dispatch("invoke", { precondition_evidence: { root: { approved: pre } } });
    const report = f.proof(prepared);
    await f.reopen();
    assert.equal(f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "before" }).recovery_action, "reconcile_dispatch");
    assert.equal(f.dispatch().next_action, "await_receipt");
    const result = f.service.procedureInvocationReport(report);
    assert.equal((result.receipt as JsonObject).status, "passed");
    assert.equal(f.service.procedureInvocationReport(report).idempotent, true);
    assert.throws(() => f.service.procedureInvocationReport({ ...report, output_refs: {} }), /idempotency/);
    assert.throws(() => f.dispatch("invoke", { precondition_evidence: { "root/review": { approved: pre } } }), /another invocation/);
    const childPre = f.precondition("invoke", "root/review", { diff: (report.output_refs as JsonObject).new_diff });
    const childStep = f.dispatch("invoke", { precondition_evidence: { "root/review": { approved: childPre } } });
    f.service.procedureInvocationReport(f.proof(childStep));
    assert.equal(Object.hasOwn(f.store.get("procedure_invocation", "invoke").artifacts as object, "root:output:report"), false);
    const childExit = f.dispatch();
    const exitProof = f.proof(childExit);
    assert.throws(() => f.service.procedureInvocationReport({ ...exitProof, output_refs: { report: "artifact:other" } }), /replace/);
    f.service.procedureInvocationReport(exitProof);
    const artifacts = f.store.get("procedure_invocation", "invoke").artifacts as JsonObject;
    assert.equal(artifacts["root:output:report"], artifacts["root:output:alias"]);
    f.service.procedureInvocationReport(f.proof(f.dispatch()));
    const done = await new McpServer(f.service, "component-experience-daily").handlers.craft_procedure_invocation_get({ invocation_id: "invoke", scope });
    assert.equal((done.invocation as JsonObject).lifecycle, "completed");
    assert.equal((done.loop as JsonObject).lifecycle, "completed");
    assert.equal((done.outcomes as JsonObject[]).length, 2);
  } finally { await f.close(); }
});

test("failed child verification blocks parent; pending dispatch remains reconcilable without double dispatch", async () => {
  const f = await fixture();
  try {
    const p = f.create(); f.service.procedureInvocationBind(f.args(p));
    const dispatch = f.dispatch(), report = f.proof(dispatch, "failed");
    assert.equal(f.service.procedureInvocationReport(report).idempotent, false);
    assert.equal(f.store.get("procedure_invocation", "invoke").lifecycle, "failed");
    assert.equal(f.service.procedureInvocationReport(report).idempotent, true);
    assert.throws(() => f.service.procedureInvocationDispatch({ ...f.params(), snapshot_id: "before", item_key: "root/$exit" }), /terminal/);
    assert.equal((f.service.procedureInvocationGet(f.params()).outcomes as JsonObject[])[0]!.failure_stage, "root/review");
  } finally { await f.close(); }
});

test("strict invocation inputs, optimistic concurrency, policy, scope and revocation checks fail closed", async () => {
  const f = await fixture();
  try {
    const p = f.create(), args = f.args(p);
    for (const change of [{ allowed_effects: [] }, { allowed_effects: ["external_write"] }, { max_dispatches: 1 }, { ttl_ms: 0 }, { max_dispatches: 1.5 }, { max_dispatches: 501 }]) assert.throws(() => f.service.procedureInvocationBind({ ...args, ...change }));
    const work = f.store.get("verified_work_loop", "work");
    f.store.save("verified_work_loop", "work", { ...payload(work), lifecycle: "needs_replan" });
    assert.throws(() => f.service.procedureInvocationBind(args), /active/);
    f.store.save("verified_work_loop", "work", payload(work));
    f.service.procedureInvocationBind(args);
    assert.throws(() => f.service.procedureInvocationGet({ ...f.params(), scope: "project:other" }), /scope/);
    assert.throws(() => f.dispatch("invoke", { expected_version: 99 }), /version conflict/);
    assert.throws(() => f.dispatch("invoke", { item_key: "root/$exit" }), /not ready/);
    const original = f.store.get("experience_procedure", String(p.id));
    f.store.save("experience_procedure", String(p.id), { ...payload(original), lifecycle: "rolled_back", routeable: false });
    assert.throws(() => f.dispatch(), /revoked/);
    assert.equal(f.store.list("procedure_invocation_dispatch").length, 0);
    f.store.save("experience_procedure", String(p.id), { ...payload(original), scope_envelope: { applicability: { kind: "project", id: "invocation" }, audience: { mode: "private", principal_ids: ["owner"] } } });
    assert.throws(() => f.service.procedureInvocationGet(f.params()), /audience/);
  } finally { await f.close(); }
});

test("evidence is tied to exact invocation, call, Task, inputs, state revision and expiry", async () => {
  const f = await fixture();
  try {
    const p = f.create(spec(["approved"])); f.service.procedureInvocationBind(f.args(p));
    const id = f.precondition("invoke", "root", { diff: "artifact:diff" }), original = f.store.get("evidence", id);
    const changes = [{ scope: "project:other" }, { invocation_id: "other" }, { call_path: "child" }, { task_id: "other" }, { condition_ref: "other" }, { input_digest: "wrong" }, { snapshot_digest: "wrong" }, { workspace_state_revision: 2 }, { expires_at: "invalid" }, { expires_at: "2020-01-01" }];
    for (const change of changes) {
      f.store.save("evidence", id, { ...payload(original), metadata: { ...original.metadata as JsonObject, ...change } });
      assert.throws(() => f.dispatch("invoke", { precondition_evidence: { root: { approved: id } } }), /stale/);
    }
    f.store.save("evidence", id, { ...payload(original), confidence: "bounded" });
    assert.throws(() => f.dispatch("invoke", { precondition_evidence: { root: { approved: id } } }), /stale/);
    f.store.save("evidence", id, payload(original));
    f.dispatch("invoke", { precondition_evidence: { root: { approved: id } } });
    assert.equal(f.store.list("procedure_invocation_dispatch").length, 1);
  } finally { await f.close(); }
});

test("receipt binding rejects foreign sessions, observations, outputs and evidence and rolls back partial persistence", async () => {
  const f = await fixture();
  try {
    const p = f.create(); f.service.procedureInvocationBind(f.args(p));
    const prepared = f.dispatch(), report = f.proof(prepared);
    f.service.procedureInvocationBind(f.args(p, "foreign"));
    assert.throws(() => f.service.procedureInvocationReport({ ...report, invocation_id: "foreign" }), /another invocation/);
    const sid = String(report.host_session_id), oid = String(report.observation_id), eid = String((report.acceptance_evidence_ids as string[])[0]);
    const mutations: [string, string, JsonObject][] = [
      ...[{ status: "running" }, { task_id: "other" }, { host_id: "other" }, { capability_fingerprint: "bad" }, { model_fingerprint: "other" }, { budget_fingerprint: "other" }, { next_sequence: 999 }].map(v => ["host_session", sid, v] as [string,string,JsonObject]),
      ...[{ state_snapshot_ref: "other" }, { trace_id: "other" }, { host_id: "other" }, { observer_id: null }, { observer_id: "host" }, { observer_kind: "human" }, { environment_fingerprint: "other" }, { verdict: "bad" }].map(v => ["outcome_observation", oid, v] as [string,string,JsonObject]),
      ["evidence", eid, { source_type: "host" }], ["evidence", eid, { confidence: "bounded" }], ["outcome_observation", oid, { evidence_ids: [] }],
    ];
    for (const [kind,id,change] of mutations) { const before = f.store.get(kind,id); f.store.save(kind,id,{ ...payload(before), ...change }); assert.throws(() => f.service.procedureInvocationReport(report)); f.store.save(kind,id,payload(before)); }
    const original = f.store.get("evidence",eid);
    for (const key of ["dispatch_digest", "acceptance_digest", "output_digest", "state_after_digest", "status"]) {
      f.store.save("evidence",eid,{ ...payload(original), metadata: { ...original.metadata as JsonObject, [key]: "bad" } });
      assert.throws(() => f.service.procedureInvocationReport(report), /Acceptance Evidence/);
    }
    f.store.save("evidence",eid,payload(original));
    assert.throws(() => f.service.procedureInvocationReport({ ...report, acceptance_evidence_ids: [] }), /Evidence is required/);
    assert.throws(() => f.service.procedureInvocationReport({ ...report, output_refs: {} }), /Output refs/);
    const originalCreate = f.store.create.bind(f.store);
    f.store.create = (kind, id, value) => { if (kind === "procedure_invocation_receipt") throw new Error("injected persistence failure"); return originalCreate(kind,id,value); };
    assert.throws(() => f.service.procedureInvocationReport(report), /injected/);
    f.store.create = originalCreate;
    assert.equal(f.store.list("acceptance_gate").length, 0);
    assert.equal(f.store.get("durable_action", String((prepared.dispatch as JsonObject).id)).lifecycle, "dispatched");
    assert.equal(f.service.procedureInvocationReport(report).idempotent, false);
  } finally { await f.close(); }
});

test("resume invalidates drift and budget/Task changes stop new dispatches", async () => {
  const f = await fixture();
  try {
    const p = f.create(); f.service.procedureInvocationBind(f.args(p));
    assert.equal(f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "before" }).recovery_action, "propose_action");
    const task = f.store.get("task", "task"); f.store.save("task", "task", { ...payload(task), status: "paused" });
    assert.throws(() => f.dispatch(), /Policy changed/); f.store.save("task", "task", payload(task));
    const run = f.store.get("procedure_invocation", "invoke");
    f.store.save("procedure_invocation", "invoke", { ...payload(run), dispatch_count: 30 });
    assert.throws(() => f.dispatch(), /budget exhausted/);
    f.store.save("procedure_invocation", "invoke", { ...payload(run), expires_at: "2020-01-01" });
    assert.throws(() => f.dispatch(), /expired/);
    f.store.save("procedure_invocation", "invoke", payload(run));
    f.store.create("state_snapshot", "drift", { workspace_id: "workspace", snapshot_digest: stableDigest("changed"), workspace_state_revision: 2 });
    assert.equal(f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "drift" }).recovery_action, "replan");
    assert.equal(f.dispatch().next_action, "replan");
  } finally { await f.close(); }
});

test("paired trials require terminal and identical context, expose route outcomes without promotion", async () => {
  const f = await fixture();
  try {
    const p = f.create(), baselines: string[] = [], candidates: string[] = [];
    for (const prefix of ["b", "c"]) for (let i = 0; i < 3; i++) {
      const id = `${prefix}${i}`; (prefix === "b" ? baselines : candidates).push(id);
      f.service.procedureInvocationBind(f.args(p,id));
      f.service.procedureInvocationReport(f.proof(f.dispatch(id), prefix === "b" ? "failed" : "passed", "before", true));
      if (prefix === "c") f.service.procedureInvocationReport(f.proof(f.dispatch(id), "passed", "before", true));
    }
    const args = { scope, baseline_ids: baselines, candidate_ids: candidates };
    const result = f.service.procedureInvocationEvaluate(args);
    assert.equal(result.metrics_available, true);
    const receipt = f.store.list("procedure_invocation_receipt", 500, r => r.invocation_id === "c0")[0]!;
    f.store.save("procedure_invocation_receipt", String(receipt.id), { ...payload(receipt), metrics: null });
    assert.equal(f.service.procedureInvocationEvaluate(args).metrics_available, false);
    f.store.save("procedure_invocation_receipt", String(receipt.id), payload(receipt));
    assert.equal(result.baseline_pass_rate, 0); assert.equal(result.candidate_pass_rate, 1); assert.equal(result.promotion_eligible, false);
    assert.throws(() => f.service.procedureInvocationEvaluate({ ...args, baseline_ids: ["b0"] }), /3..100/);
    assert.throws(() => f.service.procedureInvocationEvaluate({ ...args, baseline_ids: candidates }), /independent/);
    const original = f.store.get("procedure_invocation", "c0");
    f.store.save("procedure_invocation", "c0", { ...payload(original), model_fingerprint: "other" });
    assert.throws(() => f.service.procedureInvocationEvaluate(args), /context differs/);
    f.store.save("procedure_invocation", "c0", { ...payload(original), lifecycle: "active" });
    assert.throws(() => f.service.procedureInvocationEvaluate(args), /terminal invocations/);
  } finally { await f.close(); }
});

test("active budget balances, malformed refs, missing artifacts and post-dispatch drift are enforced", async () => {
  const f = await fixture();
  try {
    const p = f.create();
    const contract = f.store.get("task_control_contract", "contract");
    f.store.create("budget_account", "budget", { owner_id: "task", status: "active", limits: { cost: 5 }, used: {}, reserved: {} });
    const updated = f.store.save("task_control_contract", "contract", { ...payload(contract), budget_account: { id: "budget", version: 1 } });
    f.store.save("verified_work_loop", "work", { ...payload(f.store.get("verified_work_loop", "work")), contract_version: updated.version });
    f.service.procedureInvocationBind(f.args(p));
    const budget = f.store.get("budget_account", "budget");
    assert.equal(f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "before" }).recovery_action, "propose_action");
    for (const change of [{ status: "closed" }, { owner_id: "other" }, { used: { cost: 5 } }, { used: { cost: 3 }, reserved: { cost: 2 } }]) {
      f.store.save("budget_account", "budget", { ...payload(budget), ...change });
      assert.throws(() => f.dispatch(), /Task budget/);
    }
    f.store.save("budget_account", "budget", { ...payload(budget), used: { cost: 1 } });
    const run = f.store.get("procedure_invocation", "invoke");
    f.store.save("procedure_invocation", "invoke", { ...payload(run), artifacts: {} });
    assert.throws(() => f.dispatch(), /not been accepted/);
    f.store.save("procedure_invocation", "invoke", payload(run));
    const prepared = f.dispatch(), report = f.proof(prepared);
    f.store.create("state_snapshot", "drift", { workspace_id: "workspace", snapshot_digest: stableDigest("drift"), workspace_state_revision: 2 });
    f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "drift" });
    assert.throws(() => f.service.procedureInvocationReport(report), /requires replan/);
    assert.equal(f.store.get("procedure_invocation", "invoke").lifecycle, "active");
    const value = spec(); (value.steps as JsonObject[])[0]!.id = "$exit";
    assert.throws(() => validateProcedureComposition("workflow", value.composition, value.steps), /reserved/);
  } finally { await f.close(); }
});

test("content-free metrics are attributed to each route and comparable only under the paired context", async () => {
  const f = await fixture();
  try {
    const p = f.create(); f.service.procedureInvocationBind(f.args(p));
    for (let i = 0; i < 2; i++) {
      const prepared = f.dispatch(), report = f.proof(prepared), eid = String((report.acceptance_evidence_ids as string[])[0]);
      const original = f.store.get("evidence", eid);
      const metrics = { cost_units: 2, latency_ms: 50, retry_count: 0 };
      f.store.save("evidence", eid, { ...payload(original), metadata: { ...original.metadata as JsonObject, metrics: { ...metrics, retry_count: 0.5 } } });
      assert.throws(() => f.service.procedureInvocationReport(report), /Metrics/);
      f.store.save("evidence", eid, { ...payload(original), metadata: { ...original.metadata as JsonObject, metrics: { ...metrics, cost_units: -1 } } });
      assert.throws(() => f.service.procedureInvocationReport(report), /Metrics/);
      f.store.save("evidence", eid, { ...payload(original), metadata: { ...original.metadata as JsonObject, metrics } });
      const duplicateId = `${eid}:second`;
      f.store.create("evidence", duplicateId, { ...payload(original), metadata: { ...original.metadata as JsonObject, metrics: { ...metrics, cost_units: 3 } } });
      const observation = f.store.get("outcome_observation", String(report.observation_id));
      f.store.save("outcome_observation", String(observation.id), { ...payload(observation), evidence_ids: [eid, duplicateId] });
      assert.throws(() => f.service.procedureInvocationReport({ ...report, acceptance_evidence_ids: [eid, duplicateId] }), /Conflicting/);
      f.store.save("evidence", duplicateId, { ...payload(original), metadata: { ...original.metadata as JsonObject, metrics } });
      const accepted = f.service.procedureInvocationReport({ ...report, acceptance_evidence_ids: [eid, duplicateId] });
      assert.equal((accepted.receipt as JsonObject).verification_provenance, "host_attested");
    }
    const outcome = (f.service.procedureInvocationGet(f.params()).outcomes as JsonObject[])[0]!;
    assert.deepEqual(outcome.metrics, { cost_units: 4, latency_ms: 100, retry_count: 0 });
    assert.equal(outcome.promotion_eligible, false);
  } finally { await f.close(); }
});

test("MCP wire validates bind, all invocation operations and real Host observation field types", async () => {
  const f = await fixture();
  try {
    const mcp = new McpServer(f.service, "component-experience-daily");
    let seq = 0;
    const call = async (name: string, args: JsonObject) => {
      const response = await mcp.handle({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } });
      const result = response!.result as JsonObject;
      assert.equal(result.isError, false, JSON.stringify(result)); return result.structuredContent as JsonObject;
    };
    const p = f.create();
    await call("craft_procedure_invocation_bind", f.args(p));
    await call("craft_procedure_invocation_resume", { ...f.params(), snapshot_id: "before" });
    for (const item_key of ["root/review", "root/$exit"]) {
      const prepared = await call("craft_procedure_invocation_dispatch", { ...f.params(), snapshot_id: "before", item_key });
      await call("craft_procedure_invocation_report", f.proof(prepared));
    }
    assert.equal((await call("craft_procedure_invocation_get", { scope, invocation_id: "invoke" })).invocation !== null, true);
    const { validateJsonSchema } = await import("../core/json-schema.ts");
    const full = new McpServer(f.service, "full");
    validateJsonSchema({ task_id: "task", host_id: "host", environment_fingerprint: "env", policy_fingerprint: "policy", capability_fingerprint: "dispatch", model_fingerprint: "model-v1", budget_fingerprint: "budget-v1" }, full.tools.find(tool => tool.name === "craft_host_session_open")!.inputSchema);
    validateJsonSchema({ trace_id: "trace", host_id: "host", observer_id: "verifier", observer_kind: "program", environment_fingerprint: "env", verdict: "passed", state_snapshot_ref: "before" }, full.tools.find(tool => tool.name === "craft_outcome_observer_observe")!.inputSchema);
    const advanced = new McpServer(f.service, "component-experience");
    validateJsonSchema({ scope, baseline_ids: ["a", "b", "c"], candidate_ids: ["d", "e", "f"] }, advanced.tools.find(tool => tool.name === "craft_procedure_invocation_evaluate")!.inputSchema);
  } finally { await f.close(); }
});

test("failed nested exit blocks parent consumption and late receipt cannot erase workspace drift", async () => {
  const f = await fixture();
  try {
    const child = f.create(), p = f.create({ ...spec(), steps: [{ id: "review", type: "procedure_call", side_effect: "read_only", requires: ["diff"], provides: ["report"], procedure_id: child.id, procedure_version: child.version, definition_digest: child.definition_digest, entry_id: "review", exit_id: "reviewed", input_bindings: { diff: "diff" }, output_bindings: { report: "report" } }] });
    f.service.procedureInvocationBind(f.args(p));
    f.service.procedureInvocationReport(f.proof(f.dispatch()));
    const childExit = f.dispatch();
    assert.equal((childExit.work_item as JsonObject).id, "root/review/$exit");
    f.service.procedureInvocationReport(f.proof(childExit, "failed"));
    const state = f.service.procedureInvocationGet(f.params());
    assert.equal((state.invocation as JsonObject).lifecycle, "failed");
    assert.equal(Object.hasOwn((state.invocation as JsonObject).artifacts as object, "root:output:report"), false);
    assert.equal((state.outcomes as JsonObject[])[0]!.call_path, "root/review");
    assert.throws(() => f.service.procedureInvocationDispatch({ ...f.params(), snapshot_id: "before", item_key: "root/$exit" }), /terminal/);
    f.service.procedureInvocationBind(f.args(child, "late"));
    f.service.procedureInvocationReport(f.proof(f.dispatch("late")));
    const late = f.proof(f.dispatch("late"));
    f.store.create("state_snapshot", "changed", { workspace_id: "workspace", snapshot_digest: stableDigest("changed"), workspace_state_revision: 2 });
    f.service.procedureInvocationResume({ ...f.params("late"), snapshot_id: "changed" });
    assert.throws(() => f.service.procedureInvocationReport(late), /requires replan/);
  } finally { await f.close(); }
});

test("blocked, inconclusive and retryable failures retain verdicts and require fresh safe-retry evidence before continuing", async () => {
  for (const verdict of ["blocked", "inconclusive", "failed"]) {
    const f = await fixture();
    try {
      f.service.procedureInvocationBind(f.args(f.create(spec(), "retry")));
      const first = f.dispatch(), proof = f.proof(first, verdict);
      const reported = f.service.procedureInvocationReport(proof);
      assert.equal((reported.receipt as JsonObject).status, verdict);
      assert.equal((reported.invocation as JsonObject).lifecycle, verdict);
      await f.reopen();
      assert.equal(f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "before" }).recovery_action, verdict === "failed" ? "retry" : "await_resolution");
      assert.throws(() => f.service.procedureInvocationDispatch({ ...f.params(), snapshot_id: "before", item_key: "root/review" }), /terminal/);
      const snapshot = f.store.get("state_snapshot", "before");
      const recovery = { source_type: "program", confidence: "confirmed", metadata: { invocation_id: "invoke", receipt_id: (reported.receipt as JsonObject).id,
        snapshot_digest: snapshot.snapshot_digest, workspace_state_revision: 1, safe_to_retry: true, expires_at: new Date(Date.now() + 60_000).toISOString() } };
      f.store.create("evidence", "recovery", recovery);
      f.store.create("evidence", "bad-recovery", { ...recovery, metadata: { ...recovery.metadata, safe_to_retry: false } });
      assert.throws(() => f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "before", recovery_evidence_id: "bad-recovery" }), /Recovery Evidence/);
      f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "before", recovery_evidence_id: "recovery" });
      const retry = f.dispatch();
      assert.notEqual((retry.dispatch as JsonObject).id, (first.dispatch as JsonObject).id);
      f.service.procedureInvocationReport(f.proof(retry));
      f.service.procedureInvocationReport(f.proof(f.dispatch()));
      assert.equal(f.store.get("procedure_invocation", "invoke").lifecycle, "completed");
      assert.equal((f.service.procedureInvocationGet(f.params()).receipts as JsonObject[]).length, 3);
    } finally { await f.close(); }
  }
});

test("Host cancellation is a distinct terminal result and cannot be automatically reopened", async () => {
  const f = await fixture();
  try {
    f.service.procedureInvocationBind(f.args(f.create()));
    const prepared = f.dispatch(), proof = f.proof(prepared, "inconclusive");
    const session = f.store.get("host_session", String(proof.host_session_id));
    const terminal = f.store.list("host_session_event", 10, event => event.session_id === session.id && event.sequence === session.next_sequence)[0]!;
    f.store.save("host_session_event", String(terminal.id), { ...payload(terminal), kind: "session.cancelled" });
    assert.equal((f.service.procedureInvocationReport(proof).invocation as JsonObject).lifecycle, "cancelled");
    assert.throws(() => f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "before" }), /terminal/);
  } finally { await f.close(); }
});

test("explicit read-only parallel group dispatches independently and joins before exit", async () => {
  const f = await fixture();
  try {
    const value: JsonObject = { steps: [
      { id: "review", type: "instruction", side_effect: "read_only", requires: ["diff"], provides: ["report"], instruction: "Review" },
      { id: "test", type: "instruction", side_effect: "read_only", requires: ["diff"], provides: ["tests"], instruction: "Inspect tests" }],
      composition: { entries: [{ id: "review", title: "Review", required_inputs: ["diff"], preconditions: [], routes: [{ exit_id: "reviewed", step_ids: ["review", "test"], parallel_groups: [["review", "test"]] }] }],
        exits: [{ id: "reviewed", title: "Reviewed", required_outputs: ["report", "tests"], acceptance_ref: "review-contract" }] } };
    f.service.procedureInvocationBind(f.args(f.create(value)));
    const first = f.service.procedureInvocationDispatch({ ...f.params(), snapshot_id: "before", item_key: "root/review" });
    const second = f.service.procedureInvocationDispatch({ ...f.params(), snapshot_id: "before", item_key: "root/test" });
    assert.equal(f.service.procedureInvocationDispatch({ ...f.params(), snapshot_id: "before", item_key: "root/$exit" }).next_action, "await_receipt");
    f.service.procedureInvocationReport(f.proof(second));
    f.service.procedureInvocationReport(f.proof(first));
    f.service.procedureInvocationReport(f.proof(f.dispatch()));
    assert.equal(f.store.get("procedure_invocation", "invoke").lifecycle, "completed");
    for (const mutate of [
      (v: JsonObject) => { ((v.steps as JsonObject[])[1]!).side_effect = "local_write"; },
      (v: JsonObject) => { ((v.steps as JsonObject[])[1]!).requires = ["report"]; },
      (v: JsonObject) => { (((v.composition as JsonObject).entries as JsonObject[])[0]!.routes as JsonObject[])[0]!.parallel_groups = [["review", "missing"]]; },
    ]) { const changed = structuredClone(value); mutate(changed); assert.throws(() => f.service.procedureInvocationBind(f.args(f.create(changed), "invalid")), /Parallel/); }
  } finally { await f.close(); }
});


test("recovery rejects handoff failures, exhausted retries and drift after verified resolution", async () => {
  for (const mode of ["handoff", "budget", "drift"]) {
    const f = await fixture();
    try {
      f.service.procedureInvocationBind(f.args(f.create(spec(), mode === "handoff" ? "checkpoint_and_handoff" : "retry")));
      const result = f.service.procedureInvocationReport(f.proof(f.dispatch(), "failed"));
      const snapshot = f.store.get("state_snapshot", "before");
      f.store.create("evidence", "resolved", { source_type: "program", confidence: "confirmed", metadata: { invocation_id: "invoke", receipt_id: (result.receipt as JsonObject).id,
        snapshot_digest: snapshot.snapshot_digest, workspace_state_revision: 1, safe_to_retry: true, expires_at: new Date(Date.now() + 60000).toISOString() } });
      if (mode === "handoff") assert.throws(() => f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "before", recovery_evidence_id: "resolved" }), /handoff/);
      if (mode === "budget") {
        for (let retry = 0; retry < 3; retry++) {
          const receipt = f.store.get("procedure_invocation", "invoke").last_receipt_id;
          const proof = f.store.get("evidence", "resolved"); f.store.save("evidence", "resolved", { ...payload(proof), metadata: { ...(proof.metadata as JsonObject), receipt_id: receipt } });
          f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "before", recovery_evidence_id: "resolved" });
          f.service.procedureInvocationReport(f.proof(f.dispatch(), "failed"));
        }
        assert.throws(() => f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "before", recovery_evidence_id: "resolved" }), /retry budget/);
      }
      if (mode === "drift") {
        f.store.create("state_snapshot", "changed", { workspace_id: "workspace", snapshot_digest: "different", workspace_state_revision: 2 });
        const proof = f.store.get("evidence", "resolved"); f.store.save("evidence", "resolved", { ...payload(proof), metadata: { ...(proof.metadata as JsonObject), snapshot_digest: "different", workspace_state_revision: 2 } });
        assert.equal(f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "changed", recovery_evidence_id: "resolved" }).recovery_action, "replan");
      }
    } finally { await f.close(); }
  }
});

test("parallel group schema bounds and a failed Host with a passing observation remain failures", async () => {
  const f = await fixture();
  try {
    for (const groups of ["bad", [Array.from({ length: 9 }, (_, n) => `step${n}`)]]) {
      const value = spec(); (((value.composition as JsonObject).entries as JsonObject[])[0]!.routes as JsonObject[])[0]!.parallel_groups = groups;
      assert.throws(() => validateProcedureComposition("workflow", value.composition, value.steps), /parallel_groups|8 steps/);
    }
    f.service.procedureInvocationBind(f.args(f.create()));
    const proof = f.proof(f.dispatch());
    const session = f.store.get("host_session", String(proof.host_session_id));
    const terminal = f.store.list("host_session_event", 10, item => item.session_id === session.id && item.sequence === session.next_sequence)[0]!;
    f.store.save("host_session_event", String(terminal.id), { ...payload(terminal), kind: "session.failed" });
    assert.equal((f.service.procedureInvocationReport(proof).receipt as JsonObject).status, "failed");
  } finally { await f.close(); }
});

test("parallel receipt draining preserves each blocker and recovery cannot skip unresolved siblings", async () => {
  for (const [firstVerdict, secondVerdict] of [["blocked", "passed"], ["failed", "inconclusive"], ["blocked", "blocked"]]) {
    const f = await fixture();
    try {
      const value = spec();
      value.steps = [
        { id: "review", type: "instruction", side_effect: "read_only", requires: ["diff"], provides: ["report"], instruction: "Review" },
        { id: "check", type: "instruction", side_effect: "read_only", requires: ["diff"], provides: ["checks"], instruction: "Check" }];
      const composition = value.composition as JsonObject;
      ((composition.entries as JsonObject[])[0]!.routes as JsonObject[])[0] = { exit_id: "reviewed", step_ids: ["review", "check"], parallel_groups: [["review", "check"]] };
      (composition.exits as JsonObject[])[0]!.required_outputs = ["report", "checks"];
      f.service.procedureInvocationBind(f.args(f.create(value, "retry")));
      const first = f.service.procedureInvocationDispatch({ ...f.params(), snapshot_id: "before", item_key: "root/review" });
      const second = f.service.procedureInvocationDispatch({ ...f.params(), snapshot_id: "before", item_key: "root/check" });
      const firstResult = f.service.procedureInvocationReport(f.proof(first, firstVerdict));
      const drained = f.service.procedureInvocationReport(f.proof(second, secondVerdict)).invocation as JsonObject;
      assert.notEqual(drained.lifecycle, "active");
      if (secondVerdict === "passed") assert.equal(drained.last_receipt_id, (firstResult.receipt as JsonObject).id);
      let recovered = 0;
      while (f.store.get("procedure_invocation", "invoke").lifecycle !== "active") {
        assert(recovered < 2);
        const run = f.store.get("procedure_invocation", "invoke"), snapshot = f.store.get("state_snapshot", "before"), id = `recover-${++recovered}`;
        f.store.create("evidence", id, { source_type: "program", confidence: "confirmed", metadata: { invocation_id: "invoke", receipt_id: run.last_receipt_id,
          snapshot_digest: snapshot.snapshot_digest, workspace_state_revision: 1, safe_to_retry: true, expires_at: new Date(Date.now() + 60000).toISOString() } });
        f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "before", recovery_evidence_id: id });
      }
      assert.equal(recovered, secondVerdict === "passed" ? 1 : 2);
      for (let n = 0; n < recovered + 1; n++) f.service.procedureInvocationReport(f.proof(f.dispatch()));
      assert.equal(f.store.get("procedure_invocation", "invoke").lifecycle, "completed");
    } finally { await f.close(); }
  }
});
