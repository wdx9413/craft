import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { contextFeedbackWeights } from "../core/context-feedback-weight.ts";
import { stableDigest } from "../core/digest.ts";
import { craftPaths, dataRoot } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { adjudicateKnowledgeCase } from "./helpers/knowledge-evaluation-adjudication.ts";
import { attachTaskEffectReceiptFixture } from "./helpers/knowledge-promotion-proof.ts";
import { procedureTaskEffectFixture } from "./helpers/procedure-task-effect-fixture.ts";
import { spec } from "./helpers/procedure-invocation-fixture.ts";

let root: string;
let store: CraftStore;
let service: CraftService;
let project: JsonObject;
let otherProject: JsonObject;
let feedbackProject: JsonObject;
const originalDataRoot = process.env.CRAFT_DATA_DIR;

before(async t => {
  root = await mkdtemp(join(await realpath(tmpdir()), "craft-context-self-evolution-usage-"));
  const isolatedDataRoot = join(root, "data");
  process.env.CRAFT_DATA_DIR = isolatedDataRoot;
  assert.equal(dataRoot(), isolatedDataRoot);
  store = await new CraftStore(craftPaths()).open();
  assert.equal(store.paths.root, isolatedDataRoot);
  t.diagnostic(`CRAFT_DATA_DIR=${isolatedDataRoot}`);
  service = new CraftService(store);
  const register = async (name: string) => {
    const projectRoot = join(root, name);
    await mkdir(projectRoot);
    const { identity } = service.scopeIdentityResolveProject({ project_root: projectRoot });
    return (identity as JsonObject).canonical_scope as JsonObject;
  };
  project = await register("project");
  otherProject = await register("other-project");
  feedbackProject = await register("feedback-project");
  assert.notEqual(project.id, otherProject.id);
});

after(async () => {
  try {
    store?.close();
    if (root) await rm(root, { recursive: true, force: true });
  } finally {
    if (originalDataRoot === undefined) delete process.env.CRAFT_DATA_DIR;
    else process.env.CRAFT_DATA_DIR = originalDataRoot;
  }
});

type Member = "knowledge" | "memory" | "experience";

async function resolveReceipt(member: Member, query: string, scope = project): Promise<JsonObject> {
  const result = await service.contextResolutionResolve({ query, scope_kind: scope.kind, scope_id: scope.id, members: [member] });
  const receipt = result.receipt as JsonObject;
  assert.deepEqual(receipt.members, [member]);
  assert.deepEqual(receipt.canonical_scope, scope);
  assert.equal(receipt.partial, false);
  return receipt;
}

function selectedRefs(receipt: JsonObject, member: Member): JsonObject[] {
  if (member === "memory") {
    return (receipt.memory_refs as JsonObject[]).map(ref => ({
      member, id: ref.memory_id, version: ref.memory_version, digest: ref.content_digest,
    }));
  }
  const contribution = (receipt.contributions as JsonObject[]).find(part => part.member === member);
  assert.ok(contribution, `Missing ${member} contribution in receipt`);
  return (contribution.references as JsonObject[]).map(ref => ({ member, ...ref }));
}

function independentEvidence(key: string): JsonObject {
  return service.evidenceRecord({
    evidence_id: key, source_type: "program", confidence: "confirmed", claim: "Synthetic fixture observation",
    metadata: { source_session_id: `${key}-session`, task_id: `${key}-task`, source_ref_digest: stableDigest(key) },
  });
}

test("eligibleKnowledgeAssetIsSelectedOnlyForMatchingProject", async () => {
  const query = "Aster checksum verifies example reports.";
  const scope = `project:${String(project.id)}`;
  const source = service.knowledgeSourceRegister({
    source_id: "aster-knowledge", kind: "custom", label: "Aster fixture source", locator: "fixture://aster",
    scope_kind: "project", scope_id: project.id, content_digest: stableDigest(query), trust: "verified",
  }).source as JsonObject;
  const first = independentEvidence("aster-first-support");
  const candidate = service.knowledgeClaimSave({
    claim_id: "aster-checksum", kind: "fact", content: query, source_id: source.id, scope, evidence_ids: [first.id],
  }).claim as JsonObject;
  assert.equal(candidate.status, "candidate");
  for (const evidence of [first, independentEvidence("aster-second-support")]) {
    service.knowledgeClaimSupportRecord({ claim_id: candidate.id, evidence_id: evidence.id, observation_key: evidence.id });
  }
  const heldOut = independentEvidence("aster-held-out");
  const caseRecord = service.knowledgeEvaluationCaseSave({
    case_id: "aster-held-out-case", query, scope, expected_claim_ids: [candidate.id],
    source_session_id: "aster-held-out-session", source_task_id: "aster-held-out-task", source_evidence_ids: [heldOut.id],
    evaluation_channel: "real_session", dataset_partition: "held_out", label_source: "model_candidate", sanitized: true,
    candidate_claim_refs: [{ claim_id: candidate.id, claim_version: candidate.version,
      identity_digest: candidate.identity_digest, content_digest: candidate.content_digest }],
  }).case as JsonObject;
  const adjudicated = adjudicateKnowledgeCase(service, caseRecord).case as JsonObject;
  const run = service.knowledgeEvaluationRun({
    mode: "candidate_shadow", case_ids: [adjudicated.id], candidate_claim_ids: [candidate.id], top_k: 5,
  }).run as JsonObject;
  assert.equal(run.status, "eligible");
  const review = () => (service.knowledgeAutoReview({
    scope_kind: "project", scope_id: project.id, claim_ids: [candidate.id],
  }).assessments as JsonObject[])[0]!;
  const held = review();
  assert.equal(held.promoted, false);
  assert.ok((held.reasons as string[]).includes("independent_effectiveness_evaluation_required"));
  assert.deepEqual(selectedRefs(await resolveReceipt("knowledge", query), "knowledge"), []);
  assert.deepEqual((await service.knowledgeSearchScoped({ query, scope_kind: "project", scope_id: project.id })).hits, []);

  // Fixture the Eval receipt. Only the Knowledge owner can promote the Claim.
  attachTaskEffectReceiptFixture(store, run);
  assert.equal(review().promoted, true);
  const reviewed = service.knowledgeClaimGet({ claim_id: candidate.id }).claim as JsonObject;
  assert.equal(reviewed.status, "reviewed");
  assert.ok(Number(reviewed.version) > Number(candidate.version));
  const refs = selectedRefs(await resolveReceipt("knowledge", query), "knowledge");
  assert.deepEqual(refs.map(({ member, id, version, digest }) => ({ member, id, version, digest })), [{
    member: "knowledge", id: candidate.id, version: reviewed.version, digest: reviewed.content_digest,
  }]);
  assert.deepEqual(selectedRefs(await resolveReceipt("knowledge", query, otherProject), "knowledge"), []);
});

test("memoryCandidateDoesNotEnterReceiptBeforeLedgerPromotion", async () => {
  const query = "Prefer birch manifests for example reports.";
  service.memoryPolicySave({ mode: "propose" });
  const source = service.knowledgeSourceRegister({
    source_id: "birch-memory", kind: "custom", label: "Birch fixture source", locator: "fixture://birch",
    scope_kind: "project", scope_id: project.id, content_digest: stableDigest(query), trust: "bounded", access: "proposal_only",
  }).source as JsonObject;
  const evidence = independentEvidence("birch-observation");
  const candidate = service.memoryCandidatePropose({
    candidate_id: "birch-manifests", kind: "preference", topic: "report-manifest", source_id: source.id,
    scope_kind: "project", scope_id: project.id, content: query, evidence_ids: [evidence.id],
  }).candidate as JsonObject;
  assert.equal(candidate.status, "candidate");
  const ledger = () => service.memoryLedgerList({ scope_kind: "project", scope_id: project.id }).memories;
  assert.deepEqual(ledger(), []);
  assert.deepEqual(selectedRefs(await resolveReceipt("memory", query), "memory"), []);

  const approved = service.memoryCandidateReview({
    candidate_id: candidate.id, decision: "approve", reviewer: "fixture-reviewer", reason: "Checked example report preference",
  }).candidate as JsonObject;
  assert.equal(approved.status, "approved");
  assert.deepEqual(ledger(), []);
  assert.deepEqual(selectedRefs(await resolveReceipt("memory", query), "memory"), []);

  const memory = service.memoryLedgerRememberApproved({ candidate_id: approved.id }).memory as JsonObject;
  assert.equal(memory.status, "active");
  assert.deepEqual((ledger() as JsonObject[]).map(item => item.id), [memory.id]);
  assert.deepEqual(selectedRefs(await resolveReceipt("memory", query), "memory"), [{
    member: "memory", id: memory.id, version: memory.version, digest: memory.content_digest,
  }]);
  assert.deepEqual(selectedRefs(await resolveReceipt("memory", query, otherProject), "memory"), []);
});

async function routeableWorkflow(query: string, id: string, scope = project): Promise<JsonObject> {
  const candidate = service.procedureConfigurationSave({
    procedure_id: id, scope: scope.id, scenario_id: id, title: query, procedure_kind: "workflow", definition: spec(),
  }).procedure as JsonObject;
  assert.equal(candidate.lifecycle, "candidate");
  assert.equal(candidate.routeable, false);
  assert.deepEqual(selectedRefs(await resolveReceipt("experience", query, scope), "experience"), []);

  const qualification = procedureTaskEffectFixture(service, candidate);
  let current = candidate;
  for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
    const evidenceIds = (candidate.entrypoints as JsonObject[]).flatMap(entry => (entry.routes as JsonObject[]).map(route => {
      const evidence = service.evidenceRecord({
        evidence_id: `${id}:${stage}:${String(route.subscenario_id)}`, source_type: "program",
        confidence: "confirmed", claim: "Synthetic fixture evaluation passed",
        metadata: { procedure_definition_digest: candidate.definition_digest,
          entry_id: entry.id, exit_id: route.exit_id, subscenario_id: route.subscenario_id, stage, status: "passed" },
      });
      return evidence.id;
    }));
    current = service.experienceProcedureGate({
      ...qualification, procedure_id: candidate.id, expected_version: current.version, stage,
      passed: true, verdict: "passed", evidence_ids: evidenceIds,
    }).procedure as JsonObject;
    if (stage !== "canary") {
      assert.equal(current.routeable, false);
      assert.deepEqual(selectedRefs(await resolveReceipt("experience", query, scope), "experience"), []);
    }
  }
  const routeable = service.experienceProcedureGet({ procedure_id: candidate.id, release_channel: "current" }).procedure as JsonObject;
  assert.equal(routeable.lifecycle, "routeable");
  assert.equal(routeable.routeable, true);
  assert.ok(Number(routeable.version) > Number(candidate.version));
  return routeable;
}

test("routeableExperienceIsSelectedWithVersionAndFeedbackRef", async () => {
  const query = "Review diff";
  const procedure = await routeableWorkflow(query, "example-diff-review");
  const receipt = await resolveReceipt("experience", query);
  const expectedRef = { member: "experience", id: procedure.id, version: procedure.version,
    digest: procedure.content_digest, source_id: null, reason: "routeable_scope_match" };
  assert.deepEqual(selectedRefs(receipt, "experience"), [expectedRef]);
  const other = await resolveReceipt("experience", query, otherProject);
  assert.deepEqual(selectedRefs(other, "experience"), []);

  const feedbackInput = { receipt_id: receipt.id, outcome: "helpful", usage_stage: "used", asset_refs: [expectedRef] };
  assert.throws(() => service.contextResolutionFeedback({ ...feedbackInput, receipt_id: other.id }), /not selected by this receipt/u);
  assert.throws(() => service.contextResolutionFeedback({
    ...feedbackInput, asset_refs: [{ ...expectedRef, version: Number(procedure.version) - 1 }],
  }), /not selected by this receipt/u);
  const evidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "Synthetic usage verified",
    metadata: { context_receipt_id: receipt.id, verdict: "passed" } });
  const { feedback } = service.contextResolutionFeedback({ ...feedbackInput, evidence_ids: [evidence.id] });
  assert.equal((feedback as JsonObject).receipt_id, receipt.id);
  assert.equal((feedback as JsonObject).receipt_digest, receipt.identity_digest);
  assert.deepEqual((feedback as JsonObject).asset_refs, [expectedRef]);
  assert.deepEqual((feedback as JsonObject).verified_evidence_refs, [{ id: evidence.id, version: evidence.version }]);
  const history = service.workbenchExperienceFeedbackHistory({ asset_id: procedure.id, member: "experience" });
  assert.deepEqual(history.counts, { positive: 1, negative: 0, dismissed: 0, events: 1 });
});

test("unratedFeedbackDoesNotCountAsEffect", async () => {
  const query = "Review diff";
  const procedure = await routeableWorkflow(query, "example-unrated-diff-review", feedbackProject);
  const receipt = await resolveReceipt("experience", query, feedbackProject);
  const refs = selectedRefs(receipt, "experience");
  assert.equal(refs.length, 1);
  const ref = refs[0]!;
  assert.equal(ref.id, procedure.id);
  assert.equal(ref.version, procedure.version);
  const input = { receipt_id: receipt.id, outcome: "unrated", turn_outcome: "passed", asset_refs: [ref] };
  assert.throws(() => service.contextResolutionFeedback({ ...input, usage_stage: "used" }), /require shown usage/u);
  const result = service.contextResolutionFeedback({ ...input, usage_stage: "shown" });
  const feedback = result.feedback as JsonObject;
  assert.equal(feedback.receipt_id, receipt.id);
  assert.equal(feedback.receipt_digest, receipt.identity_digest);
  assert.deepEqual(feedback.asset_refs, refs);
  assert.equal(feedback.outcome, "unrated");
  assert.equal(feedback.turn_outcome, "passed");
  assert.equal(feedback.evidence_verified, false);
  assert.deepEqual(feedback.verified_evidence_refs, []);
  assert.deepEqual(result.auto_demotions, []);
  assert.equal(result.procedure_release_changed, false);
  const history = service.workbenchExperienceFeedbackHistory({ asset_id: ref.id, member: "experience" });
  assert.deepEqual(history.counts, { positive: 0, negative: 0, dismissed: 0, events: 1 });
  const weights = contextFeedbackWeights(store, "experience", [String(ref.id)]);
  assert.deepEqual(weights.get(String(ref.id)), { weight: 1, penalty: 1, positive: 0, negative: 0 });
});
