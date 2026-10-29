import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftService } from "../core/service.ts";
import { stableDigest } from "../core/digest.ts";
import { craftPaths, projectStorageDirectory } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { adjudicateKnowledgeCase } from "./helpers/knowledge-evaluation-adjudication.ts";
import { createActionHandlers } from "../core/application/actions/action-handlers.ts";
import { attachVerifiedPromotionFixture } from "./helpers/knowledge-promotion-proof.ts";
import { knowledgeClaimPromotionProofVerified } from "../core/knowledge-evaluation-provenance.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-promotion-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  service.scopeAliasBind({ scope_kind: "project", scope_id: "project:demo", alias_kind: "path", alias: root });
  service.knowledgeSourceRegister({ source_id: "source", kind: "project_note", label: "Source", trust: "verified", scope_kind: "project", scope_id: "demo", locator: "README.md", content_digest: `sha256:${"b".repeat(64)}` });
  return { root, store, service };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }

function candidate(service: CraftService, id = "claim") {
  const first = service.evidenceRecord({ evidence_id: `${id}-e1`, source_type: "observation", confidence: "confirmed", claim: "first observed fact",
    metadata: { source_session_id: `${id}-source-session`, task_id: `${id}-source-task`, source_ref_digest: stableDigest(`${id}-source`) } });
  const claim = service.knowledgeClaimSave({ claim_id: id, kind: "fact", content: "Run the focused test first.", scope: "project:demo", source_id: "source", evidence_ids: [first.id] }).claim as JsonObject;
  return { claim, first };
}

function evaluateCandidate(f: Awaited<ReturnType<typeof fixture>>, claim: JsonObject, caseId = `held-out-${claim.id}`) {
  const sessionId = `${caseId}-session`, taskId = `${caseId}-task`;
  const claimContent = typeof claim.content === "string" ? claim.content
    : f.store.contentStore.readCompatSync(claim.content_ref as never, String(claim.scope)).body;
  const evidence = f.service.evidenceRecord({ evidence_id: `${caseId}-evidence`, source_type: "program", confidence: "confirmed",
    claim: "Independent held-out task label.", metadata: { source_session_id: sessionId, task_id: taskId, source_ref_digest: stableDigest(sessionId) } });
  const caseRecord = f.service.knowledgeEvaluationCaseSave({ case_id: caseId, query: claimContent, scope: String(claim.scope),
    expected_claim_ids: [String(claim.id)], source_session_id: sessionId, source_task_id: taskId, source_evidence_ids: [evidence.id],
    evaluation_channel: "real_session", dataset_partition: "held_out", label_source: "model_candidate", sanitized: true,
    candidate_claim_refs: [{ claim_id: claim.id, claim_version: claim.version, identity_digest: claim.identity_digest, content_digest: claim.content_digest }] }).case as JsonObject;
  const adjudicated = adjudicateKnowledgeCase(f.service, caseRecord).case as JsonObject;
  return f.service.knowledgeEvaluationRun({ run_id: `shadow-${claim.id}-${caseId}`, mode: "candidate_shadow", case_ids: [adjudicated.id],
    candidate_claim_ids: [String(claim.id)], top_k: 5 }).run as JsonObject;
}

test("a source revision change invalidates an earlier candidate evaluation", async () => {
  const f = await fixture();
  try {
    const { claim, first } = candidate(f.service, "changed-source");
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: first.id, observation_key: "first" });
    const second = f.service.evidenceRecord({ evidence_id: "changed-source-support", source_type: "receipt", confidence: "confirmed",
      claim: "independent observation", metadata: { source_session_id: "second-session", task_id: "second-task" } });
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: second.id, observation_key: "second" });
    const evaluation = evaluateCandidate(f, claim);
    assert.equal(evaluation.status, "eligible");
    const currentSource = f.store.get("knowledge_source", "source");
    f.store.save("knowledge_source", "source", { ...currentSource, content_digest: `sha256:${"c".repeat(64)}` });
    const result = f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id] });
    const assessment = (result.assessments as JsonObject[])[0]!;
    assert.equal(assessment.promoted, false);
    assert((assessment.reasons as string[]).includes("independent_effectiveness_evaluation_required"));
  } finally { await close(f); }
});

test("retrieval-only shadow evaluation cannot automatically promote Knowledge", async () => {
  const f = await fixture();
  try {
    const { claim, first } = candidate(f.service);
    assert.equal((f.service.knowledgePromotionPolicyGet().policy as JsonObject).minimum_independent_support, 2);
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: first.id, observation_key: "run:one" });
    const insufficient = f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id], now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[];
    assert.equal(insufficient[0]!.verdict, "revalidation_required");
    assert.equal(insufficient[0]!.promoted, false);
    const second = f.service.evidenceRecord({ evidence_id: "claim-e2", source_type: "receipt", confidence: "confirmed", claim: "second observed fact",
      metadata: { source_session_id: "claim-session-two", task_id: "claim-task-two" } });
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: second.id, observation_key: "run:two" });
    const heldBeforeEvaluation = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id], auto_promote: false }).assessments as JsonObject[])[0]!;
    assert((heldBeforeEvaluation.reasons as string[]).includes("independent_effectiveness_evaluation_required"));
    const shadow = evaluateCandidate(f, claim);
    assert.equal(shadow.status, "eligible");
    f.store.create("knowledge_claim", "unrelated-claim", { scope: "project:demo", status: "candidate", source_id: "source", content: "Unrelated fact." });
    f.store.create("knowledge_evaluation_run", "older-unrelated-eligible-run", { scope: "project:demo", mode: "candidate_shadow", status: "eligible",
      candidate_claim_refs: [{ claim_id: "unrelated-claim" }], created_at: "2026-09-19T00:00:00.000Z" });
    const list = f.store.list.bind(f.store);
    (f.store as unknown as { list: CraftStore["list"] }).list = ((kind: string, limit?: number, predicate?: (record: JsonObject) => boolean) => {
      const records = list(kind, limit, predicate);
      if (kind !== "knowledge_evaluation_run") return records;
      return records.map(record => { const { created_at: _createdAt, ...withoutTimestamp } = record; return withoutTimestamp; });
    }) as CraftStore["list"];
    const automatic = f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id], now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[];
    (f.store as unknown as { list: CraftStore["list"] }).list = list;
    assert.equal(automatic[0]!.promoted, false);
    assert((automatic[0]!.reasons as string[]).includes("independent_effectiveness_evaluation_required"));
    assert.equal(f.store.get("knowledge_claim", String(claim.id)).status, "candidate");
  } finally { await close(f); }
});

test("previous retrieval-only promotion cannot enter formal Knowledge context", async () => {
  const f = await fixture();
  try {
    const reviewed = attachVerifiedPromotionFixture(f.store, candidate(f.service, "legacy-retrieval-only").claim);
    assert.equal(reviewed.status, "reviewed");
    assert.equal(knowledgeClaimPromotionProofVerified(f.store, reviewed), false);
    assert.deepEqual(f.service.wikiContextCompile({ query: "focused test", scope: "project:demo" }).included, []);
  } finally { await close(f); }
});

test("unavailable task effect verifier preserves reviewed claim while retrieval stays closed", async () => {
  const f = await fixture();
  try {
    const reviewed = attachVerifiedPromotionFixture(f.store, candidate(f.service, "effect-verifier-unavailable").claim);
    const before = f.store.get("knowledge_claim", String(reviewed.id));
    const assessment = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [reviewed.id] }).assessments as JsonObject[])[0]!;
    assert.equal(assessment.verdict, "revalidation_required");
    assert.equal(assessment.promoted, false);
    assert((assessment.reasons as string[]).includes("independent_effectiveness_evaluation_required"));
    assert.deepEqual(f.store.get("knowledge_claim", String(reviewed.id)), before);
    assert.deepEqual(f.service.wikiContextCompile({ query: "focused test", scope: "project:demo" }).included, []);
  } finally { await close(f); }
});

test("legacy promotion remains excluded while task effect verification is unavailable", async () => {
  const f = await fixture();
  try {
    const { claim, first } = candidate(f.service, "legacy-repromotion");
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: first.id, observation_key: "first" });
    const second = f.service.evidenceRecord({ evidence_id: "legacy-support-2", source_type: "program", confidence: "confirmed",
      claim: "fixture support", metadata: { source_session_id: "legacy-session-2", task_id: "legacy-task-2" } });
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: second.id, observation_key: "second" });
    assert.equal(evaluateCandidate(f, claim).status, "eligible");
    const promoted = attachVerifiedPromotionFixture(f.store, claim);
    const reviewId = String((promoted.review as JsonObject).promotion_review_id);
    const review = f.store.get("knowledge_auto_review", reviewId);
    const { support_refs: _supportRefs, ...oldReview } = review;
    f.store.save("knowledge_auto_review", reviewId, oldReview);
    const firstPass = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id] }).assessments as JsonObject[])[0]!;
    assert.equal(firstPass.promoted, false);
    assert((firstPass.reasons as string[]).includes("independent_effectiveness_evaluation_required"));
    const quarantined = f.store.get("knowledge_claim", String(claim.id));
    assert.equal(quarantined.status, "reviewed");
    assert.equal(knowledgeClaimPromotionProofVerified(f.store, quarantined), false);
    const retry = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id] }).assessments as JsonObject[])[0]!;
    assert.equal(retry.promoted, false);
    assert((retry.reasons as string[]).includes("independent_effectiveness_evaluation_required"));
  } finally { await close(f); }
});

test("candidate effectiveness evaluation cannot promote a changed Claim revision", async () => {
  const f = await fixture();
  try {
    const { claim, first } = candidate(f.service, "stale-shadow");
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: first.id, observation_key: "support-one" });
    const second = f.service.evidenceRecord({ evidence_id: "stale-shadow-second", source_type: "receipt", confidence: "confirmed", claim: "Independent support.",
      metadata: { source_session_id: "stale-shadow-session-two", task_id: "stale-shadow-task-two" } });
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: second.id, observation_key: "support-two" });
    assert.equal(evaluateCandidate(f, claim).status, "eligible");
    const current = f.store.get("knowledge_claim", String(claim.id));
    f.store.save("knowledge_claim", String(claim.id), { ...current, valid_until: "2027-01-01T00:00:00.000Z" });
    const assessment = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id], auto_promote: false }).assessments as JsonObject[])[0]!;
    assert.equal(assessment.promoted, false);
    assert((assessment.reasons as string[]).includes("independent_effectiveness_evaluation_required"));
  } finally { await close(f); }
});

test("automatic review ignores malformed, stale, or model-labeled candidate shadow runs", async () => {
  const f = await fixture();
  try {
    const { claim, first } = candidate(f.service, "untrusted-shadow");
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: first.id, observation_key: "support-one" });
    const second = f.service.evidenceRecord({ evidence_id: "untrusted-shadow-second", source_type: "receipt", confidence: "confirmed", claim: "Independent support.",
      metadata: { source_session_id: "untrusted-shadow-session-two", task_id: "untrusted-shadow-task-two" } });
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: second.id, observation_key: "support-two" });
    const run = evaluateCandidate(f, claim) as JsonObject;
    const invalidRuns: Array<(value: JsonObject) => JsonObject> = [
      (value) => ({ ...value, candidate_claim_refs: null }),
      (value) => ({ ...value, case_refs: null }),
      (value) => ({ ...value, case_ids: null }),
      (value) => ({ ...value, metrics: { ...(value.metrics as JsonObject), provenance_eligible: false } }),
      (value) => ({ ...value, case_refs: [{ case_id: "case-not-listed" }] }),
      (value) => ({ ...value, case_ids: ["missing-case"], case_refs: [{ case_id: "missing-case", case_version: 1, identity_digest: null }] }),
      (value) => ({ ...value, case_refs: [{ ...(value.case_refs as JsonObject[])[0], case_version: -1 }] }),
    ];
    for (const [index, mutate] of invalidRuns.entries()) {
      const currentRun = f.store.get("knowledge_evaluation_run", String(run.id));
      f.store.save("knowledge_evaluation_run", String(run.id), mutate({ ...run, version: currentRun.version, scope: { kind: "project", id: "demo" } }));
      const assessment = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id], auto_promote: false }).assessments as JsonObject[])[0]!;
      assert((assessment.reasons as string[]).includes("independent_effectiveness_evaluation_required"), `invalid run ${index} must not satisfy the gate`);
    }

    const caseRef = (run.case_refs as JsonObject[])[0]!;
    const currentCase = f.store.get("knowledge_evaluation_case", String(caseRef.case_id));
    const modelCase = f.store.save("knowledge_evaluation_case", String(currentCase.id), { ...currentCase, label_source: "model_candidate" });
    const latestRun = f.store.get("knowledge_evaluation_run", String(run.id));
    f.store.save("knowledge_evaluation_run", String(run.id), { ...run, version: latestRun.version, scope: { kind: "project", id: "demo" },
      case_refs: [{ case_id: modelCase.id, case_version: modelCase.version, identity_digest: modelCase.identity_digest }] });
    const modelAssessment = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id], auto_promote: false }).assessments as JsonObject[])[0]!;
    assert((modelAssessment.reasons as string[]).includes("independent_effectiveness_evaluation_required"));
  } finally { await close(f); }
});

test("automatic Knowledge review requires one explicit scope and rejects cross-scope claim ids", async () => {
  const f = await fixture();
  try {
    const { claim } = candidate(f.service, "project-claim");
    f.service.knowledgeSourceRegister({ source_id: "global-source", kind: "project_note", label: "Global source", trust: "verified", scope_kind: "global", scope_id: "global", locator: "global.md", content_digest: `sha256:${"f".repeat(64)}` });
    f.store.create("knowledge_claim", "global-claim", { status: "candidate", scope: "global", source_id: "global-source", content: "Global fact." });
    assert.throws(() => f.service.knowledgeAutoReview({ claim_ids: [claim.id], auto_promote: false }), /scope_kind and scope_id/u);
    assert.throws(() => f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: ["global-claim"], auto_promote: false }), /requested Knowledge scope/u);
    const listed = f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", auto_promote: false });
    assert.deepEqual((listed.assessments as JsonObject[]).map(item => item.claim_id), [claim.id]);
  } finally { await close(f); }
});

test("project Host review packets read both Claim and Evidence from project Knowledge storage", async () => {
  const f = await fixture();
  try {
    const fragmentRef = f.store.contentStore.writeSync({ kind: "knowledge", record_id: "project-fragment", version: 1,
      scope: "project:demo", status: "current", sensitivity: "internal", source_id: "source", body: "Project source evidence." });
    f.store.create("knowledge_fragment", "project-fragment", { source_id: "source", source_revision_id: "revision-1", locator: "README.md#1",
      content_ref: fragmentRef, content_digest: fragmentRef.digest });
    const evidence = f.store.create("evidence", "project-evidence", { source_type: "knowledge_fragment", confidence: "confirmed",
      source_id: "source", fragment_id: "project-fragment" });
    const claim = f.service.knowledgeClaimSave({ claim_id: "project-host-claim", kind: "fact", scope: "project:demo", source_id: "source",
      content: "Project fact from the source.", evidence_ids: [evidence.id] }).claim as JsonObject;
    const claimRef = claim.content_ref as JsonObject;
    assert.ok(String(claimRef.path).startsWith(join(projectStorageDirectory(f.store.paths, f.root), "knowledge", "md")));
    const packet = f.service.knowledgeSemanticReviewPacket({ claim_id: claim.id });
    assert.equal(packet.status, "ready");
    const packetContent = packet.packet as JsonObject;
    assert.equal((packetContent.claim as JsonObject).content, "Project fact from the source.");
    assert.equal(((packetContent.evidence_fragments as JsonObject[])[0]!.content), "Project source evidence.");
    const assessment = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id], auto_promote: false }).assessments as JsonObject[])[0]!;
    assert((assessment.reasons as string[]).includes("independent_support_below_threshold"));
    assert(!(assessment.reasons as string[]).includes("content_reference_invalid"));
  } finally { await close(f); }
});

test("retrieval-only assessment does not advance the project scenario claim", async () => {
  const f = await fixture();
  try {
    const first = f.service.evidenceRecord({ evidence_id: "scene-first", source_type: "observation", confidence: "confirmed", claim: "first support",
      metadata: { source_session_id: "scene-source-session", task_id: "scene-source-task", source_ref_digest: stableDigest("scene-source") } });
    const claim = f.service.knowledgeClaimSave({ claim_id: "scene-auto", kind: "fact", content: "Use the focused validation.", scope: "project:demo",
      source_id: "source", scenario_key: "engineering.validation.focused", coarse_scenario_key: "engineering.validation", evidence_ids: [first.id] }).claim as JsonObject;
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: first.id, observation_key: "scene:one" });
    const second = f.service.evidenceRecord({ evidence_id: "scene-second", source_type: "receipt", confidence: "confirmed", claim: "second support",
      metadata: { source_session_id: "scene-session-two", task_id: "scene-task-two" } });
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: second.id, observation_key: "scene:two" });
    assert.equal(evaluateCandidate(f, claim).status, "eligible");
    const assessment = f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id], now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[];
    assert.equal(assessment[0]!.promoted, false);
    const catalog = JSON.parse(await readFile(join(projectStorageDirectory(f.store.paths, f.root), "knowledge", "projects", "demo", "knowledge-scenarios.json"), "utf8")) as JsonObject;
    const scene = (catalog.scenarios as JsonObject[]).find(item => item.scenario_key === "engineering.validation.focused")!;
    assert.equal(scene.lifecycle, "candidate");
    assert.equal((scene.claim_refs as JsonObject[])[0]!.status, "candidate");
  } finally { await close(f); }
});

test("automatic review keeps inline project Claims scoped when promoting without a Markdown reference", async () => {
  const f = await fixture();
  try {
    const origin = f.service.evidenceRecord({ evidence_id: "inline-origin", source_type: "observation", confidence: "confirmed", claim: "Origin task evidence.",
      metadata: { source_session_id: "inline-origin-session", task_id: "inline-origin-task", source_ref_digest: stableDigest("inline-origin") } });
    const candidate = f.store.create("knowledge_claim", "inline-project-claim", { status: "candidate", kind: "fact", scope: "project:demo",
      source_id: "source", content: "A supported inline project fact.", evidence_ids: [origin.id] });
    for (const [index, claim] of ["First support", "Second support"].entries()) {
      const evidence = f.service.evidenceRecord({ evidence_id: `inline-support-${index}`, source_type: "observation", confidence: "confirmed", claim,
        metadata: { source_session_id: `inline-support-session-${index}`, task_id: `inline-support-task-${index}` } });
      f.service.knowledgeClaimSupportRecord({ claim_id: candidate.id, evidence_id: evidence.id, observation_key: `inline-observation-${index}` });
    }
    assert.equal(evaluateCandidate(f, candidate).status, "eligible");
    const result = f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [candidate.id], now: "2026-09-20T00:00:00.000Z" });
    assert.equal(((result.assessments as JsonObject[])[0]!.verdict), "revalidation_required");
    assert.equal(((result.assessments as JsonObject[])[0]!.promoted), false);
    assert.equal(((result.assessments as JsonObject[])[0]!.claim as JsonObject).status, "candidate");
  } finally { await close(f); }
});

test("independent support counts each source session once and ignores caller-invented observation keys", async () => {
  const f = await fixture();
  try {
    const { claim } = candidate(f.service, "same-session-support");
    const codexSourceId = `knowledge_source_codex_session_${stableDigest("project:demo").slice(-24)}`;
    f.service.knowledgeSourceRegister({ source_id: codexSourceId, kind: "custom", label: "Codex session evidence", trust: "verified",
      scope_kind: "project", scope_id: "demo", locator: "craft://session-evidence", content_digest: "craft:codex-session-verification:v1" });
    const sessionEvidence = (evidenceId: string, sessionId: string, taskId: string) => f.store.create("evidence", evidenceId, {
      source_type: "program", source_id: codexSourceId, confidence: "confirmed", claim: "Verified session evidence.",
      metadata: { provenance: "codex_session_program_verification", scope: "project:demo", source_session_id: sessionId, task_id: taskId },
    });
    const firstSessionEvidence = sessionEvidence("verified-session-one", "session-one", "task-one");
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: firstSessionEvidence.id, observation_key: "caller-key-one" }), /bounded or confirmed/u);
    const duplicateSession = sessionEvidence("verified-session-one-second-task", "session-one", "task-one-b");
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: duplicateSession.id, observation_key: "caller-key-two" }), /bounded or confirmed/u);
    const independentSession = sessionEvidence("verified-session-two", "session-two", "task-two");
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: independentSession.id, observation_key: "caller-key-three" }), /bounded or confirmed/u);
    const unproven = f.service.evidenceRecord({ evidence_id: "same-session-unproven-evidence", source_type: "receipt", confidence: "confirmed", claim: "No source session." });
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: unproven.id, observation_key: "caller-key-four" });
    const assessment = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id], auto_promote: false }).assessments as JsonObject[])[0]!;
    assert.equal(assessment.independent_support, 0);
    assert.equal((assessment.reasons as string[]).includes("independent_support_below_threshold"), true);
    assert.equal(assessment.promoted, false);
  } finally { await close(f); }
});

test("public Evidence assertions cannot count as independent Knowledge support", async () => {
  const f = await fixture();
  try {
    const { claim } = candidate(f.service, "asserted-support");
    assert.equal(evaluateCandidate(f, claim).status, "eligible");
    f.service.registerCanonicalHandlers({});
    const fallback = await (f.service as unknown as { invokeInternalAction(action: string, args: JsonObject): Promise<JsonObject> })
      .invokeInternalAction("evidence_record", { evidence_id: "fallback-assertion", source_type: "program", confidence: "confirmed", claim: "caller assertion" });
    assert.equal(fallback.record_origin, "caller_asserted");
    const publicRecord = createActionHandlers(f.service).craft_evidence_record;
    for (const n of [1, 2]) {
      const evidence = await publicRecord({ evidence_id: `public-support-${n}`, source_type: "program", confidence: "confirmed",
        claim: "caller assertion", record_origin: "managed", metadata: { source_session_id: `session-${n}`, task_id: `task-${n}` } });
      f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: (evidence as JsonObject).id, observation_key: `observation-${n}` });
    }
    const assessment = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id] }).assessments as JsonObject[])[0]!;
    assert.equal(assessment.independent_support, 0);
    assert.equal(assessment.promoted, false);
    assert((assessment.reasons as string[]).includes("independent_support_below_threshold"));
    for (const n of [1, 2]) {
      const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
      const result = f.service.knowledgeSessionEvidenceRecord({ scope: "project:demo", task_id: `claimed-task-${n}`,
        source_session_id: `claimed-session-${n}`, turn_id: `claimed-turn-${n}`, source_ref: sha("a"),
        task_goal: "验证任务", task_result: "测试通过", sanitized: true,
        verification_artifacts: [{ runner: "javascript", command_digest: sha("b"), result_digest: sha("c"), call_digest: sha("d"),
          exit_code: 0, summary_kind: "tests_passed", content_stored: false }] });
      const evidence = result.evidence as JsonObject;
      assert.equal(evidence.record_origin, "caller_asserted");
      assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: evidence.id, observation_key: `session-observation-${n}` }), /bounded or confirmed/u);
    }
    const rechecked = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id] }).assessments as JsonObject[])[0]!;
    assert.equal(rechecked.independent_support, 0); assert.equal(rechecked.promoted, false);
    const assertedSource = await publicRecord({ evidence_id: "public-source", source_type: "program", confidence: "confirmed",
      claim: "caller asserted fact", metadata: { source_session_id: "source-session", task_id: "source-task" } });
    const sourced = f.service.knowledgeClaimSave({ claim_id: "asserted-source", kind: "fact", content: "A claimed fact.", scope: "project:demo",
      source_id: "source", evidence_ids: [(assertedSource as JsonObject).id] }).claim as JsonObject;
    const sourceAssessment = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [sourced.id] }).assessments as JsonObject[])[0]!;
    assert((sourceAssessment.reasons as string[]).includes("credible_evidence_missing"));
  } finally { await close(f); }
});

test("support is idempotent but cannot be duplicated by observation or evidence", async () => {
  const f = await fixture();
  try {
    const { claim, first } = candidate(f.service);
    const firstSave = f.service.knowledgeClaimSupportRecord({ support_id: "support", claim_id: claim.id, evidence_id: first.id, observation_key: "session:a" });
    assert.equal(firstSave.idempotent, false);
    assert.equal(f.service.knowledgeClaimSupportRecord({ support_id: "support", claim_id: claim.id, evidence_id: first.id, observation_key: "session:a" }).idempotent, true);
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: first.id, observation_key: "session:b" }), /evidence is already/u);
    const second = f.service.evidenceRecord({ evidence_id: "e2", source_type: "receipt", confidence: "bounded", claim: "second" });
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: second.id, observation_key: "session:a" }), /observation_key is already/u);
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: second.id, observation_key: "session:b", scope: "project:other" }), /scope must match/u);
    const weak = f.service.evidenceRecord({ evidence_id: "weak", source_type: "model", confidence: "unverified", claim: "guess" });
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: weak.id, observation_key: "session:weak" }), /requires bounded or confirmed/u);
    f.service.knowledgeClaimReview({ claim_id: claim.id, status: "disputed", reviewer: "user", reason: "来源存在争议" });
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: second.id, observation_key: "session:c" }), /only be recorded for a candidate/u);
  } finally { await close(f); }
});

test("local policy can lower a threshold without turning off deterministic safety blocks", async () => {
  const f = await fixture();
  try {
    const { claim, first } = candidate(f.service);
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: first.id, observation_key: "fresh-run" });
    const changed = f.service.knowledgePromotionPolicySave({ minimum_independent_support: 1, minimum_confidence: "confirmed", actor: "operator" });
    assert.equal((changed.policy as JsonObject).revision, 2);
    assert.equal(f.service.knowledgePromotionPolicySave({ minimum_independent_support: 1, minimum_confidence: "confirmed", actor: "another" }).idempotent, true);
    assert.throws(() => f.service.knowledgePromotionPolicySave({ minimum_independent_support: 0 }), /between 1 and 10/u);
    assert.throws(() => f.service.knowledgePromotionPolicySave({ minimum_confidence: "maybe" }), /bounded or confirmed/u);
    assert.equal(evaluateCandidate(f, claim).status, "eligible");
    assert.equal((f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id], now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[])[0]!.promoted, false);

    const conflicted = candidate(f.service, "conflicted");
    f.service.knowledgeClaimSupportRecord({ claim_id: conflicted.claim.id, evidence_id: conflicted.first.id, observation_key: "conflict-one" });
    const other = candidate(f.service, "other");
    f.service.knowledgeRelationSave({ relation_id: "contradiction", from_claim_id: conflicted.claim.id, to_claim_id: other.claim.id, relation: "contradicts" });
    const blocked = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [conflicted.claim.id], now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[])[0]!;
    assert.equal(blocked.promoted, false);
    assert((blocked.reasons as string[]).includes("contradiction_requires_adjudication"));
    assert.equal((f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [other.claim.id], auto_promote: false, now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[])[0]!.promoted, false);
  } finally { await close(f); }
});

test("legacy Host review without an evidence packet stays a non-promoting review record", async () => {
  const f = await fixture();
  try {
    const { claim } = candidate(f.service, "codex-reviewed");
    const args = {
      claim_id: claim.id, host_kind: "codex", host_run_key: "codex:thread-7:turn-3",
      source_digest: `sha256:${"b".repeat(64)}`, decision: "supported", model_ref: "host-managed",
      rubric_id: "knowledge-host-review-v1", reason_code: "rubric_pass", now: "2026-09-20T00:00:00.000Z",
    };
    assert.equal((f.service.knowledgeSemanticReviewPacket({ claim_id: claim.id }) as JsonObject).status, "unavailable");
    assert.equal((await f.service.knowledgeSemanticProviderReview({ claim_id: claim.id }) as JsonObject).status, "unavailable");
    assert.throws(() => f.service.knowledgeHostReview({ ...args, packet_digest: "sha256:not-the-packet" }), /packet_digest/u);
    const result = f.service.knowledgeHostReview(args);
    assert.equal(result.promoted, false);
    assert.equal(result.status, "needs_evidence");
    assert.equal((result.claim as JsonObject).status, "candidate");
    assert.equal((result.review as JsonObject).validation_status, "revalidation_required");
    assert.ok((result.blocking_reasons as string[]).includes("semantic_review_packet_required"));
    assert.equal(f.service.knowledgeHostReview(args).idempotent, true);
  } finally { await close(f); }
});

test("Host review keeps insufficient, stale, conflicted, and rejected Claims outside Context", async () => {
  const f = await fixture();
  try {
    const { claim } = candidate(f.service, "host-blocked");
    const base = { claim_id: claim.id, host_run_key: "codex:one", source_digest: `sha256:${"b".repeat(64)}`, decision: "supported", now: "2026-09-20T00:00:00.000Z" };
    assert.throws(() => f.service.knowledgeHostReview({ ...base, host_kind: "invalid host name" }), /host_kind/u);
    assert.throws(() => f.service.knowledgeHostReview({ ...base, source_digest: "sha256:wrong" }), /source_digest/u);
    assert.throws(() => f.service.knowledgeHostReview({ ...base, decision: "maybe" }), /decision/u);
    assert.throws(() => f.service.knowledgeHostReview({ ...base, reason_code: "not a stable code" }), /reason_code/u);
    assert.throws(() => f.service.knowledgeHostReview({ ...base, now: "bad-date" }), /ISO timestamp/u);

    const deferred = f.service.knowledgeHostReview({ ...base, decision: "needs_evidence", host_kind: "claude", model_ref: "host-managed" });
    assert.equal(deferred.promoted, false);
    assert.equal(deferred.status, "needs_evidence");
    const rejected = f.service.knowledgeHostReview({ ...base, decision: "rejected", host_kind: "independent", host_run_key: "runner:two" });
    assert.equal(rejected.status, "rejected");
    const defaulted = candidate(f.service, "host-defaulted");
    assert.equal(f.service.knowledgeHostReview({ claim_id: defaulted.claim.id, host_run_key: "codex:defaulted", source_digest: `sha256:${"b".repeat(64)}`, decision: "rejected" }).status, "rejected");

    const conflicted = candidate(f.service, "host-conflicted");
    const other = candidate(f.service, "host-other");
    f.service.knowledgeRelationSave({ relation_id: "host-contradiction", from_claim_id: conflicted.claim.id, to_claim_id: other.claim.id, relation: "contradicts" });
    const conflict = f.service.knowledgeHostReview({ ...base, claim_id: conflicted.claim.id, host_run_key: "codex:conflict" });
    assert.equal(conflict.promoted, false);
    assert((conflict.blocking_reasons as string[]).includes("contradiction_requires_adjudication"));

    const raw = f.store.create("knowledge_claim", "host-weak", { status: "candidate", source_id: "source", scope: "project:demo", content: "body", evidence_ids: [] });
    const weak = f.service.knowledgeHostReview({ ...base, claim_id: raw.id, host_run_key: "codex:weak" });
    assert.equal(weak.status, "needs_evidence");
    assert((weak.blocking_reasons as string[]).includes("credible_evidence_missing"));

    const noSource = f.store.create("knowledge_claim", "host-no-source", { status: "candidate", scope: "project:demo", content: "body", evidence_ids: [] });
    assert.throws(() => f.service.knowledgeHostReview({ ...base, claim_id: noSource.id, host_run_key: "codex:no-source" }), /source_digest/u);
    f.service.knowledgeSourceRegister({ source_id: "untrusted", kind: "project_note", label: "Untrusted", trust: "untrusted", scope_kind: "project", scope_id: "demo", locator: "untrusted.md", content_digest: `sha256:${"d".repeat(64)}` });
    const evidence = f.service.evidenceRecord({ evidence_id: "untrusted-evidence", source_type: "observation", confidence: "confirmed", claim: "observed" });
    const untrusted = f.service.knowledgeClaimSave({ claim_id: "host-untrusted", kind: "fact", content: "body", scope: "project:demo", source_id: "untrusted", evidence_ids: [evidence.id] }).claim as JsonObject;
    const untrustedResult = f.service.knowledgeHostReview({ ...base, claim_id: untrusted.id, host_run_key: "codex:untrusted", source_digest: `sha256:${"d".repeat(64)}` });
    assert((untrustedResult.blocking_reasons as string[]).includes("source_not_trusted_active"));

    const expired = f.store.create("knowledge_claim", "host-expired", { status: "candidate", source_id: "source", scope: "project:demo", content: "body", evidence_ids: [evidence.id], valid_until: "2020-01-01T00:00:00.000Z" });
    const expiredResult = f.service.knowledgeHostReview({ ...base, claim_id: expired.id, host_run_key: "codex:expired" });
    assert((expiredResult.blocking_reasons as string[]).includes("claim_expired"));
    const missingBody = f.store.create("knowledge_claim", "host-missing-body", { status: "candidate", source_id: "source", scope: "project:demo", evidence_ids: [evidence.id] });
    const bodyResult = f.service.knowledgeHostReview({ ...base, claim_id: missingBody.id, host_run_key: "codex:body" });
    assert((bodyResult.blocking_reasons as string[]).includes("content_reference_invalid"));

    const manual = f.store.create("knowledge_claim", "host-manual-reviewed", { status: "reviewed", source_id: "source", scope: "project:demo", content: "body", evidence_ids: [evidence.id], review: { reviewer: "manual" } });
    const manualResult = f.service.knowledgeHostReview({ ...base, claim_id: manual.id, host_run_key: "codex:manual" });
    assert.equal(manualResult.status, "already_reviewed");
    const retired = f.store.create("knowledge_claim", "host-retired", { status: "expired", source_id: "source", scope: "project:demo", content: "body", evidence_ids: [evidence.id] });
    const retiredResult = f.service.knowledgeHostReview({ ...base, claim_id: retired.id, host_run_key: "codex:retired" });
    assert((retiredResult.blocking_reasons as string[]).includes("claim_status_expired"));
  } finally { await close(f); }
});

test("portable bundles carry append-only support but never the local promotion policy", async () => {
  const source = await fixture(); const target = await fixture();
  try {
    const { claim, first } = candidate(source.service);
    source.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: first.id, observation_key: "machine-a:one" });
    const bundle = source.service.knowledgeMemoryBundleExport({ scope_kind: "project", scope_id: "demo", exported_at: "2026-09-20T00:00:00.000Z" }).bundle as JsonObject;
    const kinds = (bundle.records as JsonObject[]).map((record) => record.kind);
    assert(kinds.includes("knowledge_claim_support"));
    assert(!kinds.includes("knowledge_promotion_policy"));
    // Both fixtures already carry the same local Source descriptor; only the
    // Evidence, Claim and append-only support are additions on the other machine.
    assert.equal(target.service.knowledgeMemoryBundleImportPlan({ bundle }).additions, 3);
    target.service.knowledgeMemoryBundleImportApply({ bundle, approved: true, import_id: "portable" });
    assert.equal(target.store.list("knowledge_claim_support", 10_000).length, 1);
  } finally { await close(source); await close(target); }
});

test("promotion policy rejects malformed inputs and reports every non-promotable Claim state", async () => {
  const f = await fixture();
  try {
    const { claim, first } = candidate(f.service);
    // Default values and the automatic circuit breaker are both explicit policy branches.
    assert.equal(f.service.knowledgePromotionPolicySave({}).idempotent, true);
    assert.equal((f.service.knowledgePromotionPolicySave({ automatic: false }).policy as JsonObject).automatic, false);
    f.service.knowledgePromotionPolicySave({ automatic: true });
    assert.throws(() => f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [] }), /non-empty array/u);
    assert.throws(() => f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: "claim" as never }), /non-empty array/u);
    assert.throws(() => f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id], now: "not-a-date" }), /ISO timestamp/u);
    assert.equal((f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo" }).assessments as JsonObject[]).length, 1);

    f.service.knowledgeClaimSupportRecord({ support_id: "conflict-id", claim_id: claim.id, evidence_id: first.id, observation_key: "run:one" });
    const second = f.service.evidenceRecord({ evidence_id: "conflict-e2", source_type: "receipt", confidence: "confirmed", claim: "second" });
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ support_id: "conflict-id", claim_id: claim.id, evidence_id: second.id, observation_key: "run:two" }), /idempotency conflict/u);

    const raw = (id: string, extra: JsonObject = {}) => f.store.create("knowledge_claim", id, {
      status: "candidate", scope: "project:demo", source_id: "source", evidence_ids: [first.id], content: "body", ...extra,
    });
    const legacyReviewed = raw("legacy-reviewed", { status: "reviewed", review: { reviewer: "legacy-user" } });
    const legacyReviewedWithoutReview = raw("legacy-reviewed-without-review", { status: "reviewed", review: null });
    const legacyReviewedId = String(legacyReviewed.id);
    const quarantined = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [legacyReviewedId], auto_promote: false }).assessments as JsonObject[])[0]!;
    assert.equal(f.store.get("knowledge_claim", legacyReviewedId).status, "reviewed");
    assert((quarantined.reasons as string[]).includes("independent_effectiveness_evaluation_required"));
    assert.equal(quarantined.claim_id, legacyReviewedId);
    assert.equal((f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [String(legacyReviewedWithoutReview.id)], auto_promote: false }).assessments as JsonObject[])[0]!.claim_id,
      legacyReviewedWithoutReview.id);
    f.service.knowledgeSourceRegister({ source_id: "missing-source", kind: "project_note", label: "Removed source", trust: "verified", scope_kind: "project", scope_id: "demo", locator: "removed.md", content_digest: `sha256:${"a".repeat(64)}` });
    raw("missing-source", { source_id: "missing-source" });
    f.store.remove("knowledge_source", "missing-source");
    f.service.knowledgeSourceRegister({ source_id: "paused", kind: "project_note", label: "Paused", trust: "verified", scope_kind: "project", scope_id: "demo", locator: "paused.md", content_digest: `sha256:${"c".repeat(64)}` });
    f.service.knowledgeSourceTransition({ source_id: "paused", status: "revoked", reason: "fixture" });
    raw("untrusted-source", { source_id: "paused" });
    raw("no-evidence-array", { evidence_ids: null });
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('knowledge_claim','no-scope',1,?,?,?)")
      .run(JSON.stringify({ status: "candidate", source_id: "source", evidence_ids: [first.id], content: "body" }), "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z");
    assert.throws(() => raw("invalid-scope", { scope: "not-a-scope" }), /storage scope is malformed/u);
    // Historical malformed data can still exist; new writes must reject it.
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('knowledge_claim','invalid-scope',1,?,?,?)")
      .run(JSON.stringify({ status: "candidate", scope: "not-a-scope", source_id: "source", content: "body" }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    raw("missing-body", { content: null, content_ref: null });
    raw("drifted-body", { content: null, content_ref: { kind: "knowledge", record_id: "absent", version: 1, path: "/absent.md", digest: "sha256:absent", format: "markdown" } });
    raw("expired", { valid_until: "2020-01-01T00:00:00.000Z" });
    raw("future", { valid_until: "2030-01-01T00:00:00.000Z" });
    raw("noncandidate", { status: "revoked", identity_digest: null });
    const assessedProject = f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: ["missing-source", "untrusted-source", "no-evidence-array", "missing-body", "drifted-body", "expired", "future", "noncandidate"], auto_promote: false, now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[];
    const assessedGlobal = f.service.knowledgeAutoReview({ scope_kind: "global", scope_id: "global", auto_promote: false, now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[];
    const assessed = [...assessedProject, ...assessedGlobal];
    const byId = new Map(assessed.map((item) => [String(item.claim_id), item]));
    assert((byId.get("missing-source")!.reasons as string[]).includes("source_not_registered"));
    assert((byId.get("untrusted-source")!.reasons as string[]).includes("source_not_trusted_active"));
    assert((byId.get("no-evidence-array")!.reasons as string[]).includes("credible_evidence_missing"));
    assert.equal(assessedGlobal.length, 0, "unscoped claims are never treated as global Knowledge");
    assert.throws(() => f.service.knowledgeHostReview({ claim_id: "no-scope", host_run_key: "unscoped", source_digest: "sha256:source", decision: "supported" }), /Claim scope is required/u);
    assert((byId.get("missing-body")!.reasons as string[]).includes("content_reference_invalid"));
    assert((byId.get("drifted-body")!.reasons as string[]).includes("content_reference_invalid"));
    assert((byId.get("expired")!.reasons as string[]).includes("claim_expired"));
    assert.equal(byId.get("future")!.verdict, "revalidation_required");
    assert.equal(byId.get("noncandidate")!.verdict, "rejected");

    f.service.knowledgePromotionPolicySave({ minimum_independent_support: 2, minimum_confidence: "confirmed", automatic: false });
    f.service.knowledgeSourceRegister({ source_id: "support-untrusted", kind: "project_note", label: "Untrusted support", trust: "untrusted", scope_kind: "project", scope_id: "demo", locator: "untrusted-support.md", content_digest: `sha256:${"e".repeat(64)}` });
    f.store.create("evidence", "support-bounded", { confidence: "bounded", source_id: "source" });
    f.store.create("evidence", "support-confirmed", { confidence: "confirmed", source_id: "source" });
    f.store.create("evidence", "support-untrusted-evidence", { confidence: "confirmed", source_id: "support-untrusted" });
    f.store.create("evidence", "support-no-source", { confidence: "confirmed" });
    const supportReview = raw("support-review", { evidence_ids: ["support-bounded", "support-confirmed", "support-untrusted-evidence", "support-no-source"] });
    f.store.create("knowledge_claim_support", "support-review-bounded", { claim_id: supportReview.id, evidence_id: "support-bounded", observation_key: "bounded-run" });
    f.store.create("knowledge_claim_support", "support-review-confirmed", { claim_id: supportReview.id, evidence_id: "support-confirmed", observation_key: "same-run" });
    f.store.create("knowledge_claim_support", "support-review-duplicate", { claim_id: supportReview.id, evidence_id: "support-confirmed", observation_key: "same-run" });
    f.store.create("knowledge_claim_support", "support-review-untrusted", { claim_id: supportReview.id, evidence_id: "support-untrusted-evidence", observation_key: "untrusted-run" });
    f.store.create("knowledge_claim_support", "support-review-no-source", { claim_id: supportReview.id, evidence_id: "support-no-source" });
    const supportAssessment = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [supportReview.id], auto_promote: false }).assessments as JsonObject[])[0]!;
    assert.equal(supportAssessment.verdict, "revalidation_required");
    assert((supportAssessment.reasons as string[]).includes("independent_effectiveness_evaluation_required"));
  } finally { await close(f); }
});

test("semantic review packets and provider responses stay evidence-bound across every unavailable outcome", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.CRAFT_SEMANTIC_TEST_KEY;
  try {
    const makePacketClaim = (id: string, scenarioKey?: string) => {
      const fragmentRef = f.store.contentStore.writeSync({ kind: "knowledge", record_id: `${id}-fragment`, version: 1, scope: "project:demo", status: "current", sensitivity: "internal", source_id: "source", body: "Focused tests verify the changed behavior." });
      f.store.create("knowledge_fragment", `${id}-fragment`, { source_id: "source", source_revision_id: `${id}-revision`, locator: `${id}.md#1`, content_ref: fragmentRef, content_digest: fragmentRef.digest });
    f.store.create("evidence", `${id}-evidence`, { scope: "project:demo", source_type: "knowledge_fragment", confidence: "confirmed", fragment_id: `${id}-fragment` });
      return f.service.knowledgeClaimSave({ claim_id: id, kind: "fact", content: "Run focused tests first.", scope: "project:demo", source_id: "source",
        ...(scenarioKey ? { scenario_key: scenarioKey } : {}), evidence_ids: [`${id}-evidence`] }).claim as JsonObject;
    };
    const claim = makePacketClaim("semantic-ready");
    const packet = f.service.knowledgeSemanticReviewPacket({ claim_id: claim.id }) as JsonObject;
    assert.equal(packet.status, "ready");
    const hostClaim = makePacketClaim("host-packet", "knowledge.semantic-review");
    const hostPacket = f.service.knowledgeSemanticReviewPacket({ claim_id: hostClaim.id });
    const hostArgs = { claim_id: hostClaim.id, host_run_key: "host:packet", source_digest: `sha256:${"b".repeat(64)}`, packet_digest: hostPacket.packet_digest, decision: "supported" };
    const promoted = f.service.knowledgeHostReview(hostArgs);
    assert.equal(promoted.promoted, false);
    assert.equal(promoted.status, "awaiting_independent_evaluation");
    assert.deepEqual(promoted.blocking_reasons, ["independent_effectiveness_evaluation_required"]);
    assert.equal((promoted.claim as JsonObject).status, "candidate");
    const context = f.service.wikiContextCompile({ query: "focused tests", scope: "project:demo" });
    assert.equal((context.included as JsonObject[]).some(item => item.claim_id === hostClaim.id), false);
    assert((context.excluded as JsonObject[]).some(item => item.claim_id === hostClaim.id && item.reason === "not_reviewed"));
    assert.equal(f.service.knowledgeHostReview(hostArgs).idempotent, true);
    const taxonomy = JSON.parse(await readFile(join(projectStorageDirectory(f.store.paths, f.root), "knowledge", "projects", "demo", "knowledge-scenarios.json"), "utf8")) as JsonObject;
    const scene = (taxonomy.scenarios as JsonObject[]).find(item => item.scenario_key === "knowledge.semantic-review")!;
    assert.equal((scene.claim_refs as JsonObject[])[0]!.status, "candidate");
    const live = f.store.get("knowledge_claim", String(hostClaim.id));
    f.store.save("knowledge_claim", String(hostClaim.id), { ...live, valid_until: "2000-01-01T00:00:00Z" });
    const expiredReplay = f.service.knowledgeHostReview(hostArgs);
    assert.equal(expiredReplay.status, "revalidation_required");
    assert.equal(expiredReplay.current_valid, false);
    assert.deepEqual(expiredReplay.blocking_reasons, ["claim_expired"]);
    assert.throws(() => f.service.knowledgeHostReview({ ...hostArgs, packet_digest: "sha256:drift" }), /packet_digest/u);
    const base = { claim_id: claim.id, endpoint: "https://semantic.fixture", model: "fixture", credential_env: "CRAFT_SEMANTIC_TEST_KEY" };
    assert.equal((await f.service.knowledgeSemanticProviderReview({ claim_id: claim.id }) as JsonObject).reason, "semantic_provider_unavailable");
    process.env.CRAFT_SEMANTIC_TEST_KEY = "fixture-key";
    globalThis.fetch = async () => ({ ok: false, status: 503 }) as Response;
    assert.equal((await f.service.knowledgeSemanticProviderReview(base) as JsonObject).reason, "semantic_provider_http_503");
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [] }) }) as Response;
    assert.equal((await f.service.knowledgeSemanticProviderReview(base) as JsonObject).reason, "semantic_provider_empty_response");
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) }) as Response;
    assert.equal((await f.service.knowledgeSemanticProviderReview(base) as JsonObject).reason, "semantic_provider_invalid_response");
    globalThis.fetch = async () => { throw new Error("network"); };
    assert.equal((await f.service.knowledgeSemanticProviderReview(base) as JsonObject).reason, "Error");
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ decision: "supported", reason_code: "supported" }) } }] }) }) as Response;
    assert.equal((await f.service.knowledgeSemanticProviderReview(base) as JsonObject).status, "completed");
    const fresh = makePacketClaim("semantic-packet-check");
    assert.throws(() => f.service.knowledgeHostReview({ claim_id: fresh.id, host_run_key: "packet-check", source_digest: `sha256:${"b".repeat(64)}`, decision: "supported", packet_digest: "sha256:wrong" }), /packet_digest/u);
    const noSource = f.store.create("knowledge_claim", "packet-no-source", { status: "candidate", scope: "project:demo", content: "body", evidence_ids: [] });
    assert.equal((f.service.knowledgeSemanticReviewPacket({ claim_id: noSource.id }) as JsonObject).reason, "source_unavailable");
    const noBody = f.store.create("knowledge_claim", "packet-no-body", { status: "candidate", scope: "project:demo", source_id: "source", evidence_ids: [] });
    assert.equal((f.service.knowledgeSemanticReviewPacket({ claim_id: noBody.id }) as JsonObject).reason, "claim_content_unavailable");
    const disappearedBody = f.store.contentStore.writeSync({ kind: "knowledge", record_id: "packet-disappeared-body", version: 1, scope: "project:demo", status: "candidate", sensitivity: "internal", source_id: "source", body: "body before removal" });
    const disappearedClaim = f.store.create("knowledge_claim", "packet-disappeared-body", { status: "candidate", source_id: "source", scope: "project:demo", content_ref: disappearedBody, evidence_ids: [] });
    await unlink(disappearedBody.path);
    assert.equal((f.service.knowledgeSemanticReviewPacket({ claim_id: disappearedClaim.id }) as JsonObject).reason, "claim_content_unavailable");
    const noEvidence = f.store.create("knowledge_claim", "packet-no-evidence", { status: "candidate", scope: "project:demo", source_id: "source", content: "body" });
    assert.equal((f.service.knowledgeSemanticReviewPacket({ claim_id: noEvidence.id }) as JsonObject).reason, "evidence_fragment_unavailable");
    f.store.create("evidence", "packet-evidence-missing", { source_type: "program", confidence: "confirmed", fragment_id: "missing" });
    const missingFragment = f.store.create("knowledge_claim", "packet-missing-fragment", { status: "candidate", scope: "project:demo", source_id: "source", content: "body", evidence_ids: ["packet-evidence-missing"] });
    assert.equal((f.service.knowledgeSemanticReviewPacket({ claim_id: missingFragment.id }) as JsonObject).reason, "evidence_fragment_unavailable");
    f.store.create("evidence", "packet-evidence-invalid", { source_type: "program", confidence: "confirmed", fragment_id: "invalid" });
    const invalidFragment = f.store.create("knowledge_claim", "packet-invalid-fragment", { status: "candidate", scope: "project:demo", source_id: "source", content: "body", evidence_ids: ["packet-evidence-invalid"] });
    f.store.create("knowledge_fragment", "invalid", { scope: "project:demo", source_id: "source" });
    assert.equal((f.service.knowledgeSemanticReviewPacket({ claim_id: invalidFragment.id }) as JsonObject).reason, "evidence_fragment_unavailable");
    const thrownFragment = makePacketClaim("semantic-thrown-fragment");
    await unlink(String((f.store.get("knowledge_fragment", "semantic-thrown-fragment-fragment").content_ref as JsonObject).path));
    assert.equal((f.service.knowledgeSemanticReviewPacket({ claim_id: thrownFragment.id }) as JsonObject).reason, "evidence_fragment_unavailable");
    const bodyRef = f.store.contentStore.writeSync({ kind: "knowledge", record_id: "semantic-ref-body", version: 1, scope: "project:demo", status: "candidate", sensitivity: "internal", source_id: "source", body: "body through ref" });
    const refBody = f.store.create("knowledge_claim", "semantic-ref-body", { status: "candidate", source_id: "source", scope: "project:demo", content_ref: bodyRef, evidence_ids: ["semantic-ready-evidence"] });
    f.store.save("knowledge_claim", String(refBody.id), { ...refBody, content: null });
    assert.equal((f.service.knowledgeSemanticReviewPacket({ claim_id: refBody.id }) as JsonObject).status, "ready");
    const unscopedBodyRef = f.store.contentStore.writeSync({ kind: "knowledge", record_id: "semantic-unscoped-body", version: 1, scope: "project:demo", status: "candidate", sensitivity: "internal", source_id: "source", body: "body through an unscoped legacy reference" });
    const unscopedRefBody = f.store.create("knowledge_claim", "semantic-unscoped-body", { status: "candidate", source_id: "source", scope: null, content_ref: unscopedBodyRef, evidence_ids: ["semantic-ready-evidence"] });
    f.store.save("knowledge_claim", String(unscopedRefBody.id), { ...unscopedRefBody, content: null });
    assert.equal((f.service.knowledgeSemanticReviewPacket({ claim_id: unscopedRefBody.id }) as JsonObject).status, "ready");
    const fallbackReason = makePacketClaim("semantic-reason-fallback");
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ decision: "supported" }) } }] }) }) as Response;
    assert.equal((await f.service.knowledgeSemanticProviderReview({ ...base, claim_id: fallbackReason.id }) as JsonObject).status, "completed");
    const thrownString = makePacketClaim("semantic-thrown-string");
    globalThis.fetch = async () => { throw "network"; };
    assert.equal((await f.service.knowledgeSemanticProviderReview({ ...base, claim_id: thrownString.id }) as JsonObject).reason, "semantic_provider_request_failed");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.CRAFT_SEMANTIC_TEST_KEY; else process.env.CRAFT_SEMANTIC_TEST_KEY = previousKey;
    await close(f);
  }
});
