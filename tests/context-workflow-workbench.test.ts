import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import { ContextUsageWorkbench } from "../core/application/coordinators/context-usage.ts";
import { WorkflowDesignWorkbench, DESIGN_QUESTIONS, rollupFeedbackByDay } from "../core/application/coordinators/workflow-design.ts";
import { ContextResolutionKernel } from "../core/context-resolution.ts";
import { KnowledgeContribution } from "../capability/craft-knowledge/contribution.ts";
import { ExperienceContribution } from "../capability/craft-experience/contribution.ts";
import { payload } from "../core/digest.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-context-design-"));
  const store = await new CraftStore(craftPaths(root)).open();
  new CraftService(store).scopeAliasBind({ scope_kind: "project", scope_id: "project:demo", alias_kind: "path", alias: root });
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
    const otherRoot = join((f.store.paths.root), "other-project");
    await mkdir(otherRoot);
    f.store.create("scope_alias", "context-workbench-other", { status: "active", alias_kind: "path", alias: otherRoot,
      scope: { kind: "project", id: "other" } });
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

test("actual resolution rejects unverified Knowledge labels and pins routeable Experience references", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_source", "source", { status: "active", trust: "verified", scope: "project:demo" });
    const evidence = f.store.create("evidence", "knowledge-context-evidence", { status: "verified", confidence: "confirmed", claim: "export terminal is the project command" });
    f.store.create("knowledge_claim", "k", { source_id: "source", scope: "project:demo", status: "reviewed", content: "export terminal", content_digest: "k1", evidence_ids: [evidence.id] });
    f.store.create("experience_procedure", "p", { scope: "project:demo", lifecycle: "routeable", routeable: true, trigger: "export terminal", title: "export", content_digest: "p1", procedure_kind: "prompt", acceptance_ref: "file", scenario_signature: {} });
    const reader = new ContextResolutionKernel(f.store, [new KnowledgeContribution(f.store), new ExperienceContribution(f.store)]);
    const query = { query: "export", scope_kind: "project", scope_id: "demo" };
    const resolved = await reader.resolve(query), receipt = resolved.receipt as JsonObject;
    const refs = (receipt.contributions as JsonObject[]).flatMap(part => part.references as JsonObject[]);
    assert.deepEqual(refs.map(item => item.id).sort(), ["p"], "a reviewed label without managed promotion proof is not executable Knowledge"); assert(refs.every(item => item.version === 1));
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
    assert.equal(request("GET", "/workbench/context-workflows.js").status, 404);
    f.store.create("memory_ledger", "retire-me", { scope: { kind: "project", id: "demo" }, status: "active", content: "export", source_id: "source", kind: "episodic", sensitivity: "internal" });
    assert.equal(request("POST", "/api/workbench/context-retire", { scope_kind: "project", scope_id: "demo", member: "memory", id: "retire-me", expected_version: 1 }).status, 200);
    assert.equal(f.store.get("memory_ledger", "retire-me").status, "revoked");
    const retiredKnowledge = request("POST", "/api/workbench/context-retire", { scope_kind: "project", scope_id: "demo", member: "knowledge", id: "k", expected_version: 1 });
    assert.equal(retiredKnowledge.status, 200, retiredKnowledge.body);
    assert.equal(f.store.get("knowledge_claim", "k").status, "expired");
  } finally { await f.close(); }
});
test("capture precipitates a richer draft from the task goal, acceptance and decisions", async () => {
  const f = await fixture(), designer = new WorkflowDesignWorkbench(f.store);
  try {
    const task = f.store.create("task", "task-cap", { title: "交付周报", goal: "把每周指标汇总成一份可复用的周报" });
    const trial = f.store.create("trial", "trial-cap", { task_id: "task-cap", subject_type: "acceptance_plan", subject_id: "plan-cap", subject_version: 1, status: "completed" });
    const evidence = f.store.create("evidence", "evidence-cap", { source_type: "program", claim: "文件存在", confidence: "confirmed", artifact_id: "artifact-cap", locator: "report.md", observed_at: new Date().toISOString() });
    f.store.create("outcome", "outcome_trial-cap", { trial_id: "trial-cap", verdict: "passed", summary: "验收通过", evidence_ids: ["evidence-cap"], created_at: new Date().toISOString() });
    f.store.create("acceptance_assessment", "assess-cap", { plan_id: "plan-cap", task_id: "task-cap", status: "passed", checked: 1, total: 1, missing: [], failed: [], blocked: [], created_at: new Date().toISOString() });
    f.store.create("attention_item", "attn-cap", { task_id: "task-cap", status: "resolved", reason: "需人工确认指标口径", action: "confirm", priority: 80 });
    const result = designer.capture({ task_id: "task-cap", name: "周报沉淀", scenario_key: "weekly_report" });
    assert.equal(result.kind, "success");
    const answers = (result.design as JsonObject).answers as Record<string, string>;
    assert.match(answers.trigger, /每周指标汇总/);
    assert.match(answers.steps, /验收状态：passed/);
    assert.match(answers.failure, /需人工判断的节点：需人工确认指标口径/);
    assert.match(answers.samples, /达成「把每周指标汇总成一份可复用的周报/);
  } finally { await f.close(); }
});
test("experience overview surfaces the recall-feedback weight and pending corrections", async () => {
  const f = await fixture(), designer = new WorkflowDesignWorkbench(f.store);
  try {
    f.store.create("experience_procedure", "proc-1", { scope: "project:demo", lifecycle: "routeable", procedure_kind: "workflow", routeable: true });
    f.store.create("context_correction_task", "corr-1", { status: "pending_review", outcome: "incorrect",
      asset_ref: { member: "experience", id: "proc-1" } });
    const overview = designer.overview({ scope: "project:demo" }) as JsonObject;
    const procedure = (overview.procedures as JsonObject[]).find((item) => item.id === "proc-1")!;
    assert.equal(procedure.recall_weight, 0.8);
    assert.equal(procedure.recall_penalty, 0.8);
    assert.equal(procedure.pending_corrections, 1);
    assert.equal(procedure.helpful_signals, 0);
  } finally { await f.close(); }
});
test("recall receipts audit trail lists each recall and its feedback verdicts", async () => {
  const f = await fixture(), designer = new WorkflowDesignWorkbench(f.store);
  try {
    f.store.create("context_resolution_receipt", "receipt-1", {
      scope: { kind: "project", id: "demo" },
      contributions: [{ member: "experience", item_count: 1, references: [{ id: "proc-1", version: 1, digest: "d", reason: "routeable" }] }],
      created_at: "2026-11-05T10:00:00Z",
    });
    f.store.create("context_resolution_receipt", "receipt-2", {
      scope: { kind: "project", id: "demo" },
      contributions: [{ member: "experience", item_count: 1, references: [{ id: "proc-other", version: 1, digest: "d", reason: "routeable" }] }],
      created_at: "2026-11-05T11:00:00Z",
    });
    f.store.create("context_feedback", "feedback-1", { receipt_id: "receipt-1", outcome: "helpful", evidence_verified: true,
      usage_stage: "used", asset_refs: [{ member: "experience", id: "proc-1", version: 1, digest: "d" }], created_at: "2026-11-05T10:05:00Z" });
    f.store.create("context_feedback", "feedback-other", { receipt_id: "receipt-1", outcome: "irrelevant", evidence_verified: false,
      usage_stage: "shown", asset_refs: [{ member: "knowledge", id: "claim-1", version: 1, digest: "d" }], created_at: "2026-11-05T10:06:00Z" });
    const result = designer.recallReceipts({ asset_id: "proc-1" }) as JsonObject;
    const receipts = result.receipts as JsonObject[];
    assert.equal(receipts.length, 1);
    const row = receipts[0]!;
    assert.equal(row.id, "receipt-1");
    const feedback = row.feedback as JsonObject[];
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0]!.outcome, "helpful");
    assert.equal(feedback[0]!.evidence_verified, true);
    assert.equal(feedback[0]!.usage_stage, "used");
    assert.throws(() => designer.recallReceipts({ asset_id: "proc-1", limit: 0 }), /limit/u);
    assert.throws(() => designer.recallReceipts({ asset_id: "proc-1", member: "plugin" }), /member/u);
  } finally { await f.close(); }
});
test("recall receipts works for memory assets through the same member-aware projection", async () => {
  const f = await fixture(), designer = new WorkflowDesignWorkbench(f.store);
  try {
    f.store.create("context_resolution_receipt", "memory-receipt", {
      scope: { kind: "project", id: "demo" },
      contributions: [{ member: "memory", item_count: 1, references: [{ id: "memory-1", version: 1, digest: "d", reason: "required" }] }],
      created_at: "2026-11-05T10:00:00Z",
    });
    f.store.create("context_feedback", "memory-feedback", { receipt_id: "memory-receipt", outcome: "helpful", evidence_verified: false,
      usage_stage: "shown", memory_refs: [{ memory_id: "memory-1", memory_version: 1, content_digest: "d" }],
      asset_refs: [{ member: "memory", id: "memory-1", version: 1, digest: "d" }], created_at: "2026-11-05T10:05:00Z" });
    const result = designer.recallReceipts({ asset_id: "memory-1", member: "memory" }) as JsonObject;
    const receipts = result.receipts as JsonObject[];
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.id, "memory-receipt");
    const feedback = receipts[0]!.feedback as JsonObject[];
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0]!.outcome, "helpful");
  } finally { await f.close(); }
});
test("knowledge view and memory catalog surface the recall-feedback weight", async () => {
  const f = await fixture(), designer = new WorkflowDesignWorkbench(f.store);
  try {
    f.store.create("knowledge_claim", "claim-1", { content: "项目使用 Node.js", status: "reviewed", kind: "fact", scope: "project:demo" });
    f.store.create("memory_item", "memory-1", { content: "使用 pnpm", status: "active", kind: "preference", scope: "project:demo" });
    f.store.create("context_correction_task", "corr-k", { status: "confirmed", outcome: "stale",
      asset_ref: { member: "knowledge", id: "claim-1" } });
    const service = new CraftService(f.store);
    const view = service.knowledgeWorkbenchView({ limit: 10 }) as JsonObject;
    const claim = (view.claims as JsonObject[]).find((item) => item.id === "claim-1")!;
    assert.equal(claim.recall_weight, 0.8);
    assert.equal(claim.pending_corrections, 1);
    const catalog = service.workbenchResourceCatalogView({ kind: "memory", limit: 10 }) as JsonObject;
    const memory = (catalog.items as JsonObject[]).find((item) => item.id === "memory-1")!;
    assert.equal(memory.recall_weight, 1);
    assert.equal(memory.pending_corrections, 0);
  } finally { await f.close(); }
});
test("feedback history renders a running weight curve and marks which events counted", async () => {
  const f = await fixture(), designer = new WorkflowDesignWorkbench(f.store);
  try {
    f.store.create("evidence", "ev-h", { source_type: "program", confidence: "confirmed", claim: "验收通过", locator: "report.md",
      metadata: { context_receipt_id: "receipt-h", verdict: "passed" } });
    f.store.create("context_feedback", "fb-counted", { receipt_id: "receipt-h", outcome: "helpful", evidence_verified: true,
      usage_stage: "used", evidence_ids: ["ev-h"], verified_evidence_refs: [{ id: "ev-h", version: 1 }],
      asset_refs: [{ member: "experience", id: "proc-1", version: 1 }], created_at: "2026-11-05T10:00:00Z" });
    f.store.create("context_feedback", "fb-unverified", { receipt_id: "receipt-u", outcome: "helpful", evidence_verified: false,
      usage_stage: "shown", asset_refs: [{ member: "experience", id: "proc-1", version: 1 }], created_at: "2026-11-05T10:01:00Z" });
    f.store.create("context_correction_task", "corr-pending", { status: "pending_review", outcome: "incorrect",
      asset_ref: { member: "experience", id: "proc-1" }, created_at: "2026-11-05T10:02:00Z" });
    f.store.create("context_correction_task", "corr-dismissed", { status: "dismissed", outcome: "stale",
      asset_ref: { member: "experience", id: "proc-1" }, created_at: "2026-11-05T10:03:00Z" });
    const history = designer.feedbackHistory({ asset_id: "proc-1" }) as JsonObject;
    assert.equal(history.member, "experience");
    assert.equal(history.current_weight, 1);
    const counts = history.counts as JsonObject;
    assert.equal(counts.positive, 1);
    assert.equal(counts.negative, 1);
    assert.equal(counts.dismissed, 1);
    assert.equal(counts.events, 4);
    const weights = (history.timeline as JsonObject[]).map((event) => event.weight_after);
    assert.deepEqual(weights, [1.2, 1.2, 1, 1]);
    assert.equal((history.points as JsonObject[]).length, 4);
    assert.throws(() => designer.feedbackHistory({ asset_id: "proc-1", member: "plugin" }), /member/u);
  } finally { await f.close(); }
});
test("feedback written through the governed path is counted by the weight history", async () => {
  const f = await fixture(), service = new CraftService(f.store), designer = new WorkflowDesignWorkbench(f.store);
  try {
    // A real recall receipt that selected one routeable procedure.
    f.store.create("experience_procedure", "proc-live", { scope: "project:demo", lifecycle: "routeable", routeable: true });
    f.store.create("context_resolution_receipt", "receipt-live", {
      scope: { kind: "project", id: "demo" }, memory_refs: [],
      contributions: [{ member: "experience", item_count: 1, references: [
        { id: "proc-live", version: 1, digest: "pd", reason: "routeable" }] }],
      created_at: "2026-11-05T10:00:00Z",
    });
    // Program evidence bound to that receipt is the only thing that can make a
    // helpful signal count; it is recorded through the service, not fabricated.
    const evidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed",
      claim: "验收通过", locator: "report.md",
      metadata: { context_receipt_id: "receipt-live", verdict: "passed" } }) as JsonObject;
    const recorded = service.contextResolutionFeedback({ receipt_id: "receipt-live", outcome: "helpful",
      usage_stage: "used", evidence_ids: [String(evidence.id)],
      asset_refs: [{ member: "experience", id: "proc-live" }] }) as JsonObject;
    assert.equal((recorded.feedback as JsonObject).evidence_verified, true);
    const history = designer.feedbackHistory({ asset_id: "proc-live", member: "experience" }) as JsonObject;
    assert.equal(history.current_weight, 1.2);
    assert.equal((history.counts as JsonObject).positive, 1);
    const timeline = history.timeline as JsonObject[];
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0]!.counted, true);
    assert.equal(timeline[0]!.weight_after, 1.2);
    // The overview weight must agree with the history, from the same source.
    const overview = designer.overview({ scope: "project:demo" }) as JsonObject;
    const procedure = (overview.procedures as JsonObject[]).find((item) => item.id === "proc-live")!;
    assert.equal(procedure.recall_weight, 1.2);
    assert.equal(procedure.helpful_signals, 1);
  } finally { await f.close(); }
});
test("a candidate becomes recallable only after ordered gates, and then earns weight from a counted feedback", async () => {
  const f = await fixture(), service = new CraftService(f.store), designer = new WorkflowDesignWorkbench(f.store);
  try {
    const procedureId = "proc-gated";
    f.store.create("experience_procedure", procedureId, { scope: "project:demo", lifecycle: "candidate", routeable: false,
      completed_gates: [], trigger: "gated export", title: "gated", content_digest: "pg", procedure_kind: "prompt",
      acceptance_ref: "file", scenario_signature: {}, identity_digest: "pg" });
    const gateEvidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed",
      claim: "gate evidence", locator: "gate.md" }) as JsonObject;
    const reader = new ContextResolutionKernel(f.store, [new ExperienceContribution(f.store)]);
    const query = { query: "gated", scope_kind: "project", scope_id: "demo",
      required_refs: [{ member: "experience", id: procedureId }] };
    // Candidate: honestly unavailable to recall.
    await assert.rejects(reader.resolve(query), /Required Context reference is unavailable/u);
    // Every ordered gate must pass before the asset becomes routeable.
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
      service.experienceProcedureGate({ procedure_id: procedureId, stage, passed: true, verdict: "passed",
        evidence_ids: [String(gateEvidence.id)] });
    }
    const promoted = f.store.get("experience_procedure", procedureId);
    assert.equal(promoted.routeable, true);
    assert.equal(promoted.lifecycle, "routeable");
    const resolved = await reader.resolve(query);
    const receipt = resolved.receipt as JsonObject;
    assert.ok(receipt && receipt.id);
    assert.ok((receipt.contributions as JsonObject[]).some((part) => part.member === "experience"));
    // A helpful signal only counts with same-receipt program evidence, through the real write path.
    const verdictEvidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed",
      claim: "verdict passed", locator: "verdict.md",
      metadata: { context_receipt_id: String(receipt.id), verdict: "passed" } }) as JsonObject;
    service.contextResolutionFeedback({ receipt_id: String(receipt.id), outcome: "helpful", usage_stage: "used",
      evidence_ids: [String(verdictEvidence.id)], asset_refs: [{ member: "experience", id: procedureId }] });
    const history = designer.feedbackHistory({ asset_id: procedureId, member: "experience" }) as JsonObject;
    assert.equal(history.current_weight, 1.2);
    const overview = designer.overview({ scope: "project:demo" }) as JsonObject;
    const procedure = (overview.procedures as JsonObject[]).find((item) => item.id === procedureId)!;
    assert.equal(procedure.recall_weight, 1.2);
  } finally { await f.close(); }
});
test("feedback history rolls events up by day when the curve spans multiple days", () => {
  const daily = rollupFeedbackByDay([
    { at: "2026-11-05T10:00:00Z", source: "feedback", counted: true, weight_after: 1.2 },
    { at: "2026-11-05T12:00:00Z", source: "feedback", counted: false, weight_after: 1.2 },
    { at: "2026-11-06T09:00:00Z", source: "correction", counted: true, weight_after: 1 },
  ]);
  assert.equal(daily.length, 2);
  assert.deepEqual([daily[0]!.day, daily[0]!.positive, daily[0]!.negative, daily[0]!.events, daily[0]!.end_weight], ["2026-11-05", 1, 0, 2, 1.2]);
  assert.deepEqual([daily[1]!.day, daily[1]!.positive, daily[1]!.negative, daily[1]!.events, daily[1]!.end_weight], ["2026-11-06", 0, 1, 1, 1]);
});
test("feedback history carries the adjudication trace for correction events", async () => {
  const f = await fixture(), designer = new WorkflowDesignWorkbench(f.store);
  try {
    f.store.create("context_correction_task", "corr-traced", { status: "confirmed", outcome: "incorrect",
      asset_ref: { member: "experience", id: "proc-trace" }, created_at: "2026-11-05T10:00:00Z",
      resolved_at: "2026-11-06T08:00:00Z", decided_by: "user:alex", resolution_reason: "回执指向已删除的实现" });
    const history = designer.feedbackHistory({ asset_id: "proc-trace" }) as JsonObject;
    const event = (history.timeline as JsonObject[])[0]!;
    assert.equal(event.status, "confirmed");
    assert.equal(event.decided_by, "user:alex");
    assert.equal(event.resolution_reason, "回执指向已删除的实现");
    assert.equal(event.resolved_at, "2026-11-06T08:00:00Z");
    assert.equal(event.counted, true);
  } finally { await f.close(); }
});
