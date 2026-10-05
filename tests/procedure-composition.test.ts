import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { KnowledgeMemoryBundleKernel } from "../core/knowledge-memory-bundle.ts";
import { stableDigest } from "../core/digest.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { productSurfaceOf } from "../core/interfaces/mcp/product-launch.ts";
import { validateProcedureComposition } from "../capability/craft-experience/procedure-composition.ts";
import { ProcedureDefinitionStore, type ProcedureDefinition, type ProcedureDefinitionRef } from "../capability/craft-experience/procedure-definition.ts";

function spec(): JsonObject {
  return { steps: [{ id: "review", type: "instruction", instruction: "Review the supplied diff; findings are a valid report.", side_effect: "read_only", requires: ["diff"], provides: ["report"] }], composition: {
    entries: [{ id: "review", title: "Code Review", required_inputs: ["diff"], preconditions: [], routes: [{ exit_id: "reviewed", step_ids: ["review"] }] }],
    exits: [{ id: "reviewed", title: "审查完成", required_outputs: ["report"], acceptance_ref: "acceptance:review-report" }],
  } };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-composition-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store), mcp = new McpServer(service, productSurfaceOf("experience"));
  store.create("evidence", "e", { confidence: "confirmed" });
  let n = 0;
  function promote(procedure: JsonObject, stage: string): JsonObject {
    const evidence_ids: string[] = [];
    for (const entry of (procedure.entrypoints ?? []) as JsonObject[]) for (const route of entry.routes as JsonObject[]) {
      const id = `${procedure.id}-${stage}-${entry.id}-${route.exit_id}`;
      store.create("evidence", id, { confidence: "confirmed", metadata: { procedure_definition_digest: procedure.definition_digest, entry_id: entry.id, exit_id: route.exit_id, stage, status: "passed" } });
      evidence_ids.push(id);
    }
    return service.experienceProcedureGate({ procedure_id: procedure.id, stage, passed: true, evidence_ids: evidence_ids.length ? evidence_ids : ["e"] });
  }
  function create(value = spec(), extra: JsonObject = {}): JsonObject {
    const id = `procedure-${++n}`;
    store.create("workflow_evolution_request", `request-${n}`, { scenario_key: "product-development", scenario_signature: { domain: "coding" }, observation_refs: [{ source: { scope: "project:craft" }, evidence_ids: ["e"] }], output_contract_ref: "acceptance:delivery" });
    store.create("workflow_evolution_proposal", `proposal-${n}`, { request_id: `request-${n}`, request_version: 1, name: id, description: "Product development", procedure_kind: "workflow", inputs: [], ...value });
    service.experienceProcedureDraft({ procedure_id: id, proposal_id: `proposal-${n}`, ...extra });
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) promote(store.get("experience_procedure", id), stage);
    return store.get("experience_procedure", id);
  }
  function args(procedure: JsonObject, extra: JsonObject = {}): JsonObject { return { procedure_id: procedure.id, procedure_version: procedure.version, scope: "project:craft", entry_id: "review", exit_id: "reviewed", input_refs: { diff: "artifact:diff" }, allowed_effects: ["read_only"], ...extra }; }
  return { root, store, service, mcp, create, args, promote, async dispose() { store.close(); await rm(root, { recursive: true, force: true }); } };
}
function call(child: JsonObject, id = "review", overrides: JsonObject = {}): JsonObject {
  return { id, type: "procedure_call", side_effect: "read_only", requires: ["diff"], provides: ["report"], procedure_id: child.id, procedure_version: child.version, definition_digest: child.definition_digest, entry_id: "review", exit_id: "reviewed", input_bindings: { diff: "diff" }, output_bindings: { report: "report" }, ...overrides };
}
function composedCall(child: JsonObject, overrides: JsonObject = {}): JsonObject { return { ...spec(), steps: [call(child, "review", overrides)] }; }

// This is the public seam: submit, promote and plan through the standalone MCP.
test("full development and standalone review select explicit routes, preserving child acceptance and no execution", async () => {
  const f = await fixture();
  try {
    const child = f.create();
    const parent = { steps: [
      { id: "implement", type: "instruction", instruction: "Implement the approved requirement", side_effect: "local_write", requires: ["requirement"], provides: ["diff"] },
      call(child),
      { id: "package", type: "instruction", instruction: "Prepare delivery evidence", side_effect: "read_only", requires: ["report"], provides: ["delivery"] },
    ], composition: { entries: [
      { id: "develop", title: "完整需求开发", required_inputs: ["requirement"], preconditions: ["requirement-approved"], routes: [{ exit_id: "reviewed", step_ids: ["implement", "review"] }, { exit_id: "delivered", step_ids: ["implement", "review", "package"] }] },
      { id: "review", title: "Code Review", required_inputs: ["diff"], preconditions: [], routes: [{ exit_id: "reviewed", step_ids: ["review"] }] },
    ], exits: [...(spec().composition as JsonObject).exits as JsonObject[], { id: "delivered", title: "交付包完成", required_outputs: ["delivery"], acceptance_ref: "acceptance:delivery" }] } };
    for (const id of ["a", "b"]) await f.mcp.handlers.craft_experience_observe({ observation_id: id, scenario_key: "coding-product", source_kind: "outcome", source_id: id, source_digest: `digest:${id}`, scope: "project:craft", outcome: "passed", evidence_ids: ["e"], sanitized: true });
    const { request } = await f.mcp.handlers.craft_experience_procedure_draft({ scenario_key: "coding-product", design_axes: ["orchestration"], hypothesis: "Reuse review with an explicit entry", output_contract_ref: "acceptance:delivery" }) as { request: JsonObject };
    const submit = { request_id: request.id, proposal_id: "product-proposal", workflow_id: "product", name: "Product development", description: "Entry contracts", inputs: [], ...parent };
    const result = await f.mcp.handlers.craft_experience_procedure_submit(submit);
    assert.equal(result.workflow, null);
    const candidate = result.procedure as JsonObject;
    assert.equal(candidate.routeable, false);
    assert.equal((candidate.entrypoints as JsonObject[]).length, 2);
    assert.equal((await f.mcp.handlers.craft_experience_procedure_submit(submit)).idempotent, true);
    assert.throws(() => f.service.experienceProcedurePlan(f.args(candidate)), /unavailable/);
    assert.throws(() => f.service.experienceProcedureGate({ procedure_id: candidate.id, stage: "shadow", passed: true, evidence_ids: ["e"] }), /requires route Evidence/);
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) f.promote(candidate, stage);
    assert.throws(() => f.service.workflowEvolutionProposalSubmit({ ...submit, steps: [...parent.steps].reverse() }), /idempotency conflict/);
    const procedure = f.store.get("experience_procedure", String(candidate.id));
    const review = await f.mcp.handlers.craft_procedure_plan(f.args(procedure));
    assert.equal(review.execution_authorized, false);
    assert.equal(review.expanded_step_count, 2);
    const recalled = await f.mcp.handlers.craft_context_resolution_resolve({ scope_kind: "project", scope_id: "craft", query: "Code Review", max_chars: 15000 });
    const contribution = (recalled.contributions as JsonObject[]).find(item => item.member === "experience")!;
    assert((contribution.items as JsonObject[]).some(item => item.procedure_id === procedure.id && Array.isArray(item.entrypoints)));
    assert.equal((review.plan as JsonObject).acceptance_status, "not_evaluated");
    assert.equal((((review.plan as JsonObject).steps as JsonObject[])[0]!.child_plan as JsonObject).acceptance_status, "not_evaluated");
    assert.deepEqual(await f.mcp.handlers.craft_procedure_plan(f.args(procedure)), review);
    f.store.create("evidence", "approved", { confidence: "bounded", metadata: { scope: "project:craft", condition_ref: "requirement-approved" } });
    const fullArgs = f.args(procedure, { entry_id: "develop", exit_id: "delivered", input_refs: { requirement: "artifact:requirement" }, allowed_effects: ["read_only", "local_write"], precondition_evidence: { "requirement-approved": "approved" } });
    const full = await f.mcp.handlers.craft_procedure_plan(fullArgs);
    assert.equal(full.expanded_step_count, 4);
    assert.notEqual(full.plan_digest, review.plan_digest);
    assert.deepEqual(((full.plan as JsonObject).steps as JsonObject[]).map(step => step.id), ["implement", "review", "package"]);
    assert.equal((await f.mcp.handlers.craft_procedure_plan({ ...fullArgs, exit_id: "reviewed" })).expanded_step_count, 3);
    assert.throws(() => f.service.experienceProcedurePlan({ ...fullArgs, precondition_evidence: {} }), /Missing precondition/);
    assert.throws(() => f.service.experienceProcedurePlan(f.args(procedure, { exit_id: "delivered" })), /not reachable/);
    const exported = f.service.experienceProcedureSkillExport({ procedure_id: procedure.id }).export as JsonObject;
    assert.deepEqual(JSON.parse(await readFile(String(exported.definition_path), "utf8")).definition.composition, parent.composition);
    assert.throws(() => f.service.experienceProcedureDraft({ proposal_id: "product-proposal", procedure_kind: "graph" }), /requires workflow/);
    assert.throws(() => f.service.procedureAutomationSave({ procedure_id: procedure.id, workspace: f.root, inputs: {}, verifier_step_id: "review" }), /explicit Entry\/Exit/);
  } finally { await f.dispose(); }
});

test("composition rejects ambiguous and unreachable contracts before persistence", () => {
  const cases: [string, (s: any) => void, RegExp][] = [
    ["object", s => s.composition = null, /object/],
    ["array object", s => s.composition = [], /object/],
    ["step", s => s.steps[0] = false, /object/],
    ["missing", s => s.steps[0].id = " ", /non-empty/],
    ["type", s => s.steps[0].type = 1, /non-empty/],
    ["effect", s => s.steps[0].side_effect = "admin", /side_effect/],
    ["list", s => s.steps = null, /items/],
    ["empty", s => s.steps = [], /items/],
    ["limit", s => s.steps = Array(101).fill(s.steps[0]), /items/],
    ["duplicate", s => s.steps.push(s.steps[0]), /duplicates/],
    ["inputs", s => s.steps[0].requires = ["diff", "diff"], /duplicates/],
    ["unknown step", s => s.composition.entries[0].routes[0].step_ids = ["other"], /Unknown step/],
    ["unknown exit", s => s.composition.entries[0].routes[0].exit_id = "other", /Unknown exit/],
    ["missing dependency", s => s.steps[0].requires = ["missing"], /missing input/],
    ["overwrite", s => s.steps[0].provides = ["diff"], /overwrites/],
    ["missing output", s => s.composition.exits[0].required_outputs = ["delivery"], /cannot deliver/],
    ["unused step", s => s.steps.push({ ...s.steps[0], id: "unused" }), /unreachable/],
    ["unused exit", s => s.composition.exits.push({ ...s.composition.exits[0], id: "unused" }), /unreachable/],
    ["duplicate route", s => s.composition.entries[0].routes.push(s.composition.entries[0].routes[0]), /duplicates/],
    ["duplicate entry", s => s.composition.entries.push(s.composition.entries[0]), /duplicates/],
  ];
  for (const [label, change, pattern] of cases) { const value = spec(); change(value); assert.throws(() => validateProcedureComposition("workflow", value.composition, value.steps), pattern, label); }
  assert.throws(() => validateProcedureComposition("graph", {}, []), /requires workflow/);
  const base = { id: "child", version: 5, definition_digest: `sha256:${"a".repeat(64)}` };
  for (const [change, pattern] of [
    [{ procedure_version: 0 }, /positive integer/], [{ procedure_version: 1.5 }, /positive integer/], [{ definition_digest: "bad" }, /definition_digest/],
    [{ input_bindings: { diff: "unknown" } }, /bindings/], [{ output_bindings: {} }, /bindings/], [{ output_bindings: [] }, /object/],
  ] as [JsonObject, RegExp][]) { const value = composedCall(base, change); assert.throws(() => validateProcedureComposition("workflow", value.composition, value.steps), pattern); }
});

test("plans fail closed for identity, scope, input, effects, evidence and integrity", async () => {
  const f = await fixture();
  try {
    const p = f.create(spec(), { preconditions: ["approved"], allowed_effects: ["read"] });
    const args = f.args(p, { precondition_evidence: { approved: "condition" } });
    f.store.create("evidence", "condition", { confidence: "confirmed", metadata: { scope: "project:craft", condition_ref: "approved" } });
    assert.equal(f.service.experienceProcedurePlan(args).expanded_step_count, 1);
    for (const [extra, pattern] of [
      [{ procedure_version: 1 }, /drifted/], [{ procedure_version: "5" }, /positive integer/], [{ scope: "project:other" }, /denied/],
      [{ entry_id: "missing" }, /Unknown Procedure Entry/], [{ input_refs: {} }, /exactly match/], [{ input_refs: { other: "artifact:diff" } }, /exactly match/],
      [{ input_refs: { diff: "ref", extra: "ref" } }, /exactly match/], [{ allowed_effects: ["local_write"] }, /effect denied/],
      [{ precondition_evidence: { approved: "e" } }, /metadata/], [{ precondition_evidence: {} }, /Missing precondition/],
    ] as [JsonObject, RegExp][]) assert.throws(() => f.service.experienceProcedurePlan({ ...args, ...extra }), pattern);
    for (const record of [
      { confidence: "unconfirmed", metadata: { scope: "project:craft", condition_ref: "approved" } },
      { confidence: "confirmed", metadata: { scope: "project:other", condition_ref: "approved" } },
      { confidence: "confirmed", metadata: { scope: "project:craft", condition_ref: "wrong" } },
    ]) { f.store.save("evidence", "condition", record); assert.throws(() => f.service.experienceProcedurePlan(args), /not bound/); }
    const privateP = f.create(spec(), { scope_envelope: { audience: { mode: "private", principal_ids: ["owner"] }, tenant_id: "tenant" } });
    assert.throws(() => f.service.experienceProcedurePlan(f.args(privateP)), /denied/);
    assert.equal(f.service.experienceProcedurePlan(f.args(privateP, { principal_id: "owner", tenant_id: "tenant" })).expanded_step_count, 1);
    const noRef = f.store.save("experience_procedure", String(privateP.id), { ...privateP, definition_ref: null });
    assert.throws(() => f.service.experienceProcedurePlan(f.args(noRef, { principal_id: "owner", tenant_id: "tenant" })), /no checked definition/);
    const intact = f.create(); const path = (intact.definition_ref as JsonObject).path as string;
    const raw = JSON.parse(await readFile(path, "utf8")); raw.definition.steps[0].instruction = "tampered";
    await writeFile(path, JSON.stringify(raw));
    assert.throws(() => f.service.experienceProcedurePlan(f.args(intact)), /digest drifted/);
    const restrictive = f.create(spec(), { allowed_effects: ["local_write"] });
    assert.throws(() => f.service.experienceProcedurePlan(f.args(restrictive)), /effect denied/);
    const emptyLegacy = f.create({ inputs: null, steps: null });
    const emptyDefinition = new ProcedureDefinitionStore(f.store.paths).read(emptyLegacy.definition_ref as unknown as ProcedureDefinitionRef);
    assert.deepEqual(emptyDefinition.definition, { inputs: [], steps: [] });
    const legacy = f.create({ steps: [{ id: "review", type: "assertion" }] });
    assert.throws(() => f.service.experienceProcedurePlan(f.args(legacy)), /composition must be an object/);
  } finally { await f.dispose(); }
});

test("child calls pin versions and digest, propagate permission limits and reject recursion/expansion", async () => {
  const f = await fixture();
  try {
    const child = f.create();
    const parent = f.create(composedCall(child));
    assert.equal(f.service.experienceProcedurePlan(f.args(parent)).expanded_step_count, 2);
    const wrongOutput = f.create(composedCall(child, { output_bindings: { report: "not-public" } }));
    assert.throws(() => f.service.experienceProcedurePlan(f.args(wrongOutput)), /undeclared child output/);
    const wrongDigest = f.create(composedCall(child, { definition_digest: `sha256:${"a".repeat(64)}` }));
    assert.throws(() => f.service.experienceProcedurePlan(f.args(wrongDigest)), /digest drifted/);
    f.service.experienceProcedureGate({ procedure_id: child.id, stage: "canary", passed: false, evidence_ids: ["e"] });
    assert.throws(() => f.service.experienceProcedurePlan(f.args(parent)), /revoked/);
    const mutable = f.create();
    const definitions = new ProcedureDefinitionStore(f.store.paths);
    const definition = definitions.read(mutable.definition_ref as unknown as ProcedureDefinitionRef);
    const cyclic = { ...definition, procedure_version: 2, definition: composedCall(mutable) } as ProcedureDefinition;
    const ref = definitions.write(cyclic, "cyclic");
    const recursive = f.store.save("experience_procedure", String(mutable.id), { ...mutable, definition_ref: ref });
    assert.throws(() => f.service.experienceProcedurePlan(f.args(recursive)), /Recursive/);
    let nested = f.create();
    for (let n = 0; n < 8; n++) nested = f.create(composedCall(nested));
    assert.throws(() => f.service.experienceProcedurePlan(f.args(nested)), /depth exceeds/);
    const reusable = f.create(), repeated = spec();
    repeated.steps = Array.from({ length: 51 }, (_, n) => call(reusable, `call${n}`, { provides: [`report${n}`], output_bindings: { [`report${n}`]: "report" } }));
    ((repeated.composition as any).entries[0].routes[0]).step_ids = (repeated.steps as JsonObject[]).map(s => s.id);
    (repeated.composition as any).exits[0].required_outputs = ["report50"];
    const big = f.create(repeated);
    assert.throws(() => f.service.experienceProcedurePlan(f.args(big)), /exceeds 100/);
    const writing = spec(); (writing.steps as JsonObject[])[0]!.side_effect = "local_write";
    const writingChild = f.create(writing);
    const readonlyCall = f.create(composedCall(writingChild), { allowed_effects: ["read_only", "local_write"] });
    assert.throws(() => f.service.experienceProcedurePlan(f.args(readonlyCall, { allowed_effects: ["read_only", "local_write"] })), /effect denied/);
  } finally { await f.dispose(); }
});

test("composition rejects disguised calls, ambiguous binding names and colliding plan paths", async () => {
  const f = await fixture();
  try {
    for (const step of [
      { ...call({ id: "missing", version: 1, definition_digest: `sha256:${"a".repeat(64)}` }), type: " procedure_call " },
      { ...(spec().steps as JsonObject[])[0], id: "review/child" },
      { ...(spec().steps as JsonObject[])[0], id: " review" },
    ]) assert.throws(() => validateProcedureComposition("workflow", spec().composition, [step]), /whitespace|path separators/);
    const p = f.create();
    assert.throws(() => f.service.experienceProcedurePlan(f.args(p, { input_refs: { diff: "artifact:a", " diff ": "artifact:b" } })), /whitespace/);
    const read = await f.mcp.handlers.craft_procedure_list({ scope: "project:craft" });
    assert.equal((read.procedures as JsonObject[]).length, 1);
    const advanced = new McpServer(f.service, "component-experience");
    assert.equal(((await advanced.handlers.craft_experience_procedure_projection_list({ scope: "project:craft" })).procedures as JsonObject[]).length, 1);
    for (const [server, name] of [[f.mcp, "craft_procedure_list"], [advanced, "craft_experience_procedure_projection_list"]] as const) {
      const response = await server.handle({ jsonrpc: "2.0", id: "scope-test", method: "tools/call", params: { name, arguments: { scope: "project:craft" } } }) as JsonObject;
      assert.equal((response.result as JsonObject).isError, false);
      const invalid = await server.handle({ jsonrpc: "2.0", id: "invalid-scope", method: "tools/call", params: { name, arguments: { scope: {} } } }) as JsonObject;
      assert.equal((invalid.result as JsonObject).isError, true);
    }
    const drafted = await advanced.handle({ jsonrpc: "2.0", id: "typed-draft", method: "tools/call", params: { name: "craft_experience_procedure_projection_draft", arguments: { proposal_id: p.proposal_id, scenario_signature: { domain: "review" }, preconditions: ["current-workspace"] } } }) as JsonObject;
    assert.equal((drafted.result as JsonObject).isError, false);
    const gate = advanced.tools.find(tool => tool.name === "craft_experience_procedure_gate")!;
    assert.equal(((gate.inputSchema.properties as JsonObject).passed as JsonObject).type, "boolean");
    assert.equal(((gate.inputSchema.properties as JsonObject).expected_version as JsonObject).type, "integer");
    const observed = f.mcp.tools.map(tool => tool.name).filter(name => name !== "craft_procedure_plan");
    const diagnosis = await f.mcp.handlers.craft_component_diagnose({ component: "experience", observed_tool_names: observed });
    assert.equal(diagnosis.host_attachment, "bundle_or_surface_mismatch");
    assert.deepEqual(diagnosis.missing_tools, ["craft_procedure_plan"]);
  } finally { await f.dispose(); }
});

test("promoted parent/child Procedures remain pinned and plannable after portable import", async () => {
  const source = await fixture(), target = await fixture();
  try {
    const child = source.create(), parent = source.create(composedCall(child));
    const bundle = new KnowledgeMemoryBundleKernel(source.store).export({ scope_kind: "project", scope_id: "craft" }).bundle as JsonObject;
    const receiver = new KnowledgeMemoryBundleKernel(target.store);
    assert.equal(receiver.verify({ bundle }).valid, true);
    receiver.importApply({ bundle, approved: true });
    const imported = target.store.get("experience_procedure", String(parent.id));
    assert.equal(imported.version, parent.version);
    assert.equal((imported.definition_ref as JsonObject).procedure_version, 1);
    const originalPlan = source.service.experienceProcedurePlan(source.args(parent));
    assert.deepEqual(target.service.experienceProcedurePlan(target.args(imported)), originalPlan);
    const ref = imported.definition_ref as JsonObject;
    assert.match(String(ref.path), new RegExp(target.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // Rehash hostile envelopes so this exercises semantic identity, not just transport checksums.
    for (const mutation of ["id", "definition-version", "record-version", "digest"]) {
      const bad = structuredClone(bundle);
      const record = (bad.records as JsonObject[]).find(item => item.kind === "experience_procedure" && item.id === parent.id)!;
      const definition = record.procedure_definition as JsonObject, payload = record.payload as JsonObject;
      if (mutation === "id") definition.procedure_id = "foreign";
      if (mutation === "definition-version") (payload.definition_ref as JsonObject).procedure_version = 99;
      if (mutation === "record-version") { definition.procedure_version = 99; (payload.definition_ref as JsonObject).procedure_version = 99; }
      if (mutation === "digest") (payload.definition_ref as JsonObject).digest = "sha256:changed";
      record.digest = stableDigest({ kind: record.kind, id: record.id, version: record.version, payload, content_body: record.content_body, procedure_definition: definition });
      bad.digest = stableDigest({ format: bad.format, schema_version: bad.schema_version, scope: bad.scope, device_id: bad.device_id, export_id: bad.export_id, cursor: bad.cursor, records: bad.records });
      const rejectTarget = await fixture();
      try { assert.throws(() => new KnowledgeMemoryBundleKernel(rejectTarget.store).importApply({ bundle: bad, approved: true }), /definition identity/); }
      finally { await rejectTarget.dispose(); }
    }
  } finally { await source.dispose(); await target.dispose(); }
});
