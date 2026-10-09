import { experienceGraphTemplate } from "../capability/craft-experience/procedure-templates.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, scope, spec } from "./helpers/procedure-invocation-fixture.ts";
import { payload, stableDigest } from "../core/digest.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { McpServer } from "../core/mcp.ts";
import { ProcedureStore } from "../capability/craft-experience/procedure-projection.ts";
import { ProcedureDefinitionStore } from "../capability/craft-experience/procedure-definition.ts";
import { validateGraphControl, selectGraph } from "../capability/craft-experience/procedure-graph.ts";

export function graph(): JsonObject { return experienceGraphTemplate("internet-product-engineering"); }

test("failed configuration publication is retryable after a changed definition and preserves referenced versions", async () => {
  const f = await fixture();
  try {
    const original = f.store.create.bind(f.store);
    f.store.create = ((kind: string, id: string, value: JsonObject) => {
      if (kind === "experience_procedure") throw new Error("injected database failure");
      return original(kind, id, value);
    }) as typeof f.store.create;
    const args = { procedure_id: "interrupted", scope, title: "Review", procedure_kind: "workflow", scenario_id: "engineering", definition: spec() };
    assert.throws(() => f.service.procedureConfigurationSave(args), /injected database failure/);
    f.store.create = original;
    assert.equal(f.store.find("experience_procedure", "interrupted"), null);
    const changed = spec(); (changed.steps as JsonObject[])[0]!.instruction = "Review the current diff";
    const procedure = f.service.procedureConfigurationSave({ ...args, definition: changed }).procedure as JsonObject;
    const saved = new ProcedureDefinitionStore(f.store.paths).read(procedure.definition_ref as never);
    assert.equal((saved.definition.steps as JsonObject[])[0]!.instruction, "Review the current diff");
    assert.throws(() => new ProcedureDefinitionStore(f.store.paths).write({ ...saved, definition: spec() }, "Review"), /version already exists|digest drifted/);
    assert.equal(((new ProcedureDefinitionStore(f.store.paths).read(procedure.definition_ref as never).definition.steps as JsonObject[])[0]!).instruction, "Review the current diff");
    const foreign = new ProcedureDefinitionStore(f.store.paths).write({ ...saved, procedure_id: "claimed-path", procedure_version: 1, definition: spec() }, "Review");
    f.store.create("experience_procedure", "foreign-owner", { definition_ref: foreign });
    assert.throws(() => f.service.procedureConfigurationSave({ ...args, procedure_id: "claimed-path", definition: changed }), /digest drifted/);
  } finally { await f.close(); }
});
async function setup(value = graph()) {
  const f = await fixture();
  function configure(definition = value, extra: JsonObject = {}) { return f.service.procedureConfigurationSave({ procedure_id: "scenario", scope, title: "互联网产研", procedure_kind: "graph", definition, ...extra }).procedure as JsonObject; }
  function promote(p: JsonObject) {
    const definition = value.graph_control as JsonObject;
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
      const evidence_ids = (definition.subscenarios as JsonObject[]).map(route => {
        const id = `${p.id}:${p.definition_digest}:${stage}:${route.id}`;
        f.store.create("evidence", id, { confidence: "confirmed", metadata: { procedure_definition_digest: p.definition_digest, entry_id: route.entry_id, exit_id: route.exit_id, subscenario_id: route.id, stage, status: "passed" } }); return id;
      });
      new ProcedureStore(f.store).gate({ procedure_id: p.id, stage, passed: true, evidence_ids });
    }
    return f.store.get("experience_procedure", String(p.id));
  }
  const p = promote(configure());
  function bind(subscenario = "feature", id = "invoke") {
    const choice = ((value.graph_control as JsonObject).subscenarios as JsonObject[]).find(s => s.id === subscenario)!;
    return f.service.procedureInvocationBind({ ...f.args(p, id), subscenario_id: subscenario, entry_id: choice.entry_id, exit_id: choice.exit_id, input_refs: subscenario === "cr" ? { diff: "artifact:diff", tests: "artifact:tests" } : { request: "artifact:request" } });
  }
  let decisionCount = 0;
  function proof(edge_id: string, id = "invoke", extra: JsonObject = {}) {
    const run = f.store.get("procedure_invocation", id), loop = f.store.get("durable_action_loop", String(run.action_loop_id)), snapshot = f.store.get("state_snapshot", String(loop.latest_snapshot_id));
    const evidence_id = `${id}:${edge_id}:${run.version}:${++decisionCount}`;
    f.store.create("evidence", evidence_id, { source_type: "program", confidence: "confirmed", metadata: { scope, invocation_id: id, receipt_id: run.last_receipt_id, graph_state_digest: stableDigest(run.graph_state), snapshot_digest: snapshot.snapshot_digest, workspace_state_revision: snapshot.workspace_state_revision, expires_at: new Date(Date.now() + 60000).toISOString(), matched_edge_ids: [edge_id], result: true, safe_to_retry: true, predicate_ref: "changes_requested", ...extra } });
    return { ...f.params(id), transition_id: evidence_id, edge_id, receipt_id: run.last_receipt_id, snapshot_id: snapshot.id, evidence_id };
  }
  function next(edge: string, id = "invoke") { return f.service.procedureInvocationTransition(proof(edge, id)); }
  function step(id = "invoke", verdict = "passed") { const args = f.proof(f.dispatch(id), verdict); return f.service.procedureInvocationReport(args); }
  return { ...f, configure, promote, bind, next, step, decision: proof, p };
}

test("shared scenario runs requirements, bugfix, diagnosis and CR; transitions survive restart and exit acceptance remains required", async () => {
  const f = await setup();
  try {
    for (const [subscenario, edges] of Object.entries({ feature: ["requirements", "tests", "review", "deliver"], bugfix: ["fix", "tests", "review", "deliver"], diagnosis: ["diagnosis"], cr: ["review_only"] })) {
      f.bind(subscenario, subscenario);
      assert.equal((f.service.procedureInvocationGet(f.params(subscenario)).invocation as JsonObject).scenario_id, "internet-product-engineering");
      assert.throws(() => f.service.procedureInvocationDispatch({ ...f.params(subscenario), snapshot_id: "before", item_key: "root/$exit" }), /ready|pending/);
      for (const edge of edges) { f.step(subscenario); const args = f.decision(edge, subscenario); const result = f.service.procedureInvocationTransition(args); assert.equal(result.host_execution_authority, false); assert.equal(f.service.procedureInvocationTransition(args).idempotent, true); }
      await f.reopen();
      assert.equal(f.store.get("procedure_invocation", subscenario).lifecycle, "active");
      f.step(subscenario);
      assert.equal(f.store.get("procedure_invocation", subscenario).lifecycle, "completed");
    }
  } finally { await f.close(); }
});

test("rework invalidates downstream outputs and old acceptance; next delivery uses only the new diff and tests", async () => {
  const f = await setup();
  try {
    f.bind(); f.step(); f.next("requirements"); const old = f.step(); f.next("tests"); f.step(); f.next("review"); f.step();
    const reworked = f.next("rework"); assert.equal((reworked.transition as JsonObject).rework, true);
    const run = reworked.invocation as JsonObject, state = run.graph_state as JsonObject;
    assert.deepEqual(Object.keys(state.bindings as JsonObject).sort(), ["request", "spec"]);
    assert.equal((f.service.procedureInvocationGet(f.params()).work_items as JsonObject[]).filter(i => i.status === "superseded").length, 3);
    const stale = f.decision("tests"); stale.receipt_id = (old.receipt as JsonObject).id;
    assert.throws(() => f.service.procedureInvocationTransition(stale), /current-attempt/);
    f.step(); f.next("tests"); f.step(); f.next("review"); f.step(); f.next("deliver");
    const prepared = f.dispatch(), refs = (prepared.dispatch as JsonObject).input_refs as JsonObject;
    assert.notEqual(refs.diff, ((old.receipt as JsonObject).output_refs as JsonObject).diff);
    const finalProof = f.proof(prepared);
    assert.throws(() => f.service.procedureInvocationReport({ ...finalProof, output_refs: { ...refs, diff: ((old.receipt as JsonObject).output_refs as JsonObject).diff } }), /replace/);
    f.service.procedureInvocationReport(finalProof);
    assert.equal(f.store.get("procedure_invocation", "invoke").lifecycle, "completed");
  } finally { await f.close(); }
});

test("graph failure retries through a bounded rework edge instead of skipping acceptance", async () => {
  const f = await setup();
  try {
    f.bind(); f.step(); f.next("requirements"); f.step(); f.next("tests"); f.step("invoke", "failed");
    assert.equal(f.store.get("procedure_invocation", "invoke").recovery_action, "graph_transition");
    assert.equal(f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "before" }).recovery_action, "graph_transition");
    assert.throws(() => f.service.procedureInvocationResume({ ...f.params(), snapshot_id: "before", recovery_evidence_id: "arbitrary" }), /declared transition/);
    assert.throws(() => f.next("review"), /outcome/);
    f.next("retry"); f.step(); f.next("tests"); f.step(); f.next("review"); f.step(); f.next("deliver"); f.step();
    assert.equal(f.store.get("procedure_invocation", "invoke").lifecycle, "completed");
  } finally { await f.close(); }
});

test("configuration revisions are immutable candidates, preserve gates only on identical save and require scoped CAS", async () => {
  const f = await setup();
  try {
    assert.equal(f.configure().version, f.p.version);
    const changed = graph(); (changed.nodes as JsonObject[])[0]!.instruction = "Clarify outcome";
    assert.throws(() => f.configure(changed), /version conflict/);
    assert.throws(() => f.configure(changed, { scope: "project:other" }), /scope/);
    const next = f.configure(changed, { expected_version: f.p.version });
    assert.equal(next.content_version, 2); assert.equal(next.routeable, false); assert.deepEqual(next.completed_gates, []);
    assert.notEqual(next.definition_digest, f.p.definition_digest);
    assert.equal(f.store.get("experience_procedure", "scenario", Number(f.p.version)).routeable, true);
    assert.equal(f.store.count("experience_observation"), 0);
    const mcp = new McpServer(f.service, "component-experience-daily");
    const response = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "craft_procedure_configuration_save", arguments: { procedure_id: "configured-via-mcp", title: "互联网产研", scope, procedure_kind: "graph", definition: graph() } } });
    assert.equal((response!.result as JsonObject).isError, false, JSON.stringify(response));
  } finally { await f.close(); }
});

test("graph validation is repeatable and rejects bad boundaries before storing any configuration", () => {
  const value = graph(), control = validateGraphControl(value.graph_control, value.nodes, value.edges);
  assert.equal(validateGraphControl(control, value.nodes, value.edges).content_digest, control.content_digest);
  assert.throws(() => selectGraph(value, { subscenario_id: "feature", entry_id: "bug", exit_id: "delivery" }), /exact/);
  const mutations = [
    (g: any) => g.nodes[0].type = "human_gate",
    (g: any) => g.nodes = [], (g: any) => g.nodes[0].id = "bad/id", (g: any) => g.nodes[0].type = "custom", (g: any) => g.nodes[0].side_effect = "external_write",
    (g: any) => g.nodes[0].requires = ["a", "a"], (g: any) => g.graph_control.entries[0].node_id = "absent", (g: any) => g.graph_control.exits[0].node_id = "absent", (g: any) => g.nodes[5].provides = ["unexpected"],
    (g: any) => g.edges[0].from = "absent", (g: any) => g.edges[0].max_traversals = 0, (g: any) => g.edges[0].rework = "yes", (g: any) => g.edges[0].kind = "condition", (g: any) => g.edges[0].kind = "compensation",
    (g: any) => g.graph_control.subscenarios[0].allowed_nodes.push("absent"), (g: any) => g.graph_control.subscenarios[0].allowed_edges.push("diagnosis"), (g: any) => g.graph_control.subscenarios[0].allowed_edges = ["tests"], (g: any) => g.graph_control.subscenarios[0].allowed_effects = ["read_only"], (g: any) => g.graph_control.subscenarios[0].max_visits = 0,
  ];
  for (const mutate of mutations) { const bad = structuredClone(value); mutate(bad); assert.throws(() => validateGraphControl(bad.graph_control, bad.nodes, bad.edges)); }
});

test("graph decisions reject missing authority, ambiguous branches, stale evidence and exhausted limits atomically", async () => {
  const f = await setup();
  try {
    f.bind(); const dispatched = f.dispatch();
    const dummy = { ...f.params(), transition_id: "inflight", edge_id: "requirements", receipt_id: "not-yet", snapshot_id: "before", evidence_id: "e" };
    assert.throws(() => f.service.procedureInvocationTransition(dummy), /in-flight/);
    f.service.procedureInvocationReport(f.proof(dispatched));
    const base = f.decision("requirements"), proof = f.store.get("evidence", String(base.evidence_id));
    for (const changes of [{ confidence: "bounded" }, { source_type: "human" }, { metadata: {} }, { metadata: { ...proof.metadata as JsonObject, expires_at: "bad" } }, { metadata: { ...proof.metadata as JsonObject, expires_at: "2000-01-01" } }, { metadata: { ...proof.metadata as JsonObject, result: false } }, { metadata: { ...proof.metadata as JsonObject, matched_edge_ids: ["requirements", "diagnosis"] } }]) {
      f.store.save("evidence", String(proof.id), { ...payload(proof), ...changes }); assert.throws(() => f.service.procedureInvocationTransition(base), /Evidence|ambiguous/);
    }
    f.store.save("evidence", String(proof.id), payload(proof));
    assert.throws(() => f.service.procedureInvocationTransition({ ...base, edge_id: "diagnosis" }), /outside/);
    assert.throws(() => f.service.procedureInvocationTransition({ ...base, expected_version: 1 }), /version/);
    const run = f.store.get("procedure_invocation", "invoke"), loop = f.store.get("durable_action_loop", String(run.action_loop_id));
    f.store.save("durable_action_loop", String(loop.id), { ...payload(loop), lifecycle: "replan_required" });
    assert.throws(() => f.service.procedureInvocationTransition(base), /replan/); f.store.save("durable_action_loop", String(loop.id), payload(loop));
    f.store.create("state_snapshot", "drift", { workspace_id: "workspace", workspace_state_revision: 2, snapshot_digest: "drift" });
    assert.throws(() => f.service.procedureInvocationTransition({ ...base, snapshot_id: "drift" }), /snapshot drifted/);
    for (const mutate of [
      (r: any) => r.graph.scenario.max_transitions = 0,
      (r: any) => r.graph.edges.find((e: any) => e.id === "requirements").max_traversals = 0,
      (r: any) => r.graph.scenario.max_visits = 0,
      (r: any) => r.max_dispatches = r.dispatch_count,
      (r: any) => r.items = Array.from({ length: 10000 }, (_, i) => ({ id: `old${i}` })),
      (r: any) => r.graph.edges.find((e: any) => e.id === "requirements").kind = "compensation",
    ]) { const changed = structuredClone(payload(run)); mutate(changed); f.store.save("procedure_invocation", "invoke", changed); assert.throws(() => f.service.procedureInvocationTransition({ ...base, ...f.params() }), /budget|compensation/); }
    f.store.save("procedure_invocation", "invoke", payload(run));
    const accepted = f.service.procedureInvocationTransition({ ...base, ...f.params() });
    assert.equal(accepted.idempotent, false);
    assert.throws(() => f.service.procedureInvocationTransition({ ...base, evidence_id: "different" }), /idempotency/);
    f.step(); f.next("tests"); f.step(); f.next("review"); f.step();
    assert.throws(() => f.service.procedureInvocationTransition(f.decision("rework", "invoke", { safe_to_retry: false })), /safe target/);
    assert.throws(() => f.service.procedureInvocationTransition(f.decision("rework", "invoke", { predicate_ref: "other" })), /ambiguous/);
  } finally { await f.close(); }
});

test("human resume requires scoped human proof; child Workflow acceptance and graph preconditions remain enforced", async () => {
  const value = graph();
  (value.nodes as JsonObject[])[0]!.type = "human_gate";
  (value.edges as JsonObject[]).find(e => e.id === "requirements")!.kind = "human_resume";
  (value.edges as JsonObject[]).find(e => e.id === "requirements")!.predicate_ref = "changes_requested";
  ((value.graph_control as JsonObject).entries as JsonObject[])[0]!.preconditions = ["approved"];
  const f = await setup(value);
  try {
    const planArgs = { ...f.args(f.p), subscenario_id: "feature", entry_id: "requirements", exit_id: "delivery", input_refs: { request: "artifact:request" } };
    assert.throws(() => f.service.experienceProcedurePlan(planArgs), /precondition Evidence/);
    f.store.create("evidence", "approval", { confidence: "unverified", metadata: { scope, condition_ref: "approved" } });
    assert.throws(() => f.service.experienceProcedurePlan({ ...planArgs, precondition_evidence: { approved: "approval" } }), /mismatch/);
    f.store.save("evidence", "approval", { confidence: "confirmed", metadata: { scope, condition_ref: "approved" } });
    assert(f.service.experienceProcedurePlan({ ...planArgs, precondition_evidence: { approved: "approval" } }).plan);
    assert.throws(() => f.service.experienceProcedurePlan({ ...planArgs, input_refs: {} }), /Input references/);
    assert.throws(() => f.service.experienceProcedurePlan({ ...planArgs, allowed_effects: ["read_only"] }), /effects/);
    f.bind(); const pre = f.precondition("invoke", "root", { request: "artifact:request" });
    f.service.procedureInvocationReport(f.proof(f.dispatch("invoke", { precondition_evidence: { root: { approved: pre } } })));
    const decision = f.decision("requirements"), e = f.store.get("evidence", String(decision.evidence_id));
    assert.throws(() => f.service.procedureInvocationTransition(decision), /Evidence/);
    f.store.save("evidence", String(e.id), { ...payload(e), source_type: "human" });
    f.service.procedureInvocationTransition(decision);
  } finally { await f.close(); }
  const base = await fixture();
  try {
    const child = base.create(), g = graph();
    (g.nodes as JsonObject[])[4] = { id: "review", type: "subworkflow", side_effect: "read_only", requires: ["diff", "tests"], provides: ["report"], acceptance_ref: "review-contract", procedure_id: child.id, procedure_version: child.version, definition_digest: child.definition_digest, entry_id: "review", exit_id: "reviewed", input_bindings: { diff: "diff", tests: "tests" }, output_bindings: { report: "report" } };
    // The child contract has no tests input; reject that binding before dispatch.
    validateGraphControl(g.graph_control, g.nodes, g.edges);
    const p = base.service.procedureConfigurationSave({ procedure_id: "parent", scope, title: "Parent", procedure_kind: "graph", definition: g }).procedure as JsonObject;
    base.store.save("experience_procedure", "parent", { ...payload(p), routeable: true, lifecycle: "routeable" });
    assert.throws(() => base.service.procedureInvocationBind({ ...base.args(base.store.get("experience_procedure", "parent")), subscenario_id: "cr", entry_id: "cr", exit_id: "reviewed", input_refs: { diff: "diff", tests: "tests" } }), /Input references/);
    const workflow = spec(); ((workflow.composition as JsonObject).entries as JsonObject[])[0]!.required_inputs = ["diff", "tests"];
    const validChild = base.create(workflow); Object.assign((g.nodes as JsonObject[])[4]!, { procedure_id: validChild.id, procedure_version: validChild.version, definition_digest: validChild.definition_digest });
    const updated = base.service.procedureConfigurationSave({ procedure_id: "parent", scope, title: "Parent", procedure_kind: "graph", definition: g, expected_version: 2 }).procedure as JsonObject;
    base.store.save("experience_procedure", "parent", { ...payload(updated), routeable: true, lifecycle: "routeable" });
    base.service.procedureInvocationBind({ ...base.args(base.store.get("experience_procedure", "parent")), subscenario_id: "cr", entry_id: "cr", exit_id: "reviewed", input_refs: { diff: "diff", tests: "tests" } });
    base.service.procedureInvocationReport(base.proof(base.dispatch()));
    const nestedExit = base.dispatch(); assert.equal((nestedExit.work_item as JsonObject).kind, "exit");
    base.service.procedureInvocationReport(base.proof(nestedExit));
    const run = base.store.get("procedure_invocation", "invoke"); assert.equal(run.lifecycle, "active"); assert((run.artifacts as JsonObject)["root/g0:output:report"]);
  } finally { await base.close(); }
});

test("graph refuses skipped inputs, premature delivery and implicit cycles; ordinary Invocations cannot transition", async () => {
  const base = await fixture();
  try {
    base.service.procedureInvocationBind(base.args(base.create()));
    assert.throws(() => base.service.procedureInvocationTransition(base.params()), /no runtime Graph/);
    const old = base.store.get("experience_procedure", "p1");
    const updated = base.service.procedureConfigurationSave({ procedure_id: "p1", expected_version: old.version, scope, title: "Legacy update", scenario_id: "engineering", procedure_kind: "workflow", definition: spec() }).procedure as JsonObject;
    assert.equal(updated.content_version, 2);
    assert.throws(() => base.service.procedureConfigurationSave({ procedure_id: "private", scope, title: "Private", scenario_id: "engineering", procedure_kind: "workflow", definition: spec(), scope_envelope: { audience: { mode: "private", principal_ids: ["owner"] } } }), /audience denied/);
  } finally { await base.close(); }
  for (const mode of ["inputs", "exit", "cycle", "entry_exit"]) {
    const value = graph();
    if (mode === "inputs") (value.nodes as JsonObject[])[0]!.requires = ["absent"];
    if (mode === "exit") (value.nodes as JsonObject[])[4]!.provides = [];
    if (mode === "cycle") (value.edges as JsonObject[]).find(e => e.id === "rework")!.rework = false;
    if (mode === "entry_exit") {
      const control = value.graph_control as JsonObject; (control.entries as JsonObject[])[2]!.node_id = "reviewed";
      (value.edges as JsonObject[]).push({ id: "start_back", from: "reviewed", to: "review", kind: "success", max_traversals: 1 });
      ((control.subscenarios as JsonObject[])[3]!.allowed_edges as string[]).push("start_back");
    }
    const f = await setup(value);
    try {
      if (mode === "inputs" || mode === "entry_exit") { assert.throws(() => f.bind(mode === "inputs" ? "feature" : "cr"), /inputs|precede/); continue; }
      if (mode === "exit") { f.bind("cr"); f.step(); assert.throws(() => f.next("review_only"), /missing or invalidated outputs/); continue; }
      f.bind(); f.step(); f.next("requirements"); f.step(); f.next("tests"); f.step(); f.next("review"); f.step(); assert.throws(() => f.next("rework"), /explicit rework/);
      f.next("deliver"); assert.throws(() => f.next("deliver"), /reached/);
    } finally { await f.close(); }
  }
});

test("evidence-backed graph proposals use the runtime contract and cannot silently change subscenario content on retry", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence", "observed", { confidence: "confirmed" });
    for (const id of ["one", "two"]) f.service.workflowEvolutionObserve({ observation_id: id, scenario_key: "internet-product-engineering", source_kind: "outcome", source_id: id, source_digest: id, outcome: "passed", evidence_ids: ["observed"], execution_shape: ["recovery"], sanitized: true });
    const mcp = new McpServer(f.service, "component-experience-daily"), call = async (name: string, args: JsonObject) => {
      const response = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      assert.equal((response!.result as JsonObject).isError, false, JSON.stringify(response)); return (response!.result as JsonObject).structuredContent as JsonObject;
    };
    const request = (await call("craft_experience_procedure_draft", { request_id: "learned", scenario_key: "internet-product-engineering", hypothesis: "Bound rework", design_axes: ["orchestration"], procedure_kind: "graph", output_contract_ref: "delivery-contract" })).request as JsonObject;
    const args = { request_id: request.id, workflow_id: "graph", proposal_id: "learned", name: "产研", description: "Bounded graph", inputs: ["request"], ...graph() };
    const first = await call("craft_experience_procedure_submit", args); assert.equal(first.workflow, null); assert.equal((first.procedure as JsonObject).scenario_id, "internet-product-engineering");
    assert.equal((await call("craft_experience_procedure_submit", args)).idempotent, true);
    const changed = graph(); (changed.graph_control as JsonObject).title = "Changed";
    assert.throws(() => f.service.workflowEvolution.submit({ ...args, ...changed }), /idempotency/);
    assert.throws(() => f.service.workflowEvolution.submit({ ...args, graph_control: undefined }), /graph_control/);
    assert.equal(f.store.count("workflow_dag"), 0);
  } finally { await f.close(); }
});

test("graph compilation enforces child bindings, public outputs, total expansion and unsupported nested control graphs", async () => {
  const { ProcedureDefinitionStore } = await import("../capability/craft-experience/procedure-definition.ts");
  const f = await fixture(); let seq = 0;
  function routeable(value: JsonObject) {
    const id = `direct-graph-${++seq}`;
    const ref = new ProcedureDefinitionStore(f.store.paths).write({ schema_version: "craft.procedure.v1", procedure_id: id, procedure_version: 1, kind: "graph", scope, trigger: "Fixture", preconditions: [], allowed_effects: ["read", "local_write"], acceptance_ref: "contract", failure_disposition: "checkpoint_and_handoff", scenario_signature: { scenario_id: "engineering" }, evidence_ids: [], proposal_ref: { id: "fixture", version: 1 }, definition: value }, id);
    return f.store.create("experience_procedure", id, { scope, routeable: true, lifecycle: "routeable", definition_ref: ref, definition_digest: ref.digest });
  }
  function childNode(child: JsonObject, extra: JsonObject = {}) { return { id: "review", type: "subworkflow", side_effect: "read_only", requires: ["diff"], provides: ["report"], acceptance_ref: "review-contract", procedure_id: child.id, procedure_version: child.version, definition_digest: child.definition_digest, entry_id: "review", exit_id: "reviewed", input_bindings: { diff: "diff" }, output_bindings: { report: "report" }, ...extra }; }
  function plan(p: JsonObject, scene = "cr") { return f.service.experienceProcedurePlan({ ...f.args(p), entry_id: scene === "cr" ? "cr" : "requirements", exit_id: scene === "cr" ? "reviewed" : "delivery", subscenario_id: scene, input_refs: scene === "cr" ? { diff: "diff", tests: "tests" } : { request: "request" } }); }
  try {
    const child = f.create();
    for (const patch of [{ input_bindings: {} }, { output_bindings: { other: "report" } }, { output_bindings: { report: "private" } }]) {
      const g = graph(); (g.nodes as JsonObject[])[4] = childNode(child, patch); assert.throws(() => plan(routeable(g)), /bindings|not public/);
    }
    const nested = routeable(graph()), g = graph();
    (g.nodes as JsonObject[])[4] = childNode(nested, { requires: ["diff", "tests"], entry_id: "cr", subscenario_id: "cr", input_bindings: { diff: "diff", tests: "tests" } });
    assert.throws(() => plan(routeable(g)), /Workflow subprocedure/);
    const workflow = spec(); (workflow.steps as JsonObject[])[0] = { ...childNode(nested, { entry_id: "cr", subscenario_id: "cr", input_bindings: { diff: "diff", tests: "tests" }, requires: ["diff", "tests"] }), type: "procedure_call" };
    ((workflow.composition as JsonObject).entries as JsonObject[])[0]!.required_inputs = ["diff", "tests"];
    assert.throws(() => f.service.experienceProcedurePlan({ ...f.args(f.create(workflow)), input_refs: { diff: "diff", tests: "tests" } }), /Workflow subprocedure/);
    const expanded = spec(); expanded.steps = Array.from({ length: 96 }, (_, i) => ({ id: `s${i}`, type: "instruction", instruction: "Check", side_effect: "read_only", requires: ["diff"], provides: [i === 95 ? "report" : `out${i}`] }));
    ((((expanded.composition as JsonObject).entries as JsonObject[])[0]!.routes as JsonObject[])[0]!).step_ids = (expanded.steps as JsonObject[]).map(s => s.id);
    const large = graph(); (large.nodes as JsonObject[])[4] = childNode(f.create(expanded)); assert.throws(() => plan(routeable(large), "feature"), /100 steps/);
  } finally { await f.close(); }
});

test("late parallel child receipts drain before graph rework and preserve the failed attempt", async () => {
  const f = await setup();
  try {
    const workflow = spec(); (workflow.steps as JsonObject[]).push({ id: "check", type: "instruction", side_effect: "read_only", requires: ["diff"], provides: ["checks"], instruction: "Check" });
    ((((workflow.composition as JsonObject).entries as JsonObject[])[0]!.routes as JsonObject[])[0]) = { exit_id: "reviewed", step_ids: ["review", "check"], parallel_groups: [["review", "check"]] };
    const child = f.create(workflow), g = graph(); (g.nodes as JsonObject[])[4] = { id: "review", type: "subworkflow", side_effect: "read_only", requires: ["diff"], provides: ["report"], acceptance_ref: "review-contract", procedure_id: child.id, procedure_version: child.version, definition_digest: child.definition_digest, entry_id: "review", exit_id: "reviewed", input_bindings: { diff: "diff" }, output_bindings: { report: "report" } };
    (g.edges as JsonObject[]).find(e => e.id === "rework")!.kind = "retry";
    const configured = f.configure(g, { expected_version: f.p.version }), promoted = f.promote(configured);
    f.service.procedureInvocationBind({ ...f.args(promoted), subscenario_id: "feature", entry_id: "requirements", exit_id: "delivery", input_refs: { request: "request" } });
    f.step(); f.next("requirements"); f.step(); f.next("tests"); f.step(); f.next("review");
    const first = f.service.procedureInvocationDispatch({ ...f.params(), snapshot_id: "before", item_key: "root/g3/review/review" });
    const second = f.service.procedureInvocationDispatch({ ...f.params(), snapshot_id: "before", item_key: "root/g3/review/check" });
    const failed = f.service.procedureInvocationReport(f.proof(first, "failed"));
    assert.throws(() => f.next("rework"), /in-flight/);
    f.service.procedureInvocationReport(f.proof(second));
    assert.equal(f.store.get("procedure_invocation", "invoke").last_receipt_id, (failed.receipt as JsonObject).id);
    const retry = f.next("rework"); assert.equal(((retry.invocation as JsonObject).graph_state as JsonObject).active_node, "implement");
    assert((f.service.procedureInvocationGet(f.params()).work_items as JsonObject[]).filter(i => String(i.item_key).startsWith("root/g3/")).every(i => i.status === "superseded"));
  } finally { await f.close(); }
});
