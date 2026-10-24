import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { adjudicateKnowledgeCase } from "./helpers/knowledge-evaluation-adjudication.ts";
import { attachVerifiedPromotionFixture } from "./helpers/knowledge-promotion-proof.ts";

test("knowledge retrieval evaluation does not change routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-eval-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    service.scopeAliasBind({ scope_kind: "project", scope_id: "project:a", alias_kind: "path", alias: root });
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({})), /at least/);
    service.knowledgeSourceRegister({ source_id: "alpha-source", kind: "project_note", label: "Alpha source", trust: "verified", scope_kind: "global", scope_id: "global", locator: "fixture", content_digest: "alpha-source-v1" });
    const evidence = service.evidenceRecord({ source_type: "program", claim: "Observed.", confidence: "confirmed", metadata: { source_session_id: "claim-session", task_id: "claim-task" } }); const claim = service.knowledgeClaimSave({ claim_id: "alpha", kind: "fact", content: "alpha rule", source_id: "alpha-source", evidence_ids: [evidence.id] }).claim as JsonObject; attachVerifiedPromotionFixture(store, claim);
    const evaluationEvidence = service.evidenceRecord({ source_type: "program", claim: "Independent held-out result.", confidence: "confirmed", metadata: { source_session_id: "evaluation-session", task_id: "evaluation-task" } });
    const provenance = { source_session_id: "evaluation-session", source_task_id: "evaluation-task", source_evidence_ids: [evaluationEvidence.id], evaluation_channel: "real_session", dataset_partition: "held_out", label_source: "model_candidate", sanitized: true };
    const saved = service.knowledgeEvaluationCaseSave({ case_id: "case", query: "alpha", expected_claim_ids: [claim.id], ...provenance }).case as JsonObject; assert.equal(String((service.knowledgeEvaluationCaseSave({ query: "alpha", expected_claim_ids: [claim.id] }).case as JsonObject).id).startsWith("knowledge_evaluation_case_"), true); assert.equal((service.knowledgeEvaluationCaseSave({ case_id: "case", query: "alpha", expected_claim_ids: [claim.id], ...provenance }) as JsonObject).idempotent, true); await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationCaseSave({ case_id: "case", query: "other", expected_claim_ids: [claim.id], ...provenance })), /idempotency/);
    const modelLabeled = service.knowledgeEvaluationCaseSave({ case_id: "model-labeled", query: "alpha", expected_claim_ids: [claim.id], ...provenance, label_source: "model_candidate" }).case as JsonObject;
    assert.equal(modelLabeled.label_source, "model_candidate"); assert.equal(modelLabeled.status, "model_labeled");
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationCaseSave({ case_id: "direct-host-label", query: "alpha",
      expected_claim_ids: [claim.id], ...provenance, label_source: "host_adjudicated" })), /completed Knowledge adjudication Trace/u);
    assert.equal(saved.label_source, "model_candidate");
    const adjudicated = adjudicateKnowledgeCase(service, saved).case as JsonObject;
    assert.equal(adjudicated.label_source, "host_adjudicated");
    const run = service.knowledgeEvaluationRun({ run_id: "run", case_ids: [saved.id], top_k: 1, now: "2027-01-01T00:00:00.000Z" }).run as JsonObject; assert.equal(run.status, "eligible"); assert.equal((run.metrics as JsonObject).recall, 1); assert.equal((run.metrics as JsonObject).provenance_eligible, true); assert.equal(run.changes_routing, false); assert.equal((service.knowledgeEvaluationRun({ run_id: "run", case_ids: [saved.id], top_k: 1, now: "2027-01-01T00:00:00.000Z" }) as JsonObject).idempotent, true); await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ run_id: "run", case_ids: [saved.id], top_k: 2, now: "2027-01-01T00:00:00.000Z" })), /idempotency/); assert.equal((service.knowledgeEvaluationRun({ now: "2027-01-01T00:00:00.000Z" }).run as JsonObject).changes_routing, false);
    const strict = service.knowledgeEvaluationRun({ case_ids: [saved.id], top_k: 1, now: "2027-01-01T00:00:00.000Z", min_recall: 1, min_evidence_coverage: 1 }).run as JsonObject; assert.equal(strict.status, "eligible"); assert.equal((service.knowledgeEvaluationRun({ case_ids: [saved.id] }).run as JsonObject).changes_routing, false); const missing = service.knowledgeEvaluationCaseSave({ query: "missing", scope: "project:a", expected_claim_ids: [claim.id] }).case as JsonObject; assert.equal((service.knowledgeEvaluationRun({ case_ids: [missing.id], top_k: 1, now: "2027-01-01T00:00:00.000Z" }).run as JsonObject).status, "insufficient");
    const legacyCase = store.create("knowledge_evaluation_case", "legacy-case", { query: "alpha", scope: "project:a", expected_claim_ids: [claim.id] });
    assert.equal((service.knowledgeEvaluationRun({ case_ids: [legacyCase.id], top_k: 1 }).run as JsonObject).status, "insufficient");
    assert.equal((service.knowledgeEvaluationRunGet({ run_id: "run", version: 1 }).run as JsonObject).id, "run"); assert.equal((service.knowledgeEvaluationRunList({}).runs as JsonObject[]).length >= 1, true); assert.equal((service.knowledgeEvaluationCaseList({}).cases as JsonObject[]).length >= 2, true);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ case_ids: [], top_k: 1 })), /at least/); await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ case_ids: [saved.id], min_recall: 2 })), /thresholds/);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ mode: "unknown", case_ids: [saved.id] })), /mode is unsupported/u);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ mode: "candidate_shadow", case_ids: [saved.id], candidate_claim_ids: [] })), /candidate_claim_ids/u);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ mode: "retrieval", case_ids: [saved.id], candidate_claim_ids: [claim.id] })), /require candidate_shadow/u);
    const nonCandidate = service.knowledgeClaimSave({ claim_id: "reviewed-for-shadow", kind: "fact", content: "reviewed fact", source_id: "alpha-source", evidence_ids: [evidence.id] }).claim as JsonObject;
    attachVerifiedPromotionFixture(store, nonCandidate);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ mode: "candidate_shadow", case_ids: [saved.id], candidate_claim_ids: [nonCandidate.id] })), /current candidate Claims/u);
    const candidate = service.knowledgeClaimSave({ claim_id: "candidate-shadow-claim", kind: "fact", content: "candidate fact", evidence_ids: [evidence.id] }).claim as JsonObject;
    const candidateTwo = service.knowledgeClaimSave({ claim_id: "candidate-shadow-claim-two", kind: "fact", content: "candidate fact two", evidence_ids: [evidence.id] }).claim as JsonObject;
    const candidateRef = { claim_id: candidate.id, claim_version: candidate.version,
      identity_digest: candidate.identity_digest, content_digest: candidate.content_digest };
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationCaseSave({ query: "candidate", expected_claim_ids: [candidate.id],
      candidate_claim_refs: "bad", ...provenance, label_source: "model_candidate" })), /candidate_claim_refs must be an array/u);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationCaseSave({ query: "candidate", expected_claim_ids: [candidate.id],
      candidate_claim_refs: [candidateRef, candidateRef], ...provenance, label_source: "model_candidate" })), /must be unique/u);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationCaseSave({ query: "candidate", expected_claim_ids: [candidateTwo.id],
      candidate_claim_refs: [candidateRef], ...provenance, label_source: "model_candidate" })), /include every expected candidate Claim/u);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationCaseSave({ query: "candidate", expected_claim_ids: [candidate.id],
      candidate_claim_refs: [candidateRef, ...Array.from({ length: 100 }, (_, index) => ({ ...candidateRef, claim_id: `missing-${index}` }))],
      ...provenance, label_source: "model_candidate" })), /at most 100/u);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationCaseSave({ case_id: "stale-candidate-case", query: "candidate",
      expected_claim_ids: [candidate.id], candidate_claim_refs: [{ ...candidateRef, claim_version: 999 }], ...provenance, label_source: "model_candidate" })), /current candidate Claim versions/u);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationCaseSave({ query: "candidate", expected_claim_ids: [candidate.id],
      candidate_claim_refs: [{ ...candidateRef, content_digest: "stale-content" }], ...provenance, label_source: "model_candidate" })), /current candidate Claim versions/u);
    const candidateCase = service.knowledgeEvaluationCaseSave({ case_id: "candidate-shadow-case", query: "candidate", expected_claim_ids: [candidate.id],
      candidate_claim_refs: [candidateRef], ...provenance, label_source: "model_candidate" }).case as JsonObject;
    const candidateTwoRef = { claim_id: candidateTwo.id, claim_version: candidateTwo.version,
      identity_digest: candidateTwo.identity_digest, content_digest: candidateTwo.content_digest };
    const correctableCase = service.knowledgeEvaluationCaseSave({ case_id: "correctable-candidate-case", query: "candidate",
      expected_claim_ids: [candidate.id], candidate_claim_refs: [candidateRef, candidateTwoRef], ...provenance, label_source: "model_candidate" }).case as JsonObject;
    const corrected = adjudicateKnowledgeCase(service, correctableCase, "corrected", [String(candidateTwo.id)]).case as JsonObject;
    assert.deepEqual(corrected.expected_claim_ids, [candidateTwo.id]);
    const sameLabelCorrection = service.knowledgeEvaluationCaseSave({ case_id: "same-label-correction", query: "candidate", expected_claim_ids: [candidate.id],
      candidate_claim_refs: [candidateRef], ...provenance, label_source: "model_candidate" }).case as JsonObject;
    await assert.rejects(Promise.resolve().then(() => adjudicateKnowledgeCase(service, sameLabelCorrection, "corrected", [String(candidate.id)])), /does not match its decision/u);
    const mismatchedDigestCase = service.knowledgeEvaluationCaseSave({ case_id: "digest-mismatch-case", query: "candidate", expected_claim_ids: [candidate.id],
      candidate_claim_refs: [candidateRef], ...provenance, label_source: "model_candidate" }).case as JsonObject;
    await assert.rejects(Promise.resolve().then(() => adjudicateKnowledgeCase(service, mismatchedDigestCase, "accepted", [String(candidate.id)], { response_digest: "forged" })), /incomplete or not bound/u);
    const staleCase = service.knowledgeEvaluationCaseSave({ case_id: "stale-case-version", query: "candidate", expected_claim_ids: [candidate.id],
      candidate_claim_refs: [candidateRef], ...provenance, label_source: "model_candidate" }).case as JsonObject;
    await assert.rejects(Promise.resolve().then(() => adjudicateKnowledgeCase(service, staleCase, "accepted", [String(candidate.id)], { expected_version: Number(staleCase.version) + 1 })), /version changed/u);
    const missingRefsCase = service.knowledgeEvaluationCaseSave({ case_id: "candidate-shadow-unbound-case", query: "candidate", expected_claim_ids: [candidate.id],
      ...provenance, label_source: "model_candidate" }).case as JsonObject;
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ run_id: "candidate-shadow-unbound-run", mode: "candidate_shadow",
      case_ids: [missingRefsCase.id], candidate_claim_ids: [candidate.id], now: "2027-01-01T00:00:00.000Z" })), /exact current candidate Claim refs/u);
    const candidateRun = service.knowledgeEvaluationRun({ run_id: "candidate-shadow-run", mode: "candidate_shadow", case_ids: [candidateCase.id],
      candidate_claim_ids: [candidate.id], now: "2027-01-01T00:00:00.000Z" }).run as JsonObject;
    assert.equal(candidateRun.status, "insufficient", "model labels remain ineligible without independent adjudication");
    assert.deepEqual(candidateRun.candidate_claim_refs, [candidateRef]);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationRun({ run_id: "candidate-shadow-run-mismatch", mode: "candidate_shadow",
      case_ids: [candidateCase.id], candidate_claim_ids: [candidate.id, candidateTwo.id], now: "2027-01-01T00:00:00.000Z" })), /exact current candidate Claim refs/u);
    const legacyCandidate = store.create("knowledge_claim", "legacy-candidate", { status: "candidate", version: 1, scope: "global", content: "legacy" });
    const legacyCandidateCase = service.knowledgeEvaluationCaseSave({ query: "legacy", expected_claim_ids: [legacyCandidate.id], candidate_claim_refs: [
      { claim_id: legacyCandidate.id, claim_version: 1, identity_digest: null, content_digest: null }], ...provenance, label_source: "model_candidate" }).case as JsonObject;
    assert.deepEqual((legacyCandidateCase.candidate_claim_refs as JsonObject[])[0], { claim_id: legacyCandidate.id, claim_version: 1, identity_digest: null, content_digest: null });
    await assert.rejects(Promise.resolve().then(() => service.wikiContextCompile({ query: "alpha", candidate_claim_ids: Array.from({ length: 101 }, (_, index) => `candidate-${index}`) })), /exceeds the evaluation limit/u);
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
      const projectId = String(scope).split(":")[1]!;
      const sourceId = `${claim_id}-source`;
      service.knowledgeSourceRegister({ source_id: sourceId, kind: "project_note", label: claim_id, trust: "verified", scope_kind: "project", scope_id: projectId,
        locator: "fixture", content_digest: `${sourceId}-v1` });
      const savedClaim = service.knowledgeClaimSave({ claim_id, scope, kind: "fact", content: "发布插件前必须先推送远端仓库，再从远端安装插件。", source_id: sourceId, evidence_ids: [evidence.id], valid_until }).claim as JsonObject;
      if (status === "reviewed") attachVerifiedPromotionFixture(store, savedClaim);
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

test("Knowledge adjudication API is idempotent, rejects stale or forged traces, and keeps negative decisions ineligible", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-adjudication-api-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    const source = service.evidenceRecord({ evidence_id: "adjudication-source", source_type: "program", confidence: "confirmed", claim: "Source fact",
      metadata: { source_session_id: "source-session", task_id: "source-task" } });
    const candidate = service.knowledgeClaimSave({ claim_id: "adjudication-claim", kind: "fact", content: "Candidate fact", evidence_ids: [source.id] }).claim as JsonObject;
    const held = service.evidenceRecord({ evidence_id: "adjudication-held", source_type: "program", confidence: "confirmed", claim: "Held-out result",
      metadata: { source_session_id: "held-session", task_id: "held-task" } });
    const provenance = { source_session_id: "held-session", source_task_id: "held-task", source_evidence_ids: [held.id],
      evaluation_channel: "real_session", dataset_partition: "held_out", sanitized: true };
    const saveCase = (id: string) => service.knowledgeEvaluationCaseSave({ case_id: id, query: "Candidate fact", expected_claim_ids: [candidate.id],
      ...provenance, label_source: "model_candidate" }).case as JsonObject;
    const pending = saveCase("adjudication-idempotent");
    const completed = adjudicateKnowledgeCase(service, pending);
    const record = completed.adjudication as JsonObject;
    const replay = service.knowledgeEvaluationCaseAdjudicate({ case_id: pending.id, expected_version: pending.version, trace_id: record.trace_id,
      input_digest: record.input_digest, response_digest: record.response_digest, decision: record.decision, expected_claim_ids: record.expected_claim_ids }, true) as JsonObject;
    assert.equal(replay.idempotent, true);
    const another = saveCase("adjudication-other-case");
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationCaseAdjudicate({ case_id: another.id, expected_version: another.version,
      trace_id: record.trace_id, input_digest: record.input_digest, response_digest: record.response_digest, decision: record.decision,
      expected_claim_ids: record.expected_claim_ids }, true)), /idempotency conflict/u);
    const notAwaitingTrace = service.traceStart({ trace_id: "already-adjudicated-second-trace", task_id: `knowledge:adjudication:${pending.id}`, model_fingerprint: "host" }).trace as JsonObject;
    service.traceFinalize({ trace_id: notAwaitingTrace.id, status: "completed", summary: "already adjudicated" });
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationCaseAdjudicate({ case_id: pending.id, expected_version: Number(pending.version) + 1,
      trace_id: notAwaitingTrace.id, input_digest: "i", response_digest: "r", decision: "accepted", expected_claim_ids: [candidate.id] }, true)), /not awaiting adjudication/u);
    const invalidTraceCase = saveCase("adjudication-invalid-trace");
    service.traceStart({ trace_id: "wrong-task-trace", task_id: "different-task", model_fingerprint: "host" });
    service.traceFinalize({ trace_id: "wrong-task-trace", status: "completed", summary: "wrong task" });
    await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationCaseAdjudicate({ case_id: invalidTraceCase.id,
      expected_version: invalidTraceCase.version, trace_id: "wrong-task-trace", input_digest: "i", response_digest: "r", decision: "accepted", expected_claim_ids: [candidate.id] }, true)), /exact case/u);
    const unsupportedDecisionCase = saveCase("adjudication-unsupported-decision");
    await assert.rejects(Promise.resolve().then(() => adjudicateKnowledgeCase(service, unsupportedDecisionCase, "unsupported" as never, [String(candidate.id)])), /decision is unsupported/u);
    const duplicatedLabelsCase = saveCase("adjudication-duplicate-labels");
    await assert.rejects(Promise.resolve().then(() => adjudicateKnowledgeCase(service, duplicatedLabelsCase, "rejected", [String(candidate.id), String(candidate.id)])), /unique values/u);
    const tooManyLabelsCase = saveCase("adjudication-too-many-labels");
    await assert.rejects(Promise.resolve().then(() => adjudicateKnowledgeCase(service, tooManyLabelsCase, "rejected", Array.from({ length: 9 }, (_, index) => `label-${index}`))), /must not exceed eight/u);
    const wrongLabelsCase = saveCase("adjudication-wrong-labels");
    await assert.rejects(Promise.resolve().then(() => adjudicateKnowledgeCase(service, wrongLabelsCase, "accepted", ["not-bound"])), /bound Claims/u);
    const candidateRef = { claim_id: candidate.id, claim_version: candidate.version, identity_digest: candidate.identity_digest, content_digest: candidate.content_digest };
    const staleCandidateCase = service.knowledgeEvaluationCaseSave({ case_id: "adjudication-stale-candidate", query: "Candidate fact",
      expected_claim_ids: [candidate.id], candidate_claim_refs: [candidateRef], ...provenance, label_source: "model_candidate" }).case as JsonObject;
    store.save("knowledge_claim", String(candidate.id), { ...store.get("knowledge_claim", String(candidate.id)), content_digest: "changed-content" });
    await assert.rejects(Promise.resolve().then(() => adjudicateKnowledgeCase(service, staleCandidateCase)), /candidate Claim changed/u);
    const malformedCase = store.create("knowledge_evaluation_case", "adjudication-missing-labels", { scope: "global", query: "legacy", version: 1,
      source_session_id: "held-session", source_task_id: "held-task", source_evidence_ids: [held.id], evaluation_channel: "real_session",
      dataset_partition: "held_out", sanitized: true, label_source: "model_candidate" });
    const malformedRejected = adjudicateKnowledgeCase(service, malformedCase, "rejected", []).case as JsonObject;
    assert.equal(malformedRejected.status, "model_labeled");
    const noEventsCase = saveCase("adjudication-no-events");
    const noEventsTrace = service.traceStart({ trace_id: "no-events-trace", task_id: `knowledge:adjudication:${noEventsCase.id}`, model_fingerprint: "host" }).trace as JsonObject;
    service.traceFinalize({ trace_id: noEventsTrace.id, status: "completed", summary: "no events" });
    const originalTraceGet = service.trace.get.bind(service.trace);
    service.trace.get = (() => ({ trace: { status: "completed", task_id: `knowledge:adjudication:${noEventsCase.id}`, model_fingerprint: "host" }, events: null })) as typeof service.trace.get;
    try {
      await assert.rejects(Promise.resolve().then(() => service.knowledgeEvaluationCaseAdjudicate({ case_id: noEventsCase.id, expected_version: noEventsCase.version,
        trace_id: noEventsTrace.id, input_digest: "i", response_digest: "r", decision: "accepted", expected_claim_ids: [candidate.id] }, true)), /incomplete or not bound/u);
    } finally { service.trace.get = originalTraceGet; }
    const negative = service.knowledgeEvaluationCaseSave({ case_id: "adjudication-rejected", query: "Candidate fact", expected_claim_ids: [candidate.id],
      ...provenance, label_source: "model_candidate" }).case as JsonObject;
    const rejected = adjudicateKnowledgeCase(service, negative, "rejected", []).case as JsonObject;
    assert.equal(rejected.label_source, "model_candidate");
    assert.equal(rejected.status, "model_labeled");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("candidate shadow evaluation measures exact candidate false positives without promoting Claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-shadow-eval-"));
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    service.scopeAliasBind({ scope_kind: "project", scope_id: "project:demo", alias_kind: "path", alias: root });
    service.knowledgeSourceRegister({ source_id: "source", kind: "project_note", label: "Source", trust: "verified", scope_kind: "project", scope_id: "demo", locator: "README.md", content_digest: `sha256:${"b".repeat(64)}` });
    const makeCandidate = (id: string, content: string) => {
      const evidence = service.evidenceRecord({ evidence_id: `${id}-evidence`, source_type: "program", confidence: "confirmed", claim: "Origin task verified this rule.",
        metadata: { source_session_id: `${id}-source-session`, task_id: `${id}-source-task` } });
      return service.knowledgeClaimSave({ claim_id: id, kind: "fact", content, scope: "project:demo", source_id: "source", evidence_ids: [evidence.id] }).claim as JsonObject;
    };
    const relevant = makeCandidate("candidate-alpha", "alphaonly rule");
    const falsePositive = store.create("knowledge_claim", "candidate-beta", { kind: "fact", scope: "project:demo", status: "candidate", content: "betasecret rule" });
    const heldOut = service.evidenceRecord({ evidence_id: "held-out-evidence", source_type: "program", confidence: "confirmed", claim: "Independent held-out result.",
      metadata: { source_session_id: "held-session", task_id: "held-task" } });
    const case_ = service.knowledgeEvaluationCaseSave({ case_id: "held-case", query: "rule", scope: "project:demo", expected_claim_ids: [relevant.id],
      source_session_id: "held-session", source_task_id: "held-task", source_evidence_ids: [heldOut.id], evaluation_channel: "real_session",
      dataset_partition: "held_out", label_source: "operator_asserted", sanitized: true }).case as JsonObject;
    const run = service.knowledgeEvaluationRun({ run_id: "shadow-run", mode: "candidate_shadow", case_ids: [case_.id],
      candidate_claim_ids: [relevant.id, falsePositive.id], top_k: 5 }).run as JsonObject;
    assert.equal(run.status, "insufficient", "a candidate false positive blocks the default precision gate");
    assert.equal((run.metrics as JsonObject).candidate_precision, 0.5);
    assert.equal((run.metrics as JsonObject).candidate_recall, 1);
    assert.deepEqual((run.results as JsonObject[])[0]!.candidate_false_positive_claim_ids, [falsePositive.id]);
    assert.equal(run.changes_routing, false);
    assert.equal((service.knowledgeClaimGet({ claim_id: relevant.id }).claim as JsonObject).status, "candidate");

    const modelCase = service.knowledgeEvaluationCaseSave({ case_id: "model-label-case", query: "alphaonly", scope: "project:demo", expected_claim_ids: [relevant.id],
      source_session_id: "held-session", source_task_id: "held-task", source_evidence_ids: [heldOut.id], evaluation_channel: "real_session",
      dataset_partition: "held_out", label_source: "model_candidate", sanitized: true,
      candidate_claim_refs: [{ claim_id: relevant.id, claim_version: relevant.version,
        identity_digest: relevant.identity_digest, content_digest: relevant.content_digest }] }).case as JsonObject;
    const modelRun = service.knowledgeEvaluationRun({ run_id: "model-label-shadow", mode: "candidate_shadow", case_ids: [modelCase.id],
      candidate_claim_ids: [relevant.id], top_k: 5 }).run as JsonObject;
    assert.equal(modelRun.status, "insufficient");
    assert.equal((modelRun.metrics as JsonObject).provenance_eligible, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Knowledge evaluation cases support stable ID pages while legacy list calls remain compatible", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-case-pages-"));
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    store.create("knowledge_evaluation_case", "case-page-c", { query: "gamma" });
    store.create("knowledge_evaluation_case", "case-page-a", { query: "alpha" });
    store.create("knowledge_evaluation_case", "case-page-b", { query: "beta" });
    const first = service.knowledgeEvaluationCaseList({ after_id: "", limit: 2 });
    assert.deepEqual((first.cases as JsonObject[]).map(item => item.id), ["case-page-a", "case-page-b"]);
    assert.equal(first.has_more, true);
    assert.equal(first.next_cursor, "case-page-b");
    const last = service.knowledgeEvaluationCaseList({ after_id: first.next_cursor, limit: 2 });
    assert.deepEqual((last.cases as JsonObject[]).map(item => item.id), ["case-page-c"]);
    assert.equal(last.has_more, false);
    assert.equal(last.next_cursor, null);
    const filtered = service.knowledgeEvaluationCaseList({ after_id: "", limit: 2, query: "alpha" });
    assert.deepEqual((filtered.cases as JsonObject[]).map(item => item.id), ["case-page-a"]);
    assert.equal(filtered.has_more, true, "cursor advances by scanned rows even when query results are sparse");
    assert.equal((service.knowledgeEvaluationCaseList({ limit: 2 }).cases as JsonObject[]).length, 2);
    assert.equal(Object.hasOwn(service.knowledgeEvaluationCaseList({ limit: 2 }), "has_more"), false);
    assert.throws(() => service.knowledgeEvaluationCaseList({ after_id: "bad/path" }), /after_id is invalid/u);
    assert.throws(() => service.knowledgeEvaluationCaseList({ after_id: "", limit: 1_001 }), /between/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Knowledge evaluation case pagination returns every case beyond the one-thousand-record bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-case-large-page-"));
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    store.transaction(() => {
      for (let index = 0; index < 1_005; index += 1) {
        store.create("knowledge_evaluation_case", `case-${String(index).padStart(4, "0")}`, { query: `query-${index}` });
      }
    });
    const first = service.knowledgeEvaluationCaseList({ after_id: "", limit: 1_000 });
    assert.equal((first.cases as JsonObject[]).length, 1_000);
    assert.equal(first.has_more, true);
    const second = service.knowledgeEvaluationCaseList({ after_id: first.next_cursor, limit: 1_000 });
    assert.equal((second.cases as JsonObject[]).length, 5);
    assert.equal(second.has_more, false);
    assert.equal(new Set([...(first.cases as JsonObject[]), ...(second.cases as JsonObject[])].map(item => item.id)).size, 1_005);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
