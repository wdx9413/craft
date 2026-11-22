import assert from "node:assert/strict";
import test from "node:test";
import { fixture, scope, spec } from "./helpers/procedure-invocation-fixture.ts";
import { ExperienceContribution } from '@craft/capability-experience/contribution';
import { experienceGraphTemplate } from '@craft/capability-experience/procedure-templates';
import { procedureTaskEffectFixture } from "./helpers/procedure-task-effect-fixture.ts";
import { ContextResolutionKernel } from "../core/context-resolution.ts";
import { discoverContextTools } from "../core/mcp/context-tools.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

test("graph diagnosis keeps a Procedure candidate unavailable until its signed evaluation contract is bound", async () => {
  const f = await fixture();
  try {
    const inspect = () => f.service.experienceGraphInspect({ action: "diagnose", scope, graph_id: "engineering" });
    assert.equal(inspect().reason, "no_accessible_graph_in_scope");
    const saved = f.service.experienceGraphEdit({ action: "save", scope, graph_id: "engineering", template_id: "internet-product-engineering" });
    assert.equal((inspect().drafts as JsonObject[])[0].usage_status, "draft_not_submitted");
    let p = f.service.experienceGraphEdit({ action: "submit", scope, graph_id: "engineering", expected_draft_digest: saved.draft_digest }).procedure as JsonObject;
    assert.equal((inspect().graphs as JsonObject[])[0].usage_status, "no_promoted_release");
    const reader = new ExperienceContribution(f.store);
    const request = { query: "诊断", scope_kind: "project", scope_id: scope.slice("project:".length), max_items: 10, max_chars: 20000 } as const;
    const candidate = await reader.contribute(request);
    assert.equal(candidate.items.length, 0); assert.equal(candidate.diagnostics?.reason, "no_promoted_release");
    // A positive held-out verdict without the bound Evaluation Contract must not
    // make a fixture look routeable. The signed promotion path is covered by the
    // Procedure Evaluation Contract service test.
    for (const stage of ["shadow"]) {
      const ids: string[] = [];
      for (const entry of p.entrypoints as JsonObject[]) for (const route of entry.routes as JsonObject[]) {
        const id = `${stage}:${route.subscenario_id}`; ids.push(id);
        f.store.create("evidence", id, { confidence: "confirmed", metadata: { procedure_definition_digest: p.definition_digest,
          entry_id: entry.id, exit_id: route.exit_id, subscenario_id: route.subscenario_id, stage, status: "passed" } });
      }
      p = f.service.experienceProcedures.gate({ procedure_id: p.id, stage, passed: true, evidence_ids: ids }).procedure as JsonObject;
    }
    const heldOutIds = (p.entrypoints as JsonObject[]).flatMap((entry) => (entry.routes as JsonObject[]).map((route) => {
      const id = `held_out:${route.subscenario_id}`;
      f.store.create("evidence", id, { confidence: "confirmed", metadata: { procedure_definition_digest: p.definition_digest,
        entry_id: entry.id, exit_id: route.exit_id, subscenario_id: route.subscenario_id, stage: "held_out", status: "passed" } });
      return id;
    }));
    assert.throws(() => f.service.experienceProcedures.gate({ procedure_id: p.id, stage: "held_out", passed: true, evidence_ids: heldOutIds }), /evaluation_contract_id must not be empty/u);
    assert.equal((f.service.experienceProcedureGet({ procedure_id: p.id }).procedure as JsonObject).routeable, false);
    const recalled = await reader.contribute(request);
    assert.equal(recalled.items.length, 0);
    assert.equal((inspect().graphs as JsonObject[])[0].usage_status, "no_promoted_release");
    assert.equal((await reader.contribute({ ...request, scope_id: "other" })).items.length, 0);
    assert.throws(() => f.service.experienceGraphInspect({ action: "diagnose", scope: "project:other", graph_id: "engineering" }), /root is not registered/u);
    const result = await f.service.contextResolutionResolve({ query: "诊断", scope_kind: "project", scope_id: scope, members: ["experience"], max_items: 10, max_chars: 20_000 });
    assert.equal(((result.contributions as JsonObject[])[0].diagnostics as JsonObject).reason, "no_promoted_release");
  } finally { await f.close(); }
});

test("Host start binds the governed plan and next reconciles dispatched work before another action", async () => {
  const f = await fixture();
  try {
    const p = f.create();
    const start = f.service.procedureHostControl({ action: "start", input: f.args(p) });
    assert.equal(start.usage_status, "bound"); assert.equal(start.host_execution_authority, false);
    assert.equal(f.store.count("host_run"), 0);
    const next = () => f.service.procedureHostControl({ action: "next", input: {}, invocation_id: "invoke", scope });
    assert.equal(next().next_tool, "craft_procedure_invocation_dispatch");
    const dispatched = f.dispatch();
    assert.equal(next().usage_status, "awaiting_receipt");
    f.service.procedureInvocationReport(f.proof(dispatched));
    assert.notEqual(next().usage_status, "awaiting_receipt");
    const exit = f.dispatch(); f.service.procedureInvocationReport(f.proof(exit));
    assert.equal(next().next_tool, null);
    assert.throws(() => f.service.procedureHostControl({ action: "start", scope: "project:foreign", input: f.args(p, "foreign") }), /scope/);
  } finally { await f.close(); }
});

test("a promoted Experience Workflow is recalled, executed through Host reports, and receives same-receipt usage feedback", async () => {
  const f = await fixture();
  try {
    const candidate = f.service.procedureConfigurationSave({ procedure_id: "promoted-workflow-use", scope, scenario_id: "verified-review",
      title: "Verified review", procedure_kind: "workflow", definition: spec() }).procedure as JsonObject;
    const qualification = procedureTaskEffectFixture(f.service, candidate);
    const reader = new ContextResolutionKernel(f.store, [new ExperienceContribution(f.store)]);
    const query = { query: "Review diff", scope_kind: "project", scope_id: scope.slice("project:".length),
      required_refs: [{ member: "experience", id: candidate.id }] };
    await assert.rejects(reader.resolve(query), /Required Context reference is unavailable/u);

    for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
      const evidenceIds: string[] = [];
      for (const entry of candidate.entrypoints as JsonObject[]) for (const route of entry.routes as JsonObject[]) {
        const evidenceId = `promoted-use:${stage}:${String(route.subscenario_id)}`;
        f.store.create("evidence", evidenceId, { confidence: "confirmed", metadata: { procedure_definition_digest: candidate.definition_digest,
          entry_id: entry.id, exit_id: route.exit_id, subscenario_id: route.subscenario_id, stage, status: "passed" } });
        evidenceIds.push(evidenceId);
      }
      f.service.experienceProcedureGate({ ...qualification, procedure_id: candidate.id, stage, passed: true,
        verdict: "passed", evidence_ids: evidenceIds });
    }

    const routeable = f.store.get("experience_procedure", String(candidate.id));
    assert.equal(routeable.lifecycle, "routeable");
    assert.equal(routeable.routeable, true);
    const resolved = await reader.resolve(query);
    const contextReceipt = resolved.receipt as JsonObject;
    const recalled = (resolved.contributions as JsonObject[]).flatMap(part => part.items as JsonObject[]);
    assert(recalled.some(item => item.procedure_id === candidate.id && item.procedure_kind === "workflow" && item.routeable === true));

    const started = f.service.procedureHostControl({ action: "start", input: f.args(routeable) });
    assert.equal(started.usage_status, "bound");
    let progress = f.service.procedureHostControl({ action: "next", input: {}, invocation_id: "invoke", scope });
    assert.equal(progress.next_tool, "craft_procedure_invocation_dispatch");
    const step = f.dispatch();
    assert.equal((step.work_item as JsonObject).kind, "step");
    f.service.procedureInvocationReport(f.proof(step));

    progress = f.service.procedureHostControl({ action: "next", input: {}, invocation_id: "invoke", scope });
    assert.equal(progress.next_tool, "craft_procedure_invocation_dispatch");
    const exit = f.dispatch();
    assert.equal((exit.work_item as JsonObject).kind, "exit");
    f.service.procedureInvocationReport(f.proof(exit));
    progress = f.service.procedureHostControl({ action: "next", input: {}, invocation_id: "invoke", scope });
    assert.equal(progress.usage_status, "completed");
    assert.equal(progress.next_tool, null);

    const usageEvidence = f.service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "Workflow execution completed",
      locator: "smoke://promoted-workflow-use", metadata: { context_receipt_id: contextReceipt.id, verdict: "passed" } }) as JsonObject;
    f.service.contextResolutionFeedback({ receipt_id: String(contextReceipt.id), outcome: "helpful", usage_stage: "used",
      evidence_ids: [String(usageEvidence.id)], asset_refs: [{ member: "experience", id: candidate.id }] });
    const history = f.service.workbenchExperienceFeedbackHistory({ asset_id: candidate.id, member: "experience" }) as JsonObject;
    assert.equal(history.current_weight, 1.2);
    assert.equal((history.counts as JsonObject).positive, 1);
  } finally { await f.close(); }
});

test("Host start cannot promote or bind a candidate; discovery covers promotion, progress and recovery", async () => {
  const f = await fixture();
  try {
    const p = f.service.procedureConfigurationSave({ procedure_id: "candidate", scope, title: "Engineering", procedure_kind: "graph", definition: experienceGraphTemplate("internet-product-engineering") }).procedure as JsonObject;
    assert.throws(() => f.service.procedureHostControl({ action: "start", input: { ...f.args(p), entry_id: "bug", exit_id: "diagnosis", subscenario_id: "diagnosis", input_refs: { request: "artifact:request" } } }), /routeable|release|available/i);
    assert.equal(f.store.count("procedure_invocation"), 0);
    const names = (discoverContextTools({ intent: "experience" }).tools as JsonObject[]).map(tool => tool.name);
    for (const tool of ["craft_procedure_gate", "craft_procedure_invocation_get", "craft_procedure_invocation_transition", "craft_procedure_invocation_resume"]) assert.ok(names.includes(tool));
  } finally { await f.close(); }
});
