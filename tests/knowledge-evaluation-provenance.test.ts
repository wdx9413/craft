import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assessKnowledgeEvaluationProvenance, knowledgeEvaluationEvidence } from "../core/knowledge-evaluation-provenance.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

test("Knowledge evaluation evidence is resolved without losing missing provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-eval-provenance-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("evidence", "source", { confidence: "confirmed", metadata: { source_session_id: "evaluation", task_id: "eval-task" } });
    store.create("evidence", "claim-evidence", { confidence: "confirmed", metadata: { source_session_id: "claim", task_id: "claim-task" } });
    store.create("knowledge_claim", "claim", { evidence_ids: ["claim-evidence", "missing-evidence", 1] });
    store.create("knowledge_claim", "claim-without-evidence", {});
    const resolved = knowledgeEvaluationEvidence(store, { source_evidence_ids: ["source", "missing", "source", 1], expected_claim_ids: ["claim", "missing-claim", "claim", 1] });
    assert.deepEqual(resolved.sourceEvidence.map((item) => item.id), ["source"]);
    assert.deepEqual(resolved.claimEvidence.map((item) => [item.claim_id, item.evidence.id]), [["claim", "claim-evidence"]]);
    assert.deepEqual(knowledgeEvaluationEvidence(store, { expected_claim_ids: ["claim-without-evidence"] }).claimEvidence, []);
    assert.deepEqual(knowledgeEvaluationEvidence(store, {}).sourceEvidence, []);
    assert.deepEqual(knowledgeEvaluationEvidence(store, {}).claimEvidence, []);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Only sanitized independent real-session held-out Knowledge cases are evaluation eligible", () => {
  const sourceEvidence = [{ id: "eval-evidence", confidence: "confirmed", metadata: { source_session_id: "eval-session", task_id: "eval-task" } } as JsonObject];
  const independentClaimEvidence = [{ claim_id: "claim", evidence: { id: "claim-evidence", metadata: { source_session_id: "claim-session", task_id: "claim-task" } } as JsonObject }];
  const base: JsonObject = {
    source_session_id: "eval-session", source_task_id: "eval-task", source_evidence_ids: ["eval-evidence"],
    evaluation_channel: "real_session", dataset_partition: "held_out", sanitized: true, expected_claim_ids: ["claim"],
  };
  const assess = (item: JsonObject, sources = sourceEvidence, claims = independentClaimEvidence) =>
    assessKnowledgeEvaluationProvenance(item, sources, claims);

  assert.equal(assess({}).status, "missing_provenance");
  assert.equal(assess({ source_session_id: "eval-session" }).status, "incomplete_provenance");
  for (const incomplete of [
    { ...base, source_session_id: "" }, { ...base, source_task_id: "" }, { ...base, source_evidence_ids: null },
    { ...base, evaluation_channel: 1 }, { ...base, dataset_partition: 1 }, { ...base, sanitized: 1 },
  ]) assert.equal(assess(incomplete).status, "incomplete_provenance");
  assert.equal(assess({ ...base, evaluation_channel: "unknown" }).status, "unsupported_provenance");
  assert.equal(assess({ ...base, dataset_partition: "other" }).status, "unsupported_provenance");
  assert.equal(assess({ ...base, evaluation_channel: "simulation" }).status, "simulated");
  assert.equal(assess({ ...base, dataset_partition: "development" }).status, "development_only");
  assert.equal(assess({ ...base, sanitized: false }).status, "unsanitized");
  assert.equal(assess({ ...base, source_evidence_ids: [] }).status, "missing_source_evidence");
  assert.equal(assess({ ...base, source_evidence_ids: [1] }).status, "unverified_source_evidence");
  assert.equal(assess(base, []).status, "unverified_source_evidence");
  assert.equal(assess(base, [{ ...sourceEvidence[0]!, confidence: "unverified" }]).status, "unverified_source_evidence");
  for (const metadata of [undefined, "invalid", [], { source_session_id: "other", task_id: "eval-task" }, { source_session_id: "eval-session" }])
    assert.equal(assess(base, [{ ...sourceEvidence[0]!, metadata }]).status, "unverified_source_evidence");
  assert.equal(assess({ ...base, expected_claim_ids: [] }).status, "missing_claim_evidence");
  assert.equal(assess({ ...base, expected_claim_ids: "claim" }).status, "missing_claim_evidence");
  assert.equal(assess({ ...base, expected_claim_ids: [1] }).status, "unverified_claim_source");
  assert.equal(assess(base, sourceEvidence, []).status, "missing_claim_evidence");
  assert.equal(assess(base, sourceEvidence, [{ claim_id: "other", evidence: independentClaimEvidence[0]!.evidence }]).status, "missing_claim_evidence");
  assert.equal(assess(base, sourceEvidence, [{ claim_id: "claim", evidence: {} }]).status, "unverified_claim_source");
  for (const metadata of ["invalid", [], { task_id: "claim-task" }, { source_session_id: "claim-session" }])
    assert.equal(assess(base, sourceEvidence, [{ claim_id: "claim", evidence: { metadata } }]).status, "unverified_claim_source");
  assert.equal(assess(base, sourceEvidence, [{ claim_id: "claim", evidence: { metadata: { source_session_id: "eval-session", task_id: "claim-task" } } }]).status, "session_leak");
  assert.equal(assess(base, sourceEvidence, [{ claim_id: "claim", evidence: { metadata: { source_session_id: "claim-session", task_id: "eval-task" } } }]).status, "session_leak");
  const valid = assess(base);
  assert.deepEqual(valid, { status: "verified_independent", evaluation_eligible: true });
});
