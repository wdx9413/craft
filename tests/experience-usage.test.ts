import assert from "node:assert/strict";
import test from "node:test";
import { fixture, scope } from "./helpers/procedure-invocation-fixture.ts";
import { ExperienceContribution } from "../capability/craft-experience/contribution.ts";
import { experienceGraphTemplate } from "../capability/craft-experience/procedure-templates.ts";
import { discoverContextTools } from "../core/mcp/context-tools.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

test("graph diagnosis distinguishes scoped draft, candidate and qualified release; Chinese subscenarios are recallable", async () => {
  const f = await fixture();
  try {
    const inspect = () => f.service.experienceGraphInspect({ action: "diagnose", scope, graph_id: "engineering" });
    assert.equal(inspect().reason, "no_accessible_graph_in_scope");
    const saved = f.service.experienceGraphEdit({ action: "save", scope, graph_id: "engineering", template_id: "internet-product-engineering" });
    assert.equal((inspect().drafts as JsonObject[])[0].usage_status, "draft_not_submitted");
    let p = f.service.experienceGraphEdit({ action: "submit", scope, graph_id: "engineering", expected_draft_digest: saved.draft_digest }).procedure as JsonObject;
    assert.equal((inspect().graphs as JsonObject[])[0].usage_status, "no_promoted_release");
    const reader = new ExperienceContribution(f.store);
    const request = { query: "诊断", scope_kind: "project", scope_id: "invocation", max_items: 10, max_chars: 20000 } as const;
    const candidate = await reader.contribute(request);
    assert.equal(candidate.items.length, 0); assert.equal(candidate.diagnostics?.reason, "no_promoted_release");
    // Fixture-only gate proofs exercise the same promotion contract as the runtime tests.
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
      const ids: string[] = [];
      for (const entry of p.entrypoints as JsonObject[]) for (const route of entry.routes as JsonObject[]) {
        const id = `${stage}:${route.subscenario_id}`; ids.push(id);
        f.store.create("evidence", id, { confidence: "confirmed", metadata: { procedure_definition_digest: p.definition_digest,
          entry_id: entry.id, exit_id: route.exit_id, subscenario_id: route.subscenario_id, stage, status: "passed" } });
      }
      p = f.service.experienceProcedureGate({ procedure_id: p.id, stage, passed: true, evidence_ids: ids }).procedure as JsonObject;
    }
    const recalled = await reader.contribute(request);
    assert.equal(recalled.items.length, 1); assert.equal(recalled.items[0].execution_started, false);
    assert.equal(recalled.items[0].host_next_step, "match_graph_then_plan_and_bind");
    assert.equal((inspect().graphs as JsonObject[])[0].usage_status, "available_requires_host_binding");
    assert.equal((await reader.contribute({ ...request, scope_id: "other" })).items.length, 0);
    const hidden = f.service.experienceGraphInspect({ action: "diagnose", scope: "project:other", graph_id: "engineering" });
    assert.equal((hidden.graphs as JsonObject[]).length, 0);
    const result = await f.service.contextResolutionResolve({ query: "诊断", scope_kind: "project", scope_id: "invocation", members: ["experience"] });
    assert.equal(((result.contributions as JsonObject[])[0].diagnostics as JsonObject).reason, "recalled_not_bound");
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
