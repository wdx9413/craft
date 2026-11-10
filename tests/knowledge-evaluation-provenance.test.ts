import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assessKnowledgeEvaluationProvenance, knowledgeClaimPromotionProofVerified, knowledgeEvaluationAdjudicationVerified, knowledgeEvaluationCaseBindingDigest, knowledgeEvaluationEvidence, knowledgeEvaluationSourceMatches } from "../core/knowledge-evaluation-provenance.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { payload, stableDigest } from "../core/digest.ts";
import { attachVerifiedPromotionFixture } from "./helpers/knowledge-promotion-proof.ts";

test("evaluation source binding rejects legacy, duplicate and changed revisions", () => {
  const claim = { id: "claim", source_id: "source" };
  const source = { id: "source", version: 1, content_digest: "digest", status: "active", trust: "verified" };
  const ref = { claim_id: "claim", source_id: "source", source_version: 1, source_digest: "digest", source_status: "active", source_trust: "verified" };
  assert.equal(knowledgeEvaluationSourceMatches({ candidate_source_refs: [ref] }, claim, source), true);
  for (const run of [{}, { candidate_source_refs: [] }, { candidate_source_refs: [ref, ref] },
    ...["source_id", "source_version", "source_digest", "source_status", "source_trust"].map(key => ({ candidate_source_refs: [{ ...ref, [key]: "changed" }] }))]) {
    assert.equal(knowledgeEvaluationSourceMatches(run, claim, source), false);
  }
  assert.equal(knowledgeEvaluationSourceMatches({ candidate_source_refs: [ref] }, claim, null), false);
  assert.equal(knowledgeEvaluationSourceMatches({ candidate_source_refs: [ref] }, claim, { ...source, status: "disabled" }), false);
  assert.equal(knowledgeEvaluationSourceMatches({ candidate_source_refs: [ref] }, claim, { ...source, version: 2 }), false);
});

test("formal proof rechecks bound support versions, policy and source independence", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-support-proof-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const candidate = store.create("knowledge_claim", "support-proof", { status: "candidate", scope: "global", evidence_ids: [] });
    const promoted = attachVerifiedPromotionFixture(store, candidate);
    const assessmentId = String((promoted.review as JsonObject).promotion_review_id);
    const assessment = store.get("knowledge_auto_review", assessmentId), refs = assessment.support_refs as JsonObject[];
    const support = store.get("knowledge_claim_support", String(refs[0]!.support_id));
    const evidence = store.get("evidence", String(refs[0]!.evidence_id));
    const find = store.find.bind(store);
    const check = (kind: string, id: string, replacement: JsonObject | null) => {
      store.find = ((k: string, key: string, version?: number, hydrate?: boolean) =>
        k === kind && key === id ? replacement : find(k, key, version, hydrate)) as typeof store.find;
      try { assert.equal(knowledgeClaimPromotionProofVerified(store, promoted), false); } finally { store.find = find; }
    };
    for (const changes of [{ support_refs: null }, { required_independent_support: 0 }, { required_independent_support: 11 },
      { minimum_confidence: "unverified" }, { minimum_confidence: "confirmed" }, { support_refs: [] },
      { support_refs: [null, refs[1]] }, { support_refs: [{}, refs[1]] }, { support_refs: [refs[0], refs[0]] }])
      check("knowledge_auto_review", assessmentId, { ...assessment, ...changes });
    for (const changes of [{ version: 2 }, { claim_id: "other" }, { scope: "other" }, { evidence_id: "other" }])
      check("knowledge_claim_support", String(support.id), { ...support, ...changes });
    check("knowledge_claim_support", String(support.id), null);
    for (const changes of [{ version: 2 }, { record_origin: "caller_asserted" }, { confidence: "unverified" },
      { source_id: "missing" }, { metadata: {} }, { metadata: { source_session_id: (store.get("evidence", String(refs[1]!.evidence_id)).metadata as JsonObject).source_session_id } }])
      check("evidence", String(evidence.id), { ...evidence, ...changes });
    check("evidence", String(evidence.id), null);
    const claimEvidenceId = String((promoted.evidence_ids as string[])[0]), claimEvidence = store.get("evidence", claimEvidenceId);
    for (const changes of [{ record_origin: "caller_asserted" }, { confidence: "rejected" },
      { metadata: { ...claimEvidence.metadata as JsonObject, provenance: "codex_session_program_verification" } }])
      check("evidence", claimEvidenceId, { ...claimEvidence, ...changes });
    const checkMultiple = (changes: Record<string, JsonObject | null>, expected: boolean) => {
      store.find = ((k: string, key: string, version?: number, hydrate?: boolean) =>
        Object.hasOwn(changes, `${k}:${key}`) ? changes[`${k}:${key}`] : find(k, key, version, hydrate)) as typeof store.find;
      try { assert.equal(knowledgeClaimPromotionProofVerified(store, promoted), expected); } finally { store.find = find; }
    };
    const evidenceKey = `evidence:${String(evidence.id)}`;
    for (const source of [null, { status: "disabled", trust: "verified" }, { status: "active", trust: "untrusted" }])
      checkMultiple({ [evidenceKey]: { ...evidence, source_id: "support-source" }, "knowledge_source:support-source": source }, false);
    checkMultiple({ [evidenceKey]: { ...evidence, source_id: "support-source", metadata: null },
      "knowledge_source:support-source": { status: "active", trust: "verified" } }, true);
    const codexScope = "project:demo", codexSource = `knowledge_source_codex_session_${stableDigest(codexScope).slice(-24)}`;
    checkMultiple({ [evidenceKey]: { ...evidence, source_id: codexSource, source_type: "program", metadata: {
      provenance: "codex_session_program_verification", scope: codexScope, task_id: "task", source_session_id: "new-session" } },
    [`knowledge_source:${codexSource}`]: { status: "active", trust: "verified" } }, false);
    checkMultiple({ [evidenceKey]: { ...evidence, confidence: "bounded" },
      [`knowledge_auto_review:${assessmentId}`]: { ...assessment, minimum_confidence: "confirmed" },
      "knowledge_promotion_policy:knowledge-promotion-default": { automatic: true, revision: 1, minimum_confidence: "confirmed", minimum_independent_support: 2 } }, false);
    assert.equal(knowledgeClaimPromotionProofVerified(store, promoted), true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("formal Knowledge eligibility verifies the exact local promotion proof and rejects drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-promotion-proof-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("knowledge_source", "proof-source", { scope: { kind: "global", id: "global" }, status: "active", trust: "verified", content_digest: "source-v1" });
    const candidate = store.create("knowledge_claim", "proof-claim", { status: "candidate", source_id: "proof-source", scope: "global",
      identity_digest: "identity-v1", content_digest: "content-v1", evidence_ids: [] });
    const promoted = attachVerifiedPromotionFixture(store, candidate);
    assert.equal(knowledgeClaimPromotionProofVerified(store, promoted), true);
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, identity_digest: undefined }), false);
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, content_digest: undefined }), false);
    const tagged = store.save("knowledge_claim", String(promoted.id), { ...promoted, scenario_key: "engineering.release", tags: ["release"] });
    assert.equal(knowledgeClaimPromotionProofVerified(store, tagged), true, "non-content classification updates must retain the historical promotion proof");
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, status: "candidate" }), false);
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, version: 1 }), false);
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, review: { ...(promoted.review as JsonObject), reviewer: "human" } }), false);
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, review: { ...(promoted.review as JsonObject), policy_revision: 2 } }), false);
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, review: { ...(promoted.review as JsonObject), promotion_claim_version: 1 } }), false);
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, review: { ...(promoted.review as JsonObject), promotion_claim_version: Number(promoted.version) + 1 } }), false);
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, source_id: "missing-source" }), false);
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, source_id: null }), false);
    const originalGet = store.get.bind(store);
    store.get = ((type: string, id: string, version?: number) => {
      if (type === "knowledge_claim" && id === String(promoted.id) && version === Number((promoted.review as JsonObject).promotion_claim_version)) throw new Error("fixture read failure");
      return originalGet(type, id, version);
    }) as typeof store.get;
    assert.equal(knowledgeClaimPromotionProofVerified(store, promoted), false);
    store.get = originalGet;
    const originalGetForRevision = store.get.bind(store);
    const originalFindForRevision = store.find.bind(store);
    const verifyWithRevision = (claimPatch: JsonObject, revisionPatch: JsonObject, findPatch: { assessment?: JsonObject; run?: JsonObject; case?: JsonObject } = {}, expected = false) => {
      const revision = originalGetForRevision("knowledge_claim", String(promoted.id), Number((promoted.review as JsonObject).promotion_claim_version));
      store.get = ((type: string, id: string, version?: number) => type === "knowledge_claim" && id === String(promoted.id)
        && version === Number((promoted.review as JsonObject).promotion_claim_version)
        ? { ...revision, ...revisionPatch } : originalGetForRevision(type, id, version)) as typeof store.get;
      store.find = ((type: string, id: string, version?: number, hydrate?: boolean) => {
        const found = originalFindForRevision(type, id, version, hydrate);
        if (!found) return found;
        if (type === "knowledge_auto_review" && findPatch.assessment) return { ...found, ...findPatch.assessment };
        if (type === "knowledge_evaluation_run" && findPatch.run) return { ...found, ...findPatch.run };
        if (type === "knowledge_evaluation_case" && findPatch.case) return { ...found, ...findPatch.case };
        return found;
      }) as typeof store.find;
      try { assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, ...claimPatch }), expected); }
      finally { store.get = originalGetForRevision; store.find = originalFindForRevision; }
    };
    verifyWithRevision({ source_id: null }, { source_id: null });
    verifyWithRevision({ review: { ...(promoted.review as JsonObject), effectiveness_run_id: undefined } },
      { review: { ...(promoted.review as JsonObject), effectiveness_run_id: undefined } });
    verifyWithRevision({ review: { ...(promoted.review as JsonObject), promotion_review_id: undefined } },
      { review: { ...(promoted.review as JsonObject), promotion_review_id: undefined } });
    verifyWithRevision({ review: undefined }, { review: undefined });
    verifyWithRevision({ review: { ...(promoted.review as JsonObject), policy_id: undefined } },
      { review: { ...(promoted.review as JsonObject), policy_id: undefined } });
    verifyWithRevision({}, { review: null });
    // Even mutually consistent metadata edits invalidate the already-issued effect receipt.
    verifyWithRevision({ identity_digest: undefined }, { identity_digest: null }, {
      assessment: { claim_identity_digest: null },
      run: { candidate_claim_refs: [{ claim_id: promoted.id, claim_version: Number(promoted.version) - 1, identity_digest: null, content_digest: promoted.content_digest }] },
    });
    verifyWithRevision({ identity_digest: undefined, content_digest: undefined }, { identity_digest: null, content_digest: null }, {
      assessment: { claim_identity_digest: null },
      run: { candidate_claim_refs: [{ claim_id: promoted.id, claim_version: Number(promoted.version) - 1, identity_digest: null, content_digest: null }] },
    });
    verifyWithRevision({}, {}, { case: { dataset_partition: "development" } });
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, review: { ...(promoted.review as JsonObject), source_digest: "source-old" } }), false);
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, review: { ...(promoted.review as JsonObject), effectiveness_run_id: "missing-run" } }), false);
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, review: { ...(promoted.review as JsonObject), promotion_review_id: "missing-review" } }), false);
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...tagged, content_digest: "changed-content" }), false);
    const currentRun = store.get("knowledge_evaluation_run", String((promoted.review as JsonObject).effectiveness_run_id));
    const tamperRun = (patch: JsonObject) => {
      const savedRun = store.get("knowledge_evaluation_run", String(currentRun.id));
      store.database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?")
        .run(JSON.stringify({ ...payload(savedRun), ...patch }), "knowledge_evaluation_run", String(currentRun.id), Number(savedRun.version));
      assert.equal(knowledgeClaimPromotionProofVerified(store, promoted), false);
      store.database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?")
        .run(JSON.stringify(payload(currentRun)), "knowledge_evaluation_run", String(currentRun.id), Number(savedRun.version));
    };
    tamperRun({ candidate_claim_refs: [] });
    tamperRun({ candidate_claim_refs: null });
    tamperRun({ candidate_claim_refs: [{ claim_id: promoted.id }] });
    tamperRun({ candidate_claim_refs: [{ claim_id: "different-claim" }] });
    tamperRun({ case_refs: [] });
    tamperRun({ case_refs: null });
    tamperRun({ case_ids: [] });
    tamperRun({ case_ids: null });
    tamperRun({ case_refs: [{ case_id: 7 }] });
    // A case id that is not in the run's case_ids, and a case whose stored
    // version drifted from the ref, are both rejected.
    tamperRun({ case_ids: ["a-different-case"] });
    verifyWithRevision({}, {}, { case: { version: 999 } });
    verifyWithRevision({}, {}, { case: { identity_digest: "different-case-identity" } });
    const originalRefs = currentRun.candidate_claim_refs as JsonObject[];
    for (const field of ["claim_version", "identity_digest", "content_digest"]) {
      const altered = { ...originalRefs[0]!, [field]: `wrong-${field}` };
      tamperRun({ candidate_claim_refs: [altered] });
    }
    store.create("knowledge_promotion_policy", "knowledge-promotion-default", { scope: { kind: "global", id: "global" }, automatic: true, revision: 1 });
    assert.equal(knowledgeClaimPromotionProofVerified(store, promoted), true);
    store.save("knowledge_evaluation_run", String(currentRun.id), { ...payload(currentRun), mode: "development" });
    assert.equal(knowledgeClaimPromotionProofVerified(store, promoted), false);
    const changedRun = store.get("knowledge_evaluation_run", String(currentRun.id));
    store.save("knowledge_evaluation_run", String(currentRun.id), { ...payload(changedRun), mode: currentRun.mode });
    const currentCase = store.get("knowledge_evaluation_case", String((currentRun.case_ids as string[])[0]));
    store.save("knowledge_evaluation_case", String(currentCase.id), { ...payload(currentCase), fixture_mutation: true });
    assert.equal(knowledgeClaimPromotionProofVerified(store, promoted), false);
    const changedCase = store.get("knowledge_evaluation_case", String(currentCase.id));
    store.save("knowledge_evaluation_case", String(currentCase.id), { ...payload(changedCase), dataset_partition: "development" });
    assert.equal(knowledgeClaimPromotionProofVerified(store, promoted), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Knowledge evaluation evidence is resolved without losing missing provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-eval-provenance-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("evidence", "source", { scope: "global", confidence: "confirmed", metadata: { source_session_id: "evaluation", task_id: "eval-task" } });
    store.create("evidence", "claim-evidence", { scope: "global", confidence: "confirmed", metadata: { source_session_id: "claim", task_id: "claim-task" } });
    store.create("knowledge_claim", "claim", { scope: "global", evidence_ids: ["claim-evidence"] });
    store.create("knowledge_claim", "claim-without-evidence", { scope: "global" });
    const unavailableClaim = store.create("knowledge_claim", "claim-with-unavailable-evidence", { scope: "global", evidence_ids: [] });
    store.database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?")
      .run(JSON.stringify({ ...payload(unavailableClaim), evidence_ids: ["missing-evidence", 1] }), "knowledge_claim",
        String(unavailableClaim.id), Number(unavailableClaim.version));
    const resolved = knowledgeEvaluationEvidence(store, { source_evidence_ids: ["source", "missing", "source", 1], expected_claim_ids: ["claim", "missing-claim", "claim", 1] });
    assert.deepEqual(resolved.sourceEvidence.map((item) => item.id), ["source"]);
    assert.deepEqual(resolved.claimEvidence.map((item) => [item.claim_id, item.evidence.id]), [["claim", "claim-evidence"]]);
    const unavailable = knowledgeEvaluationEvidence(store, { expected_claim_ids: ["claim-with-unavailable-evidence"] });
    assert.deepEqual(unavailable.claimEvidence.map(item => [item.claim_id, item.evidence.status]), [
      ["claim-with-unavailable-evidence", "unavailable_source_evidence"], ["claim-with-unavailable-evidence", "unavailable_source_evidence"],
    ]);
    assert.equal(assessKnowledgeEvaluationProvenance({ source_session_id: "evaluation", source_task_id: "eval-task", source_evidence_ids: ["source"],
      evaluation_channel: "real_session", dataset_partition: "held_out", label_source: "operator_asserted", sanitized: true, expected_claim_ids: ["claim"] }, resolved.sourceEvidence, resolved.claimEvidence).status, "unadjudicated_label");
    assert.deepEqual(knowledgeEvaluationEvidence(store, { expected_claim_ids: ["claim-without-evidence"] }).claimEvidence, []);
    assert.deepEqual(knowledgeEvaluationEvidence(store, {}).sourceEvidence, []);
    assert.deepEqual(knowledgeEvaluationEvidence(store, {}).claimEvidence, []);
    // Legacy cases carry only candidate_claim_refs. Malformed entries are
    // dropped rather than trusted, and duplicates collapse to one claim.
    const fromRefs = knowledgeEvaluationEvidence(store, {
      candidate_claim_refs: [null, 7, { claim_id: 5 }, { claim_id: "claim" }, { claim_id: "claim" }, "-bad-"],
    });
    assert.deepEqual(fromRefs.claimEvidence.map((item) => [item.claim_id, item.evidence.id]), [["claim", "claim-evidence"]]);
    assert.deepEqual(knowledgeEvaluationEvidence(store, { candidate_claim_refs: [null, { claim_id: 1 }] }).claimEvidence, []);
    // The same filter guards eligibility derivation, including the empty result.
    const eligibility = (item: JsonObject) => assessKnowledgeEvaluationProvenance(item,
      [{ id: "source", confidence: "confirmed", metadata: { source_session_id: "evaluation", task_id: "eval-task" } }],
      fromRefs.claimEvidence, true);
    // The legacy ref list is still consulted when expected_claim_ids is absent.
    assert.equal(typeof eligibility({ source_session_id: "evaluation", source_task_id: "eval-task", source_evidence_ids: ["source"],
      evaluation_channel: "real_session", dataset_partition: "held_out", label_source: "host_adjudicated", sanitized: true,
      candidate_claim_refs: [null, 7, { claim_id: 5 }, { claim_id: "claim" }] }).status, "string");
    assert.equal(eligibility({ source_session_id: "evaluation", source_task_id: "eval-task", source_evidence_ids: ["source"],
      evaluation_channel: "real_session", dataset_partition: "held_out", label_source: "host_adjudicated", sanitized: true,
      candidate_claim_refs: [null, 7] }).status, "missing_claim_evidence");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Knowledge adjudication case digest supplies explicit null and empty defaults for legacy cases", () => {
  const digest = knowledgeEvaluationCaseBindingDigest({ id: "legacy", version: 1 });
  assert.match(digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(digest, knowledgeEvaluationCaseBindingDigest({ id: "legacy", version: 1, identity_digest: null,
    candidate_claim_refs: [], source_evidence_ids: [] }));
  // A bound task contract changes the digest; an absent one must not be the
  // same as an explicit null.
  const withContract = knowledgeEvaluationCaseBindingDigest({ id: "legacy", version: 1, task_contract: { goal: "g" } });
  assert.notEqual(withContract, digest);
  assert.match(withContract, /^sha256:[a-f0-9]{64}$/u);
  assert.notEqual(knowledgeEvaluationCaseBindingDigest({ id: "legacy", version: 1, task_contract: { goal: "h" } }), withContract);
});

test("Only sanitized independent real-session held-out Knowledge cases are evaluation eligible", () => {
  const sourceEvidence = [{ id: "eval-evidence", confidence: "confirmed", metadata: { source_session_id: "eval-session", task_id: "eval-task", source_ref_digest: `sha256:${"a".repeat(64)}` } } as JsonObject];
  const independentClaimEvidence = [{ claim_id: "claim", evidence: { id: "claim-evidence", metadata: { source_session_id: "claim-session", task_id: "claim-task", source_ref_digest: `sha256:${"b".repeat(64)}` } } as JsonObject }];
  const base: JsonObject = {
    source_session_id: "eval-session", source_task_id: "eval-task", source_evidence_ids: ["eval-evidence"],
    evaluation_channel: "real_session", dataset_partition: "held_out", label_source: "host_adjudicated", sanitized: true, expected_claim_ids: ["claim"],
  };
  const assess = (item: JsonObject, sources = sourceEvidence, claims = independentClaimEvidence) =>
    assessKnowledgeEvaluationProvenance(item, sources, claims, item.label_source === "host_adjudicated");

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
  assert.equal(assess({ ...base, label_source: "model_candidate" }).status, "model_labeled");
  assert.equal(assess({ ...base, label_source: "operator_asserted" }).status, "unadjudicated_label");
  assert.equal(assess({ ...base, label_source: undefined }).status, "unadjudicated_label");
  assert.equal(assess({ ...base, label_source: "unsupported" }).status, "unsupported_provenance");
  assert.equal(assess({ ...base, source_evidence_ids: [] }).status, "missing_source_evidence");
  assert.equal(assess({ ...base, source_evidence_ids: [1] }).status, "unverified_source_evidence");
  assert.equal(assess(base, []).status, "unverified_source_evidence");
  assert.equal(assess(base, [{ ...sourceEvidence[0]!, confidence: "unverified" }]).status, "unverified_source_evidence");
  assert.deepEqual(assess(base, [{ ...sourceEvidence[0]!, metadata: { ...sourceEvidence[0]!.metadata as JsonObject,
    provenance: "codex_session_program_verification" } }]), { status: "insufficient_outcome_evidence", evaluation_eligible: false });
  const transcript = { ...sourceEvidence[0]!, id: "test-only", metadata: { ...sourceEvidence[0]!.metadata as JsonObject,
    provenance: "codex_session_program_verification" } };
  assert.deepEqual(assess({ ...base, source_evidence_ids: ["test-only", "eval-evidence"] }, [transcript, sourceEvidence[0]!]),
    { status: "insufficient_outcome_evidence", evaluation_eligible: false });
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
  const sameSourceRef = `sha256:${"a".repeat(64)}`;
  assert.equal(assess(base, [{ ...sourceEvidence[0]!, metadata: { ...(sourceEvidence[0]!.metadata as JsonObject), source_ref_digest: sameSourceRef } }],
    [{ claim_id: "claim", evidence: { metadata: { source_session_id: "different-session", task_id: "different-task", source_ref_digest: sameSourceRef } } }]).status, "session_leak");
  assert.equal(assess(base, [{ ...sourceEvidence[0]!, metadata: { ...(sourceEvidence[0]!.metadata as JsonObject), source_ref_digest: sameSourceRef } }],
    [{ claim_id: "claim", evidence: { metadata: { source_session_id: "different-session", task_id: "different-task", source_ref_digest: `sha256:${"b".repeat(64)}` } } }]).status, "verified_independent");
  const sameGoal = `sha256:${"c".repeat(64)}`;
  assert.equal(assess(base, [{ ...sourceEvidence[0]!, metadata: { ...(sourceEvidence[0]!.metadata as JsonObject), task_goal_digest: sameGoal } }],
    [{ claim_id: "claim", evidence: { metadata: { source_session_id: "different-session", task_id: "different-task", source_ref_digest: `sha256:${"b".repeat(64)}`, task_goal_digest: sameGoal } } }]).status, "session_leak");
  const valid = assess(base);
  assert.deepEqual(valid, { status: "verified_independent", evaluation_eligible: true });
  assert.equal(assess(base, [{ ...sourceEvidence[0]!, metadata: { source_session_id: "eval-session", task_id: "eval-task" } }]).status, "insufficient_independence_evidence");
  assert.equal(assess(base, sourceEvidence, [{ claim_id: "claim", evidence: { metadata: { source_session_id: "claim-session", task_id: "claim-task" } } }]).status, "insufficient_independence_evidence");
});

test("Knowledge evaluation separates exact legacy review attestations from task Sources without trusting forged roles", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-review-role-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("knowledge_source", "source", { scope: "global" });
    store.create("evidence", "task", { confidence: "confirmed", metadata: { source_session_id: "generation", task_id: "generation-task", source_ref_digest: `sha256:${"a".repeat(64)}` } });
    store.create("evidence", "held-out", { confidence: "confirmed", metadata: { source_session_id: "evaluation", task_id: "evaluation-task", source_ref_digest: `sha256:${"b".repeat(64)}` } });
    const reviewId = "knowledge_host_review_bound";
    const attestation = { source_type: "host_model_review", confidence: "bounded",
      metadata: { review_id: reviewId, source_id: "source", source_digest: "sha256:source" } };
    store.create("evidence", "attestation", attestation);
    const claimBody = { scope: "global", source_id: "source", identity_digest: "sha256:identity", evidence_ids: ["task", "attestation"],
      review: { review_id: reviewId, packet_digest: "sha256:packet", source_digest: "sha256:source" } };
    store.create("knowledge_claim", "claim", claimBody);
    const reviewBody = { scope: "global", claim_id: "claim", decision: "supported", packet_attested: true, packet_digest: "sha256:packet",
      source_id: "source", source_digest: "sha256:source", claim_identity_digest: "sha256:identity" };
    store.create("knowledge_host_review", reviewId, reviewBody);
    const item = { source_session_id: "evaluation", source_task_id: "evaluation-task", source_evidence_ids: ["held-out"],
      evaluation_channel: "real_session", dataset_partition: "held_out", label_source: "host_adjudicated", sanitized: true, expected_claim_ids: ["claim"] };
    const assess = () => { const resolved = knowledgeEvaluationEvidence(store, item); return assessKnowledgeEvaluationProvenance(item, resolved.sourceEvidence, resolved.claimEvidence, true); };
    assert.equal(assess().status, "verified_independent");
    assert.deepEqual(knowledgeEvaluationEvidence(store, item).claimEvidence.map(entry => entry.evidence.id), ["task"]);
    for (const change of [{ claim_id: "different" }, { decision: "rejected" }, { packet_attested: false }, { packet_digest: null },
      { packet_digest: "sha256:other" }, { source_id: "different" }, { source_digest: "sha256:other" }, { claim_identity_digest: "sha256:other" }]) {
      store.save("knowledge_host_review", reviewId, { ...reviewBody, ...change });
      assert.equal(assess().status, "unverified_claim_source");
    }
    store.save("knowledge_host_review", reviewId, reviewBody);
    for (const [index, change] of [{ metadata: undefined }, { metadata: { review_id: "unbound" } }, { metadata: { review_id: reviewId, source_digest: "sha256:other" } }].entries()) {
      const evidenceId = `malformed-attestation-${index}`;
      store.create("evidence", evidenceId, { ...attestation, scope: "global", ...change });
      store.save("knowledge_claim", "claim", { ...claimBody, evidence_ids: ["task", evidenceId] });
      assert.equal(assess().status, "unverified_claim_source");
    }
    store.save("knowledge_claim", "claim", { ...claimBody, review: undefined });
    assert.equal(assess().status, "unverified_claim_source");
    store.save("knowledge_claim", "claim", { ...claimBody, identity_digest: undefined });
    assert.equal(assess().status, "unverified_claim_source");
    store.save("knowledge_claim", "claim", claimBody);
    store.remove("knowledge_host_review", reviewId);
    assert.equal(assess().status, "unverified_claim_source");
    // A review attestation for a Claim that no longer exists is not a Source.
    store.create("knowledge_host_review", reviewId, reviewBody);
    store.create("knowledge_claim", "orphan-attestation", { scope: "global", evidence_ids: ["attestation"] });
    assert.deepEqual(knowledgeEvaluationEvidence(store, { expected_claim_ids: ["missing-claim"] }).claimEvidence, []);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("adjudication proof requires an explicit claim list and the exact bound case", () => {
  const item = { id: "case", version: 1, identity_digest: "identity", label_source: "host_adjudicated",
    adjudication_id: "adjudication", expected_claim_ids: ["claim"] };
  const record = { execution_origin: "managed_codex_cli", case_id: "case", status: "adjudicated", result_case_version: 1,
    result_case_identity_digest: "identity", decision: "accepted", expected_claim_ids: ["claim"] };
  // This function only reads one immutable record, so an in-memory store is
  // enough to pin the binding without creating a full Knowledge partition.
  const store = (found: JsonObject) => ({ find: () => found }) as unknown as CraftStore;
  assert.equal(knowledgeEvaluationAdjudicationVerified(store(record), item), true);
  // The accepted label must name every expected Claim it covers; an omitted
  // list is a missing binding, not an empty one.
  assert.equal(knowledgeEvaluationAdjudicationVerified(store({ ...record, expected_claim_ids: undefined }), item), false);
  // The binding is only meaningful when the case points at a recorded adjudication.
  assert.equal(knowledgeEvaluationAdjudicationVerified(store(record), { ...item, adjudication_id: 1 }), false);
  // A case whose adjudication also covered a task contract must bind that
  // contract digest; when present it must match exactly.
  const contracted = { ...record, task_contract_digest: stableDigest({ goal: "g" }) };
  assert.equal(knowledgeEvaluationAdjudicationVerified(store(contracted), { ...item, task_contract: { goal: "g" } }), true);
  assert.equal(knowledgeEvaluationAdjudicationVerified(store(contracted), { ...item, task_contract: { goal: "h" } }), false);
});

test("promotion proof rejects malformed run candidate and case reference arrays", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-run-refs-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("knowledge_source", "proof-source", { scope: { kind: "global", id: "global" }, status: "active", trust: "verified", content_digest: "source-v1" });
    const candidate = store.create("knowledge_claim", "proof-claim", { status: "candidate", source_id: "proof-source", scope: "global",
      identity_digest: "identity-v1", content_digest: "content-v1", evidence_ids: [] });
    const promoted = attachVerifiedPromotionFixture(store, candidate);
    const runId = String((promoted.review as JsonObject).effectiveness_run_id);
    const baseRun = store.get("knowledge_evaluation_run", runId);
    const saveRun = (patch: JsonObject) => store.database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?")
      .run(JSON.stringify({ ...payload(baseRun), ...patch }), "knowledge_evaluation_run", String(runId), Number(baseRun.version));
    const ok = () => knowledgeClaimPromotionProofVerified(store, promoted);
    const ref = (baseRun.case_refs as JsonObject[])[0]!;
    const restoreRun = () => saveRun({ candidate_claim_refs: baseRun.candidate_claim_refs, case_refs: baseRun.case_refs, case_ids: baseRun.case_ids });

    // A missing candidate reference array collapses to an empty match set.
    const run = store.get("knowledge_evaluation_run", runId);
    assert.ok(Array.isArray(run.candidate_claim_refs), "fixture run must carry candidate refs");
    saveRun({ candidate_claim_refs: null });
    const runNull = store.get("knowledge_evaluation_run", runId);
    assert.equal(Array.isArray(runNull.candidate_claim_refs), false, "mutation should null the array");
    assert.equal(ok(), false, "null candidate refs must reject promotion");
    restoreRun();
    // A missing case reference array makes the run report no cases.
    saveRun({ case_refs: null });
    assert.equal(ok(), false);
    restoreRun();
    // A missing case id array forces a length mismatch against the case refs.
    saveRun({ case_ids: null });
    assert.equal(ok(), false);
    restoreRun();
    // A case ref whose id is not a string is rejected before any lookup.
    saveRun({ case_refs: [{ ...ref, case_id: 7 }], case_ids: ["7"] });
    assert.equal(ok(), false);
    restoreRun();
    // A case ref naming a case that no longer exists is rejected.
    saveRun({ case_refs: [{ ...ref, case_id: "missing-case" }], case_ids: ["missing-case"] });
    assert.equal(ok(), false);
    restoreRun();
    // A case ref whose stored version drifted from the run is rejected.
    saveRun({ case_refs: [{ ...ref, case_version: 999 }] });
    assert.equal(ok(), false);
    restoreRun();
    // A case ref whose stored identity drifted from the run is rejected.
    saveRun({ case_refs: [{ ...ref, identity_digest: "wrong-identity" }] });
    assert.equal(ok(), false);
    restoreRun();
    // A case whose adjudication record is missing no longer proves eligibility.
    const caseItem = store.get("knowledge_evaluation_case", String((baseRun.case_ids as string[])[0]));
    const adjudicationId = String(caseItem.adjudication_id);
    const adjudication = store.find("knowledge_evaluation_adjudication", adjudicationId)!;
    store.remove("knowledge_evaluation_adjudication", adjudicationId);
    assert.equal(ok(), false);
    store.create("knowledge_evaluation_adjudication", adjudicationId, adjudication);

    // The null-identity fallback in the candidate reference comparison is only
    // reached when the promoted Claim itself carries no identity digest.
    const promotionVersion = Number((promoted.review as JsonObject).promotion_claim_version);
    const revision = store.get("knowledge_claim", String(promoted.id), promotionVersion);
    store.database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?")
      .run(JSON.stringify({ ...payload(revision), identity_digest: null, content_digest: null }), "knowledge_claim", String(promoted.id), Number(revision.version));
    assert.equal(knowledgeClaimPromotionProofVerified(store, { ...promoted, identity_digest: null, content_digest: null }), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
