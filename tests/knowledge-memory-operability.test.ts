import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { productSurfaceOf } from "../core/interfaces/mcp/product-launch.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-memory-operability-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  return { root, store, service };
}

async function close(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.close();
  await rm(f.root, { recursive: true, force: true });
}

function sourceAndEvidence(service: CraftService): JsonObject {
  service.knowledgeSourceRegister({ source_id: "notes", kind: "project_note", label: "Notes", trust: "verified",
    scope_kind: "project", scope_id: "p", locator: "notes.md", content_digest: "sha256:" + "a".repeat(64) });
  return service.evidenceRecord({ claim: "Observed in fixture", source_type: "observation", confidence: "confirmed" });
}

test("reviewed knowledge contributes to a scoped Context receipt while candidates remain diagnostic only", async () => {
  const f = await fixture();
  try {
    const evidence = sourceAndEvidence(f.service);
    const reviewed = f.service.knowledgeClaimSave({ claim_id: "reviewed-routing", kind: "fact", content: "Use focused tests before a full suite.",
      scope: "project:p", source_id: "notes", evidence_ids: [evidence.id] }).claim as JsonObject;
    f.service.knowledgeClaimReview({ claim_id: reviewed.id, status: "reviewed", reviewer: "human", reason: "checked" });
    f.service.knowledgeClaimSave({ claim_id: "draft-routing", kind: "fact", content: "Use experimental tests only.",
      scope: "project:p", source_id: "notes", evidence_ids: [evidence.id] });

    const resolved = await f.service.contextResolutionResolve({ query: "focused tests", scope_kind: "project", scope_id: "p", receipt_id: "ctx" });
    const knowledge = ((resolved.contributions as JsonObject[]).find((item) => item.member === "knowledge") as JsonObject).items as JsonObject[];
    assert.equal(knowledge.length, 1);
    assert.equal(knowledge[0]!.claim_id, "reviewed-routing");
    assert.match(String(knowledge[0]!.content), /focused tests/u);

    const search = f.service.knowledgeSearch({ query: "experimental", scope: "project:p" });
    const hit = (search.hits as JsonObject[])[0]!;
    assert.equal(hit.claim_id, "draft-routing");
    assert.equal(hit.status, "candidate");
    assert.equal(search.queried_governed_claims, true);

    // Review alone is not authority: a revoked/untrusted source must disappear from
    // execution Context while remaining visible to a human diagnostic search.
    f.service.knowledgeSourceTransition({ source_id: "notes", status: "revoked", reason: "fixture trust revoked" });
    const blocked = await f.service.contextResolutionResolve({ query: "focused tests", scope_kind: "project", scope_id: "p", receipt_id: "ctx-blocked" });
    const blockedKnowledge = ((blocked.contributions as JsonObject[]).find((item) => item.member === "knowledge") as JsonObject).items as JsonObject[];
    assert.deepEqual(blockedKnowledge, []);
    assert.equal((f.service.knowledgeSearch({ query: "focused", scope: "project:p" }).hits as JsonObject[])[0]!.claim_id, "reviewed-routing");
  } finally { await close(f); }
});

test("memory without a scope is an explicit safe skip rather than a malformed global search", async () => {
  const f = await fixture();
  try {
    const result = await f.service.memorySearch({ query: "anything" });
    assert.deepEqual(result, { memories: [], count: 0, omitted_count: 0, receipt_id: null, content_free_receipt: true,
      skipped: true, reason: "scope_unavailable" });
  } finally { await close(f); }
});

test("automated knowledge review records why legacy imports require live revalidation and promotes only current evidence", async () => {
  const f = await fixture();
  try {
    const legacyEvidence = f.service.evidenceRecord({ evidence_id: "legacy-evidence", claim: "Old importer assertion", source_type: "import", confidence: "unverified" });
    const legacy = f.service.knowledgeClaimSave({ claim_id: "legacy-claim", kind: "fact", content: "An old repository observation.",
      scope: "legacy:project", evidence_ids: [legacyEvidence.id] }).claim as JsonObject;
    // Simulate the pre-provenance records which the migration left in the local
    // database.  The reviewer must not recover their trust from Markdown text.
    f.store.save("knowledge_claim", String(legacy.id), { ...legacy, source_id: null, scope: "legacy:project" });
    const currentEvidence = sourceAndEvidence(f.service);
    const secondCurrentEvidence = f.service.evidenceRecord({ evidence_id: "current-evidence-2", claim: "A second independent fixture observation", source_type: "observation", confidence: "confirmed" });
    f.service.knowledgeClaimSave({ claim_id: "current-claim", kind: "fact", content: "A current evidenced repository observation.",
      scope: "project:p", source_id: "notes", evidence_ids: [currentEvidence.id] });
    f.service.knowledgeClaimSupportRecord({ claim_id: "current-claim", evidence_id: currentEvidence.id, observation_key: "session:fixture:one" });
    f.service.knowledgeClaimSupportRecord({ claim_id: "current-claim", evidence_id: secondCurrentEvidence.id, observation_key: "session:fixture:two" });

    const review = f.service.knowledgeAutoReview({ claim_ids: ["legacy-claim", "current-claim"], auto_promote: true, now: "2026-09-20T00:00:00.000Z" });
    const assessments = review.assessments as JsonObject[];
    const legacyAssessment = assessments.find((item) => item.claim_id === "legacy-claim")!;
    const currentAssessment = assessments.find((item) => item.claim_id === "current-claim")!;
    assert.equal(legacyAssessment.verdict, "revalidation_required");
    assert.deepEqual(legacyAssessment.reasons, ["legacy_scope_requires_live_revalidation", "source_missing", "credible_evidence_missing", "independent_support_below_threshold"]);
    assert.equal(legacyAssessment.promoted, false);
    assert.equal(f.store.get("knowledge_claim", "legacy-claim").status, "candidate");
    assert.equal(currentAssessment.verdict, "eligible");
    assert.equal(currentAssessment.promoted, true);
    assert.equal(f.store.get("knowledge_claim", "current-claim").status, "reviewed");
    assert.equal((f.service.knowledgeAutoReview({ claim_ids: ["legacy-claim"], now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[])[0]!.idempotent, true);
    assert.throws(() => f.service.knowledgeClaimReview({ claim_id: "legacy-claim", status: "reviewed", reviewer: "human", reason: "trust old import" }), /bounded or confirmed Evidence/u);
  } finally { await close(f); }
});

test("explicit user memory is scoped, conflict-aware and retires only the replaced active entry", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.memoryCaptureUserStatement({ content: "I avoid sugar.", scope_kind: "user", scope_id: "didi" }), /Explicit user consent/u);
    const old = f.service.memoryCaptureUserStatement({ content: "I take sugar in coffee.", kind: "preference", topic: "preference:diet:sugar",
      scope_kind: "user", scope_id: "didi", explicit_consent: true, auto_accept: true, memory_id: "sugar-old" });
    assert.equal(old.auto_committed, true);
    const replacement = f.service.memoryCaptureUserStatement({ content: "I am now avoiding sugar.", kind: "preference", topic: "preference:diet:sugar",
      scope_kind: "user", scope_id: "didi", explicit_consent: true, auto_accept: true, candidate_id: "sugar-new" });
    assert.equal((replacement.candidate as JsonObject).status, "conflict_pending");
    const selected = f.service.memoryConflictResolve({ candidate_id: "sugar-new", resolution: "supersede", actor: "user", reason: "newer explicit preference" }).candidate as JsonObject;
    assert.equal(selected.status, "candidate");
    f.service.memoryCandidateReview({ candidate_id: selected.id, decision: "approve", reviewer: "automated-user-statement-review", reason: "newer statement" });
    const committed = f.service.memoryLedgerRememberApproved({ candidate_id: selected.id, memory_id: "sugar-new-memory" });
    assert.equal((committed.memory as JsonObject).status, "active");
    assert.equal(f.store.get("memory_ledger", "sugar-old").status, "superseded");
    const context = await f.service.contextResolutionResolve({ query: "sugar coffee", scope_kind: "user", scope_id: "didi", receipt_id: "diet-context" });
    const memories = context.items as JsonObject[];
    assert.equal(memories.length, 1);
    assert.match(String(memories[0]!.content), /avoiding sugar/u);
    const gate = await f.service.decisionContextGateOpen({ gate_id: "diet-decision", decision_kind: "prepare_order", query: "sugar coffee",
      scope_kind: "user", scope_id: "didi", require_context: true, required_constraint_ids: ["diet-sugar", "scope-user"], recalled_constraint_ids: ["diet-sugar"],
      context_input_tokens: 42, error_injection_count: 0, cost_units: 0.01, latency_ms: 5, cache_observation: "unavailable" });
    assert.equal((gate.gate as JsonObject).status, "ready");
    assert.equal(((gate.gate as JsonObject).decision_metrics as JsonObject).constraint_recall_at_decision, 0.5);
    assert.equal(((gate.gate as JsonObject).decision_metrics as JsonObject).cache_observation, "unavailable");
    await assert.rejects(() => f.service.decisionContextGateOpen({ gate_id: "invalid-recall", decision_kind: "prepare_order", query: "sugar coffee", scope_kind: "user", scope_id: "didi", required_constraint_ids: ["diet-sugar"], recalled_constraint_ids: ["unknown"] }), /subset/);
    const skipped = await f.service.decisionContextGateOpen({ gate_id: "scope-required", decision_kind: "prepare_order", query: "sugar", require_context: true });
    assert.equal((skipped.gate as JsonObject).status, "skipped");
    assert.equal(((await f.service.decisionContextGateGet({ gate_id: "scope-required" })).gate as JsonObject).status, "skipped");
  } finally { await close(f); }
});

test("portable Knowledge/Memory bundles preserve content but merge only additions", async () => {
  const source = await fixture();
  const target = await fixture();
  try {
    const evidence = sourceAndEvidence(source.service);
    const claim = source.service.knowledgeClaimSave({ claim_id: "claim-a", kind: "fact", content: "Run unit tests before publishing.",
      scope: "project:p", source_id: "notes", evidence_ids: [evidence.id] }).claim as JsonObject;
    source.service.knowledgeClaimReview({ claim_id: claim.id, status: "reviewed", reviewer: "human", reason: "checked" });
    source.service.memoryLedgerRemember({ memory_id: "memory-a", source_id: "notes", kind: "procedural", scope_kind: "project", scope_id: "p",
      content: "Use the smallest relevant test command first.", confidence: "confirmed", evidence_ids: [evidence.id] });

    const exported = source.service.knowledgeMemoryBundleExport({ scope_kind: "project", scope_id: "p", exported_at: "2026-09-20T00:00:00.000Z" });
    const bundle = exported.bundle as JsonObject;
    assert.equal(source.service.knowledgeMemoryBundleVerify({ bundle }).valid, true);
    const plan = target.service.knowledgeMemoryBundleImportPlan({ bundle });
    assert.equal(plan.additions, 4); // source, evidence, claim, memory
    assert.equal(plan.conflicts, 0);
    assert.throws(() => target.service.knowledgeMemoryBundleImportApply({ bundle, approved: false }), /requires approved/u);
    const applied = target.service.knowledgeMemoryBundleImportApply({ bundle, approved: true, import_id: "import-a" });
    assert.equal((applied.import as JsonObject).conflict_free, true);
    assert.match(String(target.store.get("knowledge_claim", "claim-a").content), /unit tests/u);
    assert.match(String(target.store.get("memory_ledger", "memory-a").content), /smallest relevant/u);

    const replay = target.service.knowledgeMemoryBundleImportApply({ bundle, approved: true, import_id: "import-a" });
    assert.equal(replay.idempotent, true);
    const duplicatePlan = target.service.knowledgeMemoryBundleImportPlan({ bundle });
    // The plan is the public merge explanation; source/evidence records are expected to be
    // duplicates too, not silently treated as a conflict just because they crossed machines.
    assert.deepEqual((duplicatePlan.decisions as JsonObject[]).map((item) => `${item.kind}:${item.action}`).sort(), ["evidence:duplicate", "knowledge_claim:duplicate", "knowledge_source:duplicate", "memory_ledger:duplicate"]);
    assert.equal(duplicatePlan.duplicates, 4);

    target.store.save("knowledge_claim", "claim-a", { ...target.store.get("knowledge_claim", "claim-a"), status: "revoked" });
    const conflictPlan = target.service.knowledgeMemoryBundleImportPlan({ bundle });
    assert.equal(conflictPlan.conflicts, 1);
  } finally { await close(source); await close(target); }
});

test("component diagnosis distinguishes a reachable MCP process from a stale or incomplete Host surface", async () => {
  const f = await fixture();
  try {
    const stale = f.service.componentDiagnose({ component: "knowledge", observed_tool_names: ["craft_component_readiness_get"] });
    assert.equal(stale.runtime_reachable, true);
    assert.equal(stale.host_attachment, "bundle_or_surface_mismatch");
    assert((stale.missing_tools as string[]).includes("craft_knowledge_search"));
    const current = f.service.componentDiagnose({ component: "experience", observed_tool_names: ["craft_component_readiness_get", "craft_experience_observe", "craft_experience_procedure_draft"] });
    assert.equal(current.host_attachment, "surface_matches");
    assert.match(String(f.service.componentDiagnose({ component: "memory" }).host_attachment), /this_mcp_process_replied/u);
    assert.throws(() => f.service.componentDiagnose({ component: "memory", observed_tool_names: [" "] }), /non-empty/u);
  } finally { await close(f); }
});

test("standalone Knowledge and Memory surfaces expose the same portable bundle protocol", async () => {
  const f = await fixture();
  try {
    const knowledge = new McpServer(f.service, productSurfaceOf("knowledge"));
    const memory = new McpServer(f.service, productSurfaceOf("memory"));
    for (const server of [knowledge, memory]) {
      assert(server.tools.some((tool) => tool.name === "craft_knowledge_memory_bundle"));
      const result = await server.handlers.craft_knowledge_memory_bundle({ operation: "export", scope_kind: "project", scope_id: "p", exported_at: "2026-09-20T00:00:00.000Z" });
      assert.equal((result.bundle as JsonObject).format, "craft.knowledge-memory-bundle");
    }
  } finally { await close(f); }
});
