import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import { ContextUsageWorkbench } from "../core/application/coordinators/context-usage.ts";
import { WorkflowDesignWorkbench, DESIGN_QUESTIONS } from "../core/application/coordinators/workflow-design.ts";
import { ContextResolutionKernel } from "../core/context-resolution.ts";
import { KnowledgeContribution } from "../capability/craft-knowledge/contribution.ts";
import { ExperienceContribution } from "../capability/craft-experience/contribution.ts";
import { payload } from "../core/digest.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-context-design-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("interview persists incomplete decisions, resumes with version checks and never creates authority", async () => {
  const f = await fixture(), designer = new WorkflowDesignWorkbench(f.store);
  try {
    const first = designer.save({ name: "Weekly report", scope: "project:demo", answers: { example: " ", trigger: "manual" } });
    let design = first.design as JsonObject;
    assert.equal(first.status, "needs_input"); assert.equal((first.next_question as JsonObject).key, "example");
    assert.match(String(first.markdown), /待确认/);
    const args = { design_id: design.id, scope: design.scope };
    assert.deepEqual(designer.get(args), first);
    assert.throws(() => designer.get({ ...args, scope: "project:other" }), /scope/);
    assert.throws(() => designer.save({ ...args, name: "edit", answers: {} }), /version conflict/);
    assert.throws(() => designer.save({ ...args, scope: "project:other", expected_version: 1, name: "edit", answers: {} }), /scope/);
    assert.throws(() => designer.save({ ...args, design_id: "missing", expected_version: 1, name: "edit", answers: {} }), /no longer/);
    const complete = designer.save({ ...args, expected_version: 1, name: "Report", answers: Object.fromEntries(DESIGN_QUESTIONS.map(([key]) => [key, `checked ${key}`])), routeable: true, execution_authorized: true });
    design = complete.design as JsonObject;
    assert.equal(design.version, 2); assert.equal(complete.status, "ready_for_review"); assert.equal(complete.next_question, null);
    assert.equal(design.routeable, false); assert.equal(complete.execution_authorized, false); assert.equal(complete.acceptance_status, "not_evaluated");
    assert.equal((f.store.get("workflow_design", String(design.id), 1).answers as JsonObject).trigger, "manual");
    assert.equal(f.store.count("experience_procedure"), 0); assert.equal(f.store.count("workflow_dag"), 0);
    assert.equal((designer.list({ scope: "project:other" }).designs as unknown[]).length, 0);
    assert.equal((designer.list({ scope: "project:demo" }).designs as unknown[]).length, 1);
    f.store.transaction(() => { for (let i = 0; i < 100; i++) designer.save({ name: `draft ${i}`, scope: "project:demo", answers: {} }); });
    assert.equal(designer.list({ scope: "project:demo" }).truncated, true);
    for (const patch of [{ name: "" }, { scope: "global" }, { name: "a".repeat(201) }, { answers: [] }, { answers: { unknown: "x" } }, { answers: { example: 1 } }, { answers: { example: "a".repeat(8001) } }, { answers: { example: "secret=abcdefghijkl" } }]) {
      assert.throws(() => designer.save({ name: "bad", scope: "project:demo", answers: {}, ...patch }));
    }
  } finally { await f.close(); }
});

test("usage is scoped, excludes privileged receipts, preserves unknown and bounded legacy history", async () => {
  const f = await fixture(), usage = new ContextUsageWorkbench(f.store), scope = { kind: "project", id: "demo" };
  try {
    assert.throws(() => usage.get({}), /scope_kind/);
    const args = { scope_kind: scope.kind, scope_id: scope.id };
    assert.equal(usage.get(args).count, 0);
    f.store.create("memory_ledger", "m", { scope, status: "revoked", source_id: "source", author: "user" });
    f.store.create("knowledge_claim", "k", { scope: "project:demo", status: "reviewed", proposed_by: "agent" });
    f.store.create("experience_procedure", "p", { scope: "project:demo", lifecycle: "routeable" });
    f.store.create("memory_ledger", "restricted", { scope, sensitivity: "restricted" });
    f.store.create("memory_ledger", "foreign", { scope: { kind: "project", id: "other" } });
    const record = { scope, scope_access: {}, memory_refs: ["m", "missing", "restricted", "foreign"].map(memory_id => ({ memory_id, memory_version: 1, content_digest: "digest", reason: "required" })), contributions: [
      { member: "knowledge", item_count: 1, references: [{ id: "k", version: 1, digest: "kd", reason: "reviewed" }] },
      { member: "experience", item_count: 1, references: [{ id: "p", version: 1, digest: "pd", reason: "routeable" }] },
      { member: "knowledge", item_count: 1 },
    ], retrieval_execution: { used: "keyword" }, explanation: {}, excluded_scopes: [] };
    f.store.create("context_resolution_receipt", "r", record);
    f.store.create("context_resolution_receipt", "history", { scope: null, canonical_scope: scope, execution_context: false });
    for (const [id, extra] of Object.entries({ foreign: { scope: { kind: "project", id: "other" } }, restricted: { allow_restricted: true }, principal: { scope_access: { principal_present: true } }, tenant: { scope_access: { tenant_present: true } }, invalid: { scope: [] } })) f.store.create("context_resolution_receipt", id, { ...record, ...extra });
    f.store.create("context_feedback", "good", { receipt_id: "r", outcome: "helpful", evidence_verified: true });
    f.store.create("context_feedback", "unknown", { receipt_id: "r", outcome: "helpful" });
    f.store.create("context_feedback", "other", { receipt_id: "other", evidence_verified: true });
    f.store.create("decision_context_gate", "gate", { context_receipt_id: "r", task_id: "task" });
    f.store.create("decision_context_gate", "other", { context_receipt_id: "other", task_id: "other" });
    const results = usage.get(args).receipts as JsonObject[];
    assert.equal(results.length, 2);
    const receipt = results.find(r => r.id === "r")!;
    assert.equal(receipt.followed, "unknown"); assert.equal(receipt.outcome_verified, true); assert.equal(receipt.legacy_references_incomplete, true);
    assert.deepEqual(receipt.task_ids, ["task"]);
    const references = receipt.references as JsonObject[];
    assert.equal(references[0]!.current_status, "revoked"); assert.equal(references[0]!.author, "user");
    assert.equal(references[4]!.author, "agent"); assert.equal(references[5]!.current_status, "routeable");
    assert.equal(references[1]!.current_status, "unavailable"); assert.equal(references[2]!.source_id, null);
    assert(!JSON.stringify(results).includes('"content":'));
    const retireArgs = { ...args, member: "memory", id: "m", expected_version: 1 };
    assert.deepEqual(usage.retire(retireArgs, (member, id, version) => ({ member, id, version })), { member: "memory", id: "m", version: 1 });
    assert.equal(usage.retire({ ...retireArgs, member: "knowledge", id: "k" }, () => ({ retired: true })).retired, true);
    for (const patch of [{ member: "experience" }, { scope_id: "other" }, { expected_version: 9 }, { id: "restricted" }]) assert.throws(() => usage.retire({ ...retireArgs, ...patch }, () => ({ unexpected: true })));
    f.store.transaction(() => { for (let i = 0; i < 101; i++) f.store.create("context_resolution_receipt", `extra-${i}`, { scope }); });
    assert.equal(usage.get(args).truncated, true); assert.equal(usage.get(args).count, 100);
  } finally { await f.close(); }
});

test("actual resolution pins knowledge and procedure references; revoked sources disappear next turn", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_source", "source", { status: "active", trust: "verified" });
    f.store.create("knowledge_claim", "k", { source_id: "source", scope: "project:demo", status: "reviewed", content: "export terminal", content_digest: "k1", evidence_ids: [] });
    f.store.create("experience_procedure", "p", { scope: "project:demo", lifecycle: "routeable", routeable: true, trigger: "export terminal", title: "export", content_digest: "p1", procedure_kind: "prompt", acceptance_ref: "file", scenario_signature: {} });
    const reader = new ContextResolutionKernel(f.store, [new KnowledgeContribution(f.store), new ExperienceContribution(f.store)]);
    const query = { query: "export", scope_kind: "project", scope_id: "demo" };
    const resolved = await reader.resolve(query), receipt = resolved.receipt as JsonObject;
    const refs = (receipt.contributions as JsonObject[]).flatMap(part => part.references as JsonObject[]);
    assert.deepEqual(refs.map(item => item.id).sort(), ["k", "p"]); assert(refs.every(item => item.version === 1));
    assert(!JSON.stringify(refs).includes("export terminal"));
    const source = f.store.get("knowledge_source", "source"); f.store.save("knowledge_source", "source", { ...payload(source), status: "revoked" });
    const procedure = f.store.get("experience_procedure", "p"); f.store.save("experience_procedure", "p", { ...payload(procedure), routeable: false });
    assert.equal(((await reader.resolve(query)).contributions as JsonObject[]).flatMap(part => part.items as JsonObject[]).length, 0);
    assert.equal(((await reader.resolve({ ...query, scope_id: "other" })).contributions as JsonObject[]).flatMap(part => part.items as JsonObject[]).length, 0);
    const service = new CraftService(f.store), app = new WorkbenchWebApp(service, "fixture", "http://127.0.0.1:4173");
    const request = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "fixture", body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(request("GET", "/api/workbench/context-usage?scope_kind=project&scope_id=demo").status, 200);
    assert.equal(request("GET", "/api/workbench/context-usage").status, 422);
    const saved = request("POST", "/api/workbench/workflow-designs", { name: "draft", scope: "project:demo", answers: {} });
    assert.equal(saved.status, 201); const id = JSON.parse(saved.body).design.id;
    assert.equal(request("GET", `/api/workbench/workflow-designs/${id}?scope=project:demo`).status, 200);
    assert.equal(request("GET", `/api/workbench/workflow-designs/${id}?scope=project:other`).status, 422);
    assert.equal(request("GET", "/api/workbench/workflow-designs?scope=project:demo").status, 200);
    assert.equal(request("GET", "/workbench/context-workflows.js").status, 200);
    f.store.create("memory_ledger", "retire-me", { scope: { kind: "project", id: "demo" }, status: "active", content: "export", source_id: "source", kind: "episodic", sensitivity: "internal" });
    assert.equal(request("POST", "/api/workbench/context-retire", { scope_kind: "project", scope_id: "demo", member: "memory", id: "retire-me", expected_version: 1 }).status, 200);
    assert.equal(f.store.get("memory_ledger", "retire-me").status, "revoked");
    assert.equal(request("POST", "/api/workbench/context-retire", { scope_kind: "project", scope_id: "demo", member: "knowledge", id: "k", expected_version: 1 }).status, 200);
    assert.equal(f.store.get("knowledge_claim", "k").status, "expired");
  } finally { await f.close(); }
});
