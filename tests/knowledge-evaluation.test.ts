import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

test("knowledge retrieval evaluation does not change routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-eval-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({})), /at least/);
    const evidence = service.evidenceRecord({ source_type: "program", claim: "Observed.", confidence: "confirmed", metadata: { source_session_id: "claim-session", task_id: "claim-task" } }); const claim = service.knowledgeClaimSave({ claim_id: "alpha", kind: "fact", content: "alpha rule", evidence_ids: [evidence.id] }).claim as JsonObject; service.knowledgeClaimReview({ claim_id: claim.id, status: "reviewed", reviewer: "h", reason: "checked" });
    const evaluationEvidence = service.evidenceRecord({ source_type: "program", claim: "Independent held-out result.", confidence: "confirmed", metadata: { source_session_id: "evaluation-session", task_id: "evaluation-task" } });
    const provenance = { source_session_id: "evaluation-session", source_task_id: "evaluation-task", source_evidence_ids: [evaluationEvidence.id], evaluation_channel: "real_session", dataset_partition: "held_out", sanitized: true };
    const saved = service.knowledgeEvaluationCaseSave({ case_id: "case", query: "alpha", expected_claim_ids: [claim.id], ...provenance }).case as JsonObject; assert.equal(String((service.knowledgeEvaluationCaseSave({ query: "alpha", expected_claim_ids: [claim.id] }).case as JsonObject).id).startsWith("knowledge_evaluation_case_"), true); assert.equal((service.knowledgeEvaluationCaseSave({ case_id: "case", query: "alpha", expected_claim_ids: [claim.id], ...provenance }) as JsonObject).idempotent, true); await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationCaseSave({ case_id: "case", query: "other", expected_claim_ids: [claim.id], ...provenance })), /idempotency/);
    const modelLabeled = service.knowledgeEvaluationCaseSave({ case_id: "model-labeled", query: "alpha", expected_claim_ids: [claim.id], ...provenance, label_source: "model_candidate" }).case as JsonObject;
    assert.equal(modelLabeled.label_source, "model_candidate"); assert.equal(modelLabeled.status, "model_labeled");
    const run = service.knowledgeEvaluationRun({ run_id: "run", case_ids: [saved.id], top_k: 1, now: "2027-01-01T00:00:00.000Z" }).run as JsonObject; assert.equal(run.status, "eligible"); assert.equal((run.metrics as JsonObject).recall, 1); assert.equal((run.metrics as JsonObject).provenance_eligible, true); assert.equal(run.changes_routing, false); assert.equal((service.knowledgeEvaluationRun({ run_id: "run", case_ids: [saved.id], top_k: 1, now: "2027-01-01T00:00:00.000Z" }) as JsonObject).idempotent, true); await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ run_id: "run", case_ids: [saved.id], top_k: 2, now: "2027-01-01T00:00:00.000Z" })), /idempotency/); assert.equal((service.knowledgeEvaluationRun({ now: "2027-01-01T00:00:00.000Z" }).run as JsonObject).changes_routing, false);
    const strict = service.knowledgeEvaluationRun({ case_ids: [saved.id], top_k: 1, now: "2027-01-01T00:00:00.000Z", min_recall: 1, min_evidence_coverage: 1 }).run as JsonObject; assert.equal(strict.status, "eligible"); assert.equal((service.knowledgeEvaluationRun({ case_ids: [saved.id] }).run as JsonObject).changes_routing, false); const missing = service.knowledgeEvaluationCaseSave({ query: "missing", scope: "project:a", expected_claim_ids: [claim.id] }).case as JsonObject; assert.equal((service.knowledgeEvaluationRun({ case_ids: [missing.id], top_k: 1, now: "2027-01-01T00:00:00.000Z" }).run as JsonObject).status, "insufficient");
    assert.equal((service.knowledgeEvaluationRunGet({ run_id: "run", version: 1 }).run as JsonObject).id, "run"); assert.equal((service.knowledgeEvaluationRunList({}).runs as JsonObject[]).length >= 1, true); assert.equal((service.knowledgeEvaluationCaseList({}).cases as JsonObject[]).length >= 2, true);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ case_ids: [], top_k: 1 })), /at least/); await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ case_ids: [saved.id], min_recall: 2 })), /thresholds/);
    const mcp = new McpServer(service, "full"); for (const [name, arguments_] of [["craft_knowledge_evaluation_case_save", { query: "alpha", expected_claim_ids: [claim.id], ...provenance }], ["craft_knowledge_evaluation_case_list", {}], ["craft_knowledge_evaluation_run", { case_ids: [saved.id], now: "2027-01-01T00:00:00.000Z" }], ["craft_knowledge_evaluation_run_get", { run_id: "run" }], ["craft_knowledge_evaluation_run_list", {}]] as [string, JsonObject][]) { const result = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } }); assert.equal((result?.result as JsonObject).isError, false); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});


test("knowledge evaluation retrieves Chinese words using the shared lexical index", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-chinese-eval-"));
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    await mkdir(join(root, "other"));
    service.scopeAliasBind({ scope_kind: "project", scope_id: "project:demo", alias_kind: "path", alias: root });
    service.scopeAliasBind({ scope_kind: "project", scope_id: "project:other", alias_kind: "path", alias: join(root, "other") });
    const evidence = service.evidenceRecord({ source_type: "program", claim: "Verified release sequence.", confidence: "confirmed" });
    for (const [claim_id, scope, status, valid_until] of [
      ["release-rule", "project:demo", "reviewed", undefined],
      ["other-project", "project:other", "reviewed", undefined],
      ["candidate-rule", "project:demo", "candidate", undefined],
      ["expired-rule", "project:demo", "reviewed", "2026-01-01T00:00:00.000Z"],
    ] as const) {
      service.knowledgeClaimSave({ claim_id, scope, kind: "fact", content: "发布插件前必须先推送远端仓库，再从远端安装插件。", evidence_ids: [evidence.id], valid_until });
      if (status === "reviewed") service.knowledgeClaimReview({ claim_id, status, reviewer: "fixture", reason: "verified" });
    }
    const query = "更新插件时为什么必须先推送远端仓库再安装？";
    const saved = service.knowledgeEvaluationCaseSave({ query, scope: "project:demo", expected_claim_ids: ["release-rule"], label_source: "model_candidate",
      source_session_id: "held-out", source_task_id: "held-out-task", source_evidence_ids: [evidence.id], evaluation_channel: "real_session", dataset_partition: "held_out", sanitized: true }).case as JsonObject;
    const run = service.knowledgeEvaluationRun({ case_ids: [saved.id], now: "2026-10-22T00:00:00.000Z" }).run as JsonObject;
    assert.equal((run.metrics as JsonObject).recall, 1);
    assert.equal((run.metrics as JsonObject).candidate_leaks, 0);
    assert.equal((run.metrics as JsonObject).provenance_eligible, false, "retrieval success cannot validate model-proposed labels");
    assert.equal(run.status, "insufficient");
    const compiled = service.wikiContextCompile({ query, scope: "project:demo", now: "2026-10-22T00:00:00.000Z" });
    assert.deepEqual((compiled.included as JsonObject[]).map(item => item.claim_id), ["release-rule"]);
    const exclusions = new Map((compiled.excluded as JsonObject[]).map(item => [item.claim_id, item.reason]));
    assert.equal(exclusions.get("other-project"), "out_of_scope");
    assert.equal(exclusions.get("candidate-rule"), "not_reviewed");
    assert.equal(exclusions.get("expired-rule"), "expired");
    assert.deepEqual(service.wikiContextCompile({ query: "unrelated-unmatched-identifier", scope: "project:demo" }).included, []);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
