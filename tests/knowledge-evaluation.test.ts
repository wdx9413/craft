import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("knowledge retrieval evaluation does not change routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-eval-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({})), /at least/);
    const evidence = service.evidenceRecord({ source_type: "program", claim: "Observed." }); const claim = service.knowledgeClaimSave({ claim_id: "alpha", kind: "fact", content: "alpha rule", evidence_ids: [evidence.id] }).claim as JsonObject; service.knowledgeClaimReview({ claim_id: claim.id, status: "reviewed", reviewer: "h", reason: "checked" });
    const saved = service.knowledgeEvaluationCaseSave({ case_id: "case", query: "alpha", expected_claim_ids: [claim.id] }).case as JsonObject; assert.equal(String((service.knowledgeEvaluationCaseSave({ query: "alpha", expected_claim_ids: [claim.id] }).case as JsonObject).id).startsWith("knowledge_evaluation_case_"), true); assert.equal((service.knowledgeEvaluationCaseSave({ case_id: "case", query: "alpha", expected_claim_ids: [claim.id] }) as JsonObject).idempotent, true); await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationCaseSave({ case_id: "case", query: "other", expected_claim_ids: [claim.id] })), /idempotency/);
    const run = service.knowledgeEvaluationRun({ run_id: "run", case_ids: [saved.id], top_k: 1, now: "2027-01-01T00:00:00.000Z" }).run as JsonObject; assert.equal(run.status, "eligible"); assert.equal((run.metrics as JsonObject).recall, 1); assert.equal(run.changes_routing, false); assert.equal((service.knowledgeEvaluationRun({ run_id: "run", case_ids: [saved.id], top_k: 1, now: "2027-01-01T00:00:00.000Z" }) as JsonObject).idempotent, true); await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ run_id: "run", case_ids: [saved.id], top_k: 2, now: "2027-01-01T00:00:00.000Z" })), /idempotency/); assert.equal((service.knowledgeEvaluationRun({ now: "2027-01-01T00:00:00.000Z" }).run as JsonObject).changes_routing, false);
    const strict = service.knowledgeEvaluationRun({ case_ids: [saved.id], top_k: 1, now: "2027-01-01T00:00:00.000Z", min_recall: 1, min_evidence_coverage: 1 }).run as JsonObject; assert.equal(strict.status, "eligible"); assert.equal((service.knowledgeEvaluationRun({ case_ids: [saved.id] }).run as JsonObject).changes_routing, false); const missing = service.knowledgeEvaluationCaseSave({ query: "missing", scope: "project:a", expected_claim_ids: [claim.id] }).case as JsonObject; assert.equal((service.knowledgeEvaluationRun({ case_ids: [missing.id], top_k: 1, now: "2027-01-01T00:00:00.000Z" }).run as JsonObject).status, "insufficient");
    assert.equal((service.knowledgeEvaluationRunGet({ run_id: "run", version: 1 }).run as JsonObject).id, "run"); assert.equal((service.knowledgeEvaluationRunList({}).runs as JsonObject[]).length >= 1, true); assert.equal((service.knowledgeEvaluationCaseList({}).cases as JsonObject[]).length >= 2, true);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ case_ids: [], top_k: 1 })), /at least/); await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ case_ids: [saved.id], min_recall: 2 })), /thresholds/);
    const mcp = new McpServer(service, "full"); for (const [name, arguments_] of [["craft_knowledge_evaluation_case_save", { query: "alpha", expected_claim_ids: [claim.id] }], ["craft_knowledge_evaluation_case_list", {}], ["craft_knowledge_evaluation_run", { case_ids: [saved.id], now: "2027-01-01T00:00:00.000Z" }], ["craft_knowledge_evaluation_run_get", { run_id: "run" }], ["craft_knowledge_evaluation_run_list", {}]] as [string, JsonObject][]) { const result = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } }); assert.equal((result?.result as JsonObject).isError, false); }
    assert.equal(VERSION, "0.11.36");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
