import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCapabilityService } from "../core/interfaces/mcp/runtime.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { McpServer } from "../core/mcp.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
async function call(server: McpServer, name: string, args: JsonObject): Promise<JsonObject> {
  const response = await server.handle({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }) as JsonObject;
  assert.equal(response.error, undefined);
  const result = response.result as JsonObject;
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent as JsonObject;
}
test("Memory owner promotes independent sessions once and withdraws recall when source support is revoked", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owned-memory-governance-"));
  const project = join(root, "project"); mkdirSync(project);
  const environment = { CRAFT_DATA_DIR: join(root, "data"), CRAFT_STORAGE_OWNER: "memory" };
  let runtime = await openCapabilityService("memory", environment);
  try {
    runtime.service.scopeAliasBind({ scope_kind: "project", scope_id: "project:fixture", alias_kind: "path", alias: project });
    const server = new McpServer(runtime.service, runtime.mode);
    const content = "I prefer concise explanations for routine engineering changes.";
    const args = { content, kind: "preference", session_host: "codex", project_scope_id: "fixture", project_root: project };
    const first = await call(server, "craft_memory_capture_user_statement", { ...args, session_id: "first" });
    assert.deepEqual(first.promotions, []);
    const beforeRetry = runtime.store.count("evidence");
    const retried = await call(server, "craft_memory_capture_user_statement", { ...args, session_id: "first" });
    assert.equal(runtime.store.count("evidence"), beforeRetry);
    assert.deepEqual(retried.promotions, []);
    const second = await call(server, "craft_memory_capture_user_statement", { ...args, session_id: "second" });
    const promotion = (second.promotions as JsonObject[]).find(value => value.tier === "project")!;
    assert.equal(promotion.auto_committed, true);
    const promotedId = String((promotion.memory as JsonObject).id);
    const supportMemoryId = String((first.memory as JsonObject).id);
    runtime.close(); runtime = await openCapabilityService("memory", environment);
    const fresh = new McpServer(runtime.service, runtime.mode);
    const recalled = await call(fresh, "craft_memory_ledger_list", { scope_kind: "project", scope_id: "fixture" });
    assert(JSON.stringify(recalled).includes(promotedId));
    const resolved = await call(fresh, "craft_memory_recall", { query: "concise explanations", scope_kind: "project", scope_id: "fixture" });
    assert(JSON.stringify(resolved.items).includes(promotedId));
    assert.equal(runtime.store.count("context_resolution_receipt"), 0);
    await assert.rejects(runtime.service.memoryRecall({ query: "concise", scope_kind: "project", scope_id: "fixture", cognitive_purpose: "unsupported" }), /cognitive_purpose/u);
    assert.deepEqual((await runtime.service.memoryRecall({ query: "concise", scope_kind: "project", scope_id: "fixture", cognitive_purpose: "procedure" })).items, []);
    assert.deepEqual((await runtime.service.memoryRecall({ query: "concise", scope_kind: "project", scope_id: "other" })).items, []);
    assert.deepEqual((await runtime.service.memoryRecall({ query: "concise", scope_kind: "session", scope_id: "first", session_host: "claude" })).items, []);
    await assert.rejects(runtime.service.memoryRecall({ query: "concise" }), /explicit scope/u);
    const historical = await runtime.service.memoryRecall({ query: "concise", scope_kind: "project", scope_id: "fixture", now: "2020-01-01", as_of: "2020-01-01", known_at: "2020-01-01", history_view: true, allow_restricted: true, include_working_notes: true, include_stale: true });
    assert.equal(historical.execution_context, false);
    await assert.rejects(runtime.service.memoryRecall({ query: "concise", scope_kind: "invalid", scope_id: "fixture" }), /scope/u);
    await assert.rejects(runtime.service.memoryRecall({ query: "concise", scope_kind: "project", scope_id: "fixture", max_items: -1 }), /budget|max_items/u);
    await call(fresh, "craft_memory_ledger_transition", { memory_id: supportMemoryId, expected_version: 1, status: "revoked", reason: "The original preference was withdrawn.", scope_kind: "session", scope_id: "first", session_host: "codex" });
    const after = await call(fresh, "craft_memory_ledger_list", { scope_kind: "project", scope_id: "fixture" });
    assert(!JSON.stringify(after).includes(promotedId));
    assert(!JSON.stringify((await call(fresh, "craft_memory_recall", { query: "concise explanations", scope_kind: "project", scope_id: "fixture" })).items).includes(promotedId));
    await call(fresh, "craft_memory_capture_user_statement", { session_id: "conflict", session_host: "codex", content: "I prefer short explanations for routine changes.", topic: "detail" });
    const conflicting = await call(fresh, "craft_memory_capture_user_statement", { session_id: "conflict", session_host: "codex", content: "I prefer detailed explanations for routine changes.", topic: "detail" });
    assert.equal((conflicting.candidate as JsonObject).status, "conflict_pending");
    assert.equal(conflicting.auto_committed, false);
    assert.throws(() => runtime.service.memoryCandidateReview({ candidate_id: (conflicting.candidate as JsonObject).id, decision: "approve", reviewer: "fixture", reason: "Try to skip conflict resolution." }), /Resolve Memory conflict/u);

  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Knowledge owner keeps repeated observations diagnostic until independent task effects qualify and preserves retraction across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owned-knowledge-governance-"));
  const environment = { CRAFT_DATA_DIR: root, CRAFT_STORAGE_OWNER: "knowledge" };
  let runtime = await openCapabilityService("knowledge", environment);
  try {
    const server = new McpServer(runtime.service, runtime.mode);
    await call(server, "craft_knowledge_bootstrap_install", {});
    const evidence = await call(server, "craft_evidence_record", { evidence_id: "observation", source_type: "human", confidence: "bounded", claim: "A focused test helped validate the routine change.", metadata: { capability_owner: "knowledge", source_session_id: "first", task_id: "first-task", scope: "global" } });
    const saved = await call(server, "craft_knowledge_claim_save", { claim_id: "focused-test", kind: "rule", content: "Run the focused test before accepting a routine change.", scope: "global", source_id: "builtin.evidence-wiki", evidence_ids: [evidence.id] });
    const claim = saved.claim as JsonObject;
    await call(server, "craft_knowledge_support_record", { claim_id: claim.id, evidence_id: evidence.id, observation_key: "same-observation" });
    const count = runtime.store.count("knowledge_claim_support");
    await call(server, "craft_knowledge_support_record", { claim_id: claim.id, evidence_id: evidence.id, observation_key: "same-observation" });
    assert.equal(runtime.store.count("knowledge_claim_support"), count);
    const assessment = await call(server, "craft_knowledge_auto_review", { scope_kind: "global", scope_id: "global", claim_ids: [claim.id] });
    assert.equal((assessment.assessments as JsonObject[])[0]!.promoted, false);
    assert.equal(runtime.store.get("knowledge_claim", String(claim.id)).status, "candidate");
    const before = await call(server, "craft_knowledge_search", { query: "focused test", scope: "global" });
    assert(!(before.hits as JsonObject[]).some(hit => hit.id === claim.id || hit.claim_id === claim.id));
    await call(server, "craft_knowledge_claim_review", { claim_id: claim.id, status: "expired", expected_version: claim.version, reviewer: "fixture", reason: "The underlying convention no longer applies." });
    runtime.close(); runtime = await openCapabilityService("knowledge", environment);
    const fresh = new McpServer(runtime.service, runtime.mode);
    const read = await call(fresh, "craft_knowledge_claim_get", { claim_id: claim.id, scope_kind: "global", scope_id: "global" });
    assert.equal((read.claim as JsonObject).status, "expired");
    assert.equal((read.claim as JsonObject).version, 2);
    assert.equal(runtime.store.get("knowledge_claim", String(claim.id), 1).status, "candidate");
    const after = await call(fresh, "craft_knowledge_search", { query: "focused test", scope: "global" });
    assert(!(after.hits as JsonObject[]).some(hit => hit.id === claim.id || hit.claim_id === claim.id));
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Knowledge task-effect MCP requires an existing Eval owner and reads retrieval material from Knowledge", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owned-knowledge-eval-port-"));
  const environment = { CRAFT_DATA_DIR: root };
  let knowledge = await openCapabilityService("knowledge", environment);
  try {
    await assert.rejects(knowledge.service.knowledgeTaskEffectAssess({ retrieval_run_id: "missing", baseline_id: "baseline", candidate_id: "candidate" }), /require the Eval owner/u);
    knowledge.close();
    const evaluation = await openCapabilityService("eval", environment);
    evaluation.close();
    knowledge = await openCapabilityService("knowledge", environment);
    assert(knowledge.service.ownerServices.has("eval"));
    await assert.rejects(knowledge.service.knowledgeTaskEffectAssess({ retrieval_run_id: "missing", baseline_id: "baseline", candidate_id: "candidate" }), /Unknown knowledge_evaluation_run/u);
    assert.equal(knowledge.store.count("workbench_evaluation"), 0);
    // Read-port fixture only: this does not assert a live task-effect or grant promotion.
    const { stableDigest } = await import("../core/digest.ts");
    const { KNOWLEDGE_TASK_EFFECT_POLICY, knowledgeTaskEffectId, knowledgeTaskEffectAssessmentDigest, knowledgeTaskEffectProofVerified } = await import("@craft/capability-knowledge/knowledge-task-effect-proof");
    const evalStore = knowledge.service.ownerServices.get("eval")!.store;
    const dependency = evalStore.create("workbench_evaluation", "reader-fixture", { state: "completed" });
    knowledge.store.create("knowledge_claim", "fixture", { scope: "global", content: "Reader wiring fixture." });
    const run = knowledge.store.create("knowledge_evaluation_run", "reader-fixture", { scope: "global", mode: "candidate_shadow" });
    const metrics = { fixture_only: true };
    const body = { policy: KNOWLEDGE_TASK_EFFECT_POLICY, scope: "global", claim_id: "fixture", retrieval_run_id: run.id, retrieval_run_digest: stableDigest(run), baseline_id: dependency.id, candidate_id: "other", dependencies: [{ kind: "workbench_evaluation", id: dependency.id, version: dependency.version, digest: stableDigest(dependency) }], comparison_digest: stableDigest(metrics), observed_model: "fixture", execution_origin: "controlled_paired_host_tasks", status: "eligible", reasons: [] };
    knowledge.store.create("knowledge_task_effect", knowledgeTaskEffectId(run), { ...body, metrics, assessment_digest: knowledgeTaskEffectAssessmentDigest(body) });
    assert.equal(knowledgeTaskEffectProofVerified(knowledge.store, run), true);
    evalStore.save("workbench_evaluation", "reader-fixture", { state: "failed" });
    assert.equal(knowledgeTaskEffectProofVerified(knowledge.store, run), false);
    knowledge.close(); rmSync(join(root, "eval"), { recursive: true });
    knowledge = await openCapabilityService("knowledge", environment);
    assert.equal(knowledgeTaskEffectProofVerified(knowledge.store, run), false);

    const sharedStore = await new CraftStore(craftPaths(join(root, "legacy"))).open();
    try { await assert.rejects(new CraftService(sharedStore).knowledgeTaskEffectAssess({ retrieval_run_id: "missing", baseline_id: "baseline", candidate_id: "candidate" }), /Unknown knowledge_evaluation_run/u); }
    finally { sharedStore.close(); }

  } finally { knowledge.close(); rmSync(root, { recursive: true, force: true }); }
});
