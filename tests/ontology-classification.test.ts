import assert from "node:assert/strict";
import test from "node:test";
import { CONCEPT_KINDS, createOntologyVersion, RELATION_KINDS } from "craft-common-ontology";
import { assertOntologyPromotionAuthority, assertOntologyTaskEffectEvaluation, ontologyClassificationGet, ontologyClassificationRecord, ontologyVersionRegister } from "../core/ontology-classification.ts";
import { ontologyClassificationGetActive, ontologyClassificationProjectionBuild } from "../core/ontology-classification-projection.ts";
import { ontologyActivationSet } from "../core/ontology-activation.ts";
import type { CraftStore, JsonObject } from "../core/infrastructure/store.ts";

class MemoryStore {
  readonly rows = new Map<string, JsonObject>();
  readonly eventRows = new Map<string, JsonObject[]>();
  find(kind: string, id: string) { return this.rows.get(`${kind}:${id}`); }
  get(kind: string, id: string, version?: number) {
    const row = this.find(kind, id);
    if (!row || (version !== undefined && Number(row.version) !== version)) throw new Error(`missing ${kind}:${id}`);
    return row;
  }
  create(kind: string, id: string, value: JsonObject): JsonObject {
    if (this.find(kind, id)) throw new Error(`duplicate ${kind}:${id}`);
    const row = { ...value, id, version: 1 };
    this.rows.set(`${kind}:${id}`, row);
    return row;
  }
  list(kind: string, limit: number, predicate: (item: JsonObject) => boolean) {
    return [...this.rows.entries()].filter(([key, value]) => key.startsWith(`${kind}:`) && predicate(value)).map(([, value]) => value).slice(0, limit);
  }
  events(name: string) { return this.eventRows.get(name) ?? []; }
  transaction<T>(operation: () => T): T { return operation(); }
}

const fakeVerifier = (patch: JsonObject = {}) => ({ verifyTaskEffectEvaluation: () => ({ valid: true, eligible: true, routeable: true,
  evaluation_digest: "sha256:report-digest", candidate_ref: {}, ...patch }) });
const ontologyDefinition = (version = "v1") => ({ version, parent_digest: null,
  concept_kinds: [...CONCEPT_KINDS, "hypothesis"], relation_kinds: [...RELATION_KINDS, "depends_on"] });

function authorizedFixture() {
  const store = new MemoryStore();
  const registered = ontologyVersionRegister(store as unknown as CraftStore, { ontology: ontologyDefinition(), scope: { kind: "global", id: "craft" } });
  const ontology = registered.ontology as JsonObject;
  const contract = store.create("evaluation_contract", "contract", { capability_id: "craft.ontology.classification", capability_version: 1,
    effect: "task_effect", verified_stage: "routeable", scope: { kind: "project", id: "project-a" },
    task_effect: { candidate_family: "ontology_version" }, stage_history: [
      { stage: "business_eligible", verification: "trusted", evidence: ["eval"] },
      { stage: "routeable", verification: "trusted", evidence: ["eval"] },
    ] });
  const evaluation = store.create("task_effect_evaluation", "eval", { contract_id: "contract", result: { eligible: true },
    evaluation_digest: "sha256:report-digest", candidate_ref: { kind: "ontology_version", id: ontology.id, version: ontology.version, digest: ontology.identity_digest } });
  const candidate = { kind: "ontology_version", id: String(ontology.id), version: Number(ontology.version) };
  const evaluationRef = { kind: "task_effect_evaluation", id: String(evaluation.id), version: Number(evaluation.version), digest: String(evaluation.evaluation_digest) };
  const candidateEvent = { stage: "candidate", artifact_refs: [candidate] };
  const evaluationEvent = { stage: "evaluate", evaluation_refs: [evaluationRef] };
  store.eventRows.set("evolution:cycle", [{ payload: candidateEvent }, { payload: evaluationEvent }]);
  const cycle = { id: "cycle", project_scope_id: "project-a", candidate_refs: [candidate] };
  const authority = { kind: "evaluation_contract", id: String(contract.id), version: Number(contract.version) };
  return { store, candidate, evaluation, evaluationRef, cycle, authority, events: [candidateEvent, evaluationEvent], verifier: fakeVerifier() };
}

test("Ontology version registration is immutable, content addressed and scope bound", () => {
  const store = new MemoryStore() as unknown as CraftStore;
  const first = ontologyVersionRegister(store, { ontology: ontologyDefinition("v8"), scope: { kind: "global", id: "craft" } });
  assert.equal(first.idempotent, false);
  const second = ontologyVersionRegister(store, { ontology: ontologyDefinition("v8"), scope: { kind: "global", id: "craft" } });
  assert.equal(second.idempotent, true);
  const scoped = ontologyVersionRegister(store, { ontology: ontologyDefinition("v8"), scope: { kind: "project", id: "project-a" } });
  assert.notEqual((first.ontology as JsonObject).id, (scoped.ontology as JsonObject).id);
  assert.throws(() => ontologyVersionRegister(store, { ontology: ontologyDefinition("v8"), scope: {} }), /scope\.(kind|id) must not be empty/u);
  assert.throws(() => ontologyVersionRegister(store, { ontology: { version: "v9" } }), /ontology\.(concept_kinds|relation_kinds)/u);
});

test("effective Ontology classification reads append-only revisions and unresolved receipts without mutating Claims", () => {
  const memory = new MemoryStore();
  memory.create("knowledge_claim", "claim", { kind: "fact", content: "A stable source fact", source_refs: ["source:one"], scope: "project:p" });
  memory.create("knowledge_claim", "legacy-classified", { kind: "fact", concept_kind: "user_fact", content: "Already classified", source_refs: ["source:two"] });
  memory.create("knowledge_claim", "legacy-empty-classification", { kind: "procedure", concept_kind: " ", content: "Fallback kind", source_refs: ["source:three"] });
  memory.create("ontology_classification_receipt", "other-claim-receipt", { claim_id: "other-claim", unresolved: { proposed_concept_kind: "secret" } });
  memory.create("ontology_classification_receipt", "resolved-receipt", { claim_id: "legacy-classified", unresolved: null });
  const store = memory as unknown as CraftStore;
  assert.deepEqual(ontologyClassificationGet(store, { claim_id: "legacy-classified" }).effective_classification,
    { ontology_version: "legacy", concept_kind: "user_fact", revision_id: null });
  assert.deepEqual(ontologyClassificationGet(store, { claim_id: "legacy-empty-classification" }).effective_classification,
    { ontology_version: "legacy", concept_kind: "procedure", revision_id: null });
  const legacy = ontologyClassificationGet(store, { claim_id: "claim" });
  assert.deepEqual(legacy.effective_classification, { ontology_version: "legacy", concept_kind: "fact", revision_id: null });
  assert.equal(legacy.unresolved, null);
  memory.create("ontology_classification_revision", "revision-1", { record_id: "claim", previous_revision_id: null,
    ontology_version: "v2", concept_kind: "procedure", confidence: 0.9, rationale: "reclassified", source_refs: ["source:one"] });
  memory.create("ontology_classification_receipt", "receipt-1", { claim_id: "claim", unresolved: { proposed_concept_kind: "fact" } });
  memory.rows.set("ontology_classification_receipt:receipt-2", { id: "receipt-2", version: 2, claim_id: "claim", unresolved: { proposed_concept_kind: "old_fact" } });
  const current = ontologyClassificationGet(store, { claim_id: "claim", claim_version: 1 });
  assert.deepEqual(current.effective_classification, { ontology_version: "v2", concept_kind: "procedure", revision_id: "revision-1" });
  assert.deepEqual(current.unresolved, { proposed_concept_kind: "old_fact" });
  assert.equal(memory.get("knowledge_claim", "claim").content, "A stable source fact");
  assert.throws(() => ontologyClassificationGet(store, { claim_id: "claim", claim_version: 2 }), /missing knowledge_claim/u);
  for (let index = 0; index <= 10_000; index++) memory.rows.set(`ontology_classification_receipt:receipt-${index + 2}`, { claim_id: "claim", version: index + 2 });
  assert.throws(() => ontologyClassificationGet(store, { claim_id: "claim" }), /receipt history exceeds/u);
});

test("classification query follows the activated immutable projection and otherwise retains the legacy classification", () => {
  const memory = new MemoryStore();
  const store = memory as unknown as CraftStore;
  const registered = ontologyVersionRegister(store, { ontology: ontologyDefinition("active-v1"), scope: { kind: "project", id: "project-a" } });
  const ontology = registered.ontology as JsonObject;
  memory.create("knowledge_claim", "claim-active", { kind: "fact", concept_kind: "fact", content: "Source stays unchanged.", scope: "project:project-a" });
  memory.create("knowledge_claim", "legacy-empty-active", { kind: "procedure", concept_kind: " ", content: "Legacy fallback.", scope: "project:project-a" });
  memory.create("knowledge_claim", "second-active", { kind: "fact", concept_kind: "fact", content: "Second classified fact.", scope: "project:project-a" });
  memory.create("ontology_classification_revision", "revision-active", { id: "revision-active", record_id: "claim-active", ontology_version: "active-v1",
    ontology_digest: ontology.ontology_digest, concept_kind: "decision", previous_revision_id: null });
  memory.create("ontology_classification_revision", "revision-second", { id: "revision-second", record_id: "second-active", ontology_version: "active-v1",
    ontology_digest: ontology.ontology_digest, concept_kind: "fact", previous_revision_id: null });
  const built = ontologyClassificationProjectionBuild(store, { ontology_id: ontology.id, scope: { kind: "project", id: "project-a" }, created_at: "2026-11-19T00:00:00.000Z" });
  const projection = built.projection as JsonObject;
  assert.equal(ontologyClassificationProjectionBuild(store, { ontology_id: ontology.id, ontology_record_version: 1,
    scope: { kind: "project", id: "project-a" }, created_at: "2026-11-19T00:00:00.000Z" }).idempotent, true);
  assert.equal((built.projection as JsonObject).classifications instanceof Array, true);
  assert.equal((ontologyClassificationGet(store, { claim_id: "claim-active" }).effective_classification as JsonObject).ontology_version, "active-v1");
  assert.deepEqual(ontologyClassificationGetActive(store, { claim_id: "claim-active", project_scope_id: "project-a" }).effective_classification,
    { ontology_version: "legacy", concept_kind: "fact", revision_id: null });
  assert.equal((ontologyClassificationGetActive(store, { claim_id: "claim-active", claim_version: 1, project_scope_id: "project-a" }).effective_classification as JsonObject).concept_kind, "fact");
  assert.equal((ontologyClassificationGetActive(store, { claim_id: "legacy-empty-active", project_scope_id: "project-a" }).effective_classification as JsonObject).concept_kind, "procedure");
  const contract = memory.create("evaluation_contract", "activation-contract", { contract_digest: "sha256:contract", scope: { kind: "project", id: "project-a" },
    verified_stage: "routeable", effect: "task_effect" });
  const report = memory.create("task_effect_evaluation", "activation-report", { evaluation_digest: "sha256:report", contract_id: contract.id,
    candidate_ref: { kind: "ontology_version", id: ontology.id, version: ontology.version, digest: ontology.identity_digest } });
  const candidateRef = { kind: "ontology_version", id: ontology.id, version: ontology.version, digest: ontology.identity_digest };
  const contractRef = { kind: "evaluation_contract", id: contract.id, version: contract.version, digest: contract.contract_digest };
  const reportRef = { kind: "task_effect_evaluation", id: report.id, version: report.version, digest: report.evaluation_digest };
  ontologyActivationSet(store, { scope: { kind: "project", id: "project-a" }, stage: "project", request_id: "activate-v1",
    candidate_ref: candidateRef, classification_projection_ref: { kind: "ontology_classification_projection", id: projection.id,
      version: projection.version, digest: projection.projection_digest }, evaluation_contract_ref: contractRef, evaluation_result_ref: reportRef },
  { verify: (input) => ({ verified: true, verdict: "passed", eligible: true, routeable: true,
    candidate_ref: input.candidate_ref, evaluation_contract_ref: input.evaluation_contract_ref, scope: input.scope,
    evaluation_digest: (input.evaluation_result_ref as JsonObject).digest, verification_receipt: "verified:test" }) });
  assert.deepEqual(ontologyClassificationGetActive(store, { claim_id: "claim-active", project_scope_id: "project-a" }).effective_classification,
    { ontology_version: "active-v1", concept_kind: "decision", revision_id: "revision-active" });
  assert.equal((ontologyClassificationGetActive(store, { claim_id: "claim-active", project_scope_id: "project-a", cohort_id: "pilot", global_scope_id: "craft" }).activation as JsonObject).status, "active");
  assert.equal((ontologyClassificationGetActive(store, { claim_id: "claim-active", claim_version: 1, project_scope_id: "project-a" }).effective_classification as JsonObject).concept_kind, "decision");
  assert.equal((ontologyClassificationGetActive(store, { claim_id: "legacy-empty-active", claim_version: 1, project_scope_id: "project-a" }).effective_classification as JsonObject).concept_kind, "procedure");
  assert.equal(((ontologyClassificationGetActive(store, { claim_id: "claim-active", project_scope_id: "project-a" }).activation as JsonObject).pointer_id), "ontology_pointer_activate-v1");
  const priorDigest = projection.projection_digest;
  delete projection.projection_digest;
  projection.identity_digest = priorDigest;
  assert.equal((ontologyClassificationGetActive(store, { claim_id: "claim-active", project_scope_id: "project-a" }).effective_classification as JsonObject).concept_kind, "decision");
  projection.identity_digest = "sha256:wrong";
  assert.throws(() => ontologyClassificationGetActive(store, { claim_id: "claim-active", project_scope_id: "project-a" }), /projection digest changed/u);
  projection.identity_digest = priorDigest;
  delete projection.projection_digest;
  delete projection.identity_digest;
  assert.throws(() => ontologyClassificationGetActive(store, { claim_id: "claim-active", project_scope_id: "project-a" }), /projection digest changed/u);
  projection.projection_digest = priorDigest;
  projection.classifications = [];
  assert.deepEqual(ontologyClassificationGetActive(store, { claim_id: "claim-active", project_scope_id: "project-a" }).effective_classification,
    { ontology_version: "legacy", concept_kind: "fact", revision_id: null });
  projection.classifications = [{ claim_id: "claim-active", claim_version: 1, revision_id: "missing-revision" }];
  assert.deepEqual(ontologyClassificationGetActive(store, { claim_id: "claim-active", project_scope_id: "project-a" }).effective_classification,
    { ontology_version: "legacy", concept_kind: "fact", revision_id: null });
  projection.classifications = "invalid";
  assert.deepEqual(ontologyClassificationGetActive(store, { claim_id: "claim-active", project_scope_id: "project-a" }).effective_classification,
    { ontology_version: "legacy", concept_kind: "fact", revision_id: null });
  const secondOntology = ontologyVersionRegister(store, { ontology: ontologyDefinition("active-v2"), scope: { kind: "project", id: "project-a" } }).ontology as JsonObject;
  assert.equal((ontologyClassificationProjectionBuild(store, { ontology_id: secondOntology.id, scope: { kind: "project", id: "project-a" } }).projection as JsonObject).created_at !== undefined, true);
  memory.create("knowledge_claim", "global-claim", { kind: "fact", concept_kind: "fact", content: "Global knowledge.", scope: "global" });
  memory.create("knowledge_claim", "unrelated-project-claim", { kind: "fact", concept_kind: "fact", content: "Other project.", scope: "project:project-b" });
  memory.create("ontology_classification_revision", "global-revision", { id: "global-revision", record_id: "global-claim", ontology_version: "active-v1",
    ontology_digest: ontology.ontology_digest, concept_kind: "fact", previous_revision_id: null });
  ontologyClassificationProjectionBuild(store, { ontology_id: secondOntology.id, scope: { kind: "project", id: "project-a" } });
  assert.equal((ontologyClassificationProjectionBuild(store, { ontology_id: ontology.id, scope: { kind: "global", id: "craft" } }).projection as JsonObject).scope !== undefined, true);
  assert.throws(() => ontologyClassificationProjectionBuild(store, { ontology_id: ontology.id, scope: { kind: "tenant", id: "x" } }), /scope.kind/u);
});

test("Ontology task evaluation requires exact candidate, report digest and routeable contract receipt", () => {
  const f = authorizedFixture(), store = f.store as unknown as CraftStore;
  const verified = assertOntologyTaskEffectEvaluation(store, f.candidate, f.evaluationRef, "project-a", f.verifier);
  assert.equal((verified.evaluation as JsonObject).id, "eval");
  const failures: Array<[string, () => unknown, RegExp]> = [
    ["wrong candidate kind", () => assertOntologyTaskEffectEvaluation(store, { ...f.candidate, kind: "knowledge_claim" }, f.evaluationRef, "project-a", f.verifier), /Ontology promotion requires/u],
    ["wrong evaluation kind", () => assertOntologyTaskEffectEvaluation(store, f.candidate, { ...f.evaluationRef, kind: "evaluation_run" }, "project-a", f.verifier), /Ontology promotion requires/u],
    ["wrong report digest", () => assertOntologyTaskEffectEvaluation(store, f.candidate, { ...f.evaluationRef, digest: "sha256:other" }, "project-a", f.verifier), /digest does not match/u],
    ["invalid verification", () => assertOntologyTaskEffectEvaluation(store, f.candidate, f.evaluationRef, "project-a", fakeVerifier({ valid: false })), /signature, provenance/u],
    ["ineligible verification", () => assertOntologyTaskEffectEvaluation(store, f.candidate, f.evaluationRef, "project-a", fakeVerifier({ eligible: false })), /signature, provenance/u],
    ["unrouteable verification", () => assertOntologyTaskEffectEvaluation(store, f.candidate, f.evaluationRef, "project-a", fakeVerifier({ routeable: false })), /signature, provenance/u],
    ["wrong contract scope", () => assertOntologyTaskEffectEvaluation(store, f.candidate, f.evaluationRef, "project-b", f.verifier), /routeable project Evaluation Contract/u],
  ];
  for (const [name, run, expected] of failures) assert.throws(run, expected, name);
});

test("Cycle promotion binds its sole held-out report to the same routeable Evaluation Contract", () => {
  const f = authorizedFixture(), store = f.store as unknown as CraftStore;
  assertOntologyPromotionAuthority(store, f.cycle, [f.candidate], [f.authority], f.verifier);
  const cases: Array<[string, () => void, RegExp]> = [
    ["no candidate", () => assertOntologyPromotionAuthority(store, f.cycle, [], [f.authority], f.verifier), /one exact Ontology candidate/u],
    ["unsupported candidate", () => assertOntologyPromotionAuthority(store, f.cycle, [{ ...f.candidate, kind: "knowledge_claim" }], [f.authority], f.verifier), /one exact Ontology candidate/u],
    ["missing candidate stage", () => { f.store.eventRows.set("evolution:cycle", [{ payload: f.events[1] }]); assertOntologyPromotionAuthority(store, f.cycle, [f.candidate], [f.authority], f.verifier); }, /prior Cycle candidate/u],
    ["candidate version mismatch", () => { f.store.eventRows.set("evolution:cycle", [{ payload: { ...f.events[0], artifact_refs: [{ ...f.candidate, version: 2 }] } }, { payload: f.events[1] }]); assertOntologyPromotionAuthority(store, f.cycle, [f.candidate], [f.authority], f.verifier); }, /does not bind this exact Ontology/u],
    ["no evaluation stage", () => { f.store.eventRows.set("evolution:cycle", [{ payload: f.events[0] }]); assertOntologyPromotionAuthority(store, f.cycle, [f.candidate], [f.authority], f.verifier); }, /held-out evaluation events/u],
    ["multiple cycle evaluations", () => { f.store.eventRows.set("evolution:cycle", [{ payload: f.events[0] }, { payload: { stage: "evaluate", evaluation_refs: [f.evaluationRef, f.evaluationRef] } }]); assertOntologyPromotionAuthority(store, f.cycle, [f.candidate], [f.authority], f.verifier); }, /exactly one Cycle evaluation/u],
    ["wrong Cycle evaluation family", () => { f.store.eventRows.set("evolution:cycle", [{ payload: f.events[0] }, { payload: { stage: "evaluate", evaluation_refs: [{ ...f.evaluationRef, kind: "evaluation_run" }] } }]); assertOntologyPromotionAuthority(store, f.cycle, [f.candidate], [f.authority], f.verifier); }, /must be its task-effect report/u],
    ["Cycle digest mismatch", () => { f.store.eventRows.set("evolution:cycle", [{ payload: f.events[0] }, { payload: { stage: "evaluate", evaluation_refs: [{ ...f.evaluationRef, digest: "sha256:other" }] } }]); assertOntologyPromotionAuthority(store, f.cycle, [f.candidate], [f.authority], f.verifier); }, /digest does not match/u],
    ["missing authority", () => assertOntologyPromotionAuthority(store, f.cycle, [f.candidate], [], f.verifier), /routeable Evaluation Contract authority/u],
    ["wrong authority version", () => assertOntologyPromotionAuthority(store, f.cycle, [f.candidate], [{ ...f.authority, version: 2 }], f.verifier), /exact routeable Evaluation Contract version/u],
  ];
  for (const [name, run, expected] of cases) {
    f.store.eventRows.set("evolution:cycle", [{ payload: f.events[0] }, { payload: f.events[1] }]);
    assert.throws(() => run.call(null), expected, name);
  }
});

test("classification appends revisions and receipts but never rewrites claim content or source", () => {
  const f = authorizedFixture();
  const claim = f.store.create("knowledge_claim", "claim", { content: "The team approved an office workflow.", kind: "fact", concept_kind: "fact",
    source_id: "meeting-source", evidence_ids: ["meeting-evidence"], scope: "project:project-a" });
  f.store.eventRows.set("evolution:cycle", [{ payload: f.events[0] }, { payload: f.events[1] }, { payload: { stage: "promote", authority_refs: [f.authority] } }]);
  const cycleResult = { cycle: f.cycle, events: f.store.events("evolution:cycle") };
  const cycles = { get: () => cycleResult };
  const args = { claim_id: "claim", claim_version: 1, ontology_id: String(f.candidate.id), ontology_record_version: f.candidate.version, evolution_cycle_id: "cycle",
    proposal: { ontology_version: "v1", concept_kind: "decision", confidence: 0.95, rationale: "The source explicitly records an approved decision.", created_at: "2026-11-19T00:00:00.000Z" } };
  const saved = ontologyClassificationRecord(f.store as unknown as CraftStore, cycles, args, f.verifier);
  assert.equal((saved.decision as JsonObject).status, "appended");
  assert.equal(f.store.get("knowledge_claim", "claim").content, claim.content);
  assert.equal(f.store.get("knowledge_claim", "claim").source_id, claim.source_id);
  assert.equal(f.store.list("ontology_classification_revision", 10, () => true).length, 1);
  assert.equal(ontologyClassificationRecord(f.store as unknown as CraftStore, cycles, args, f.verifier).idempotent, true);
  const unresolved = ontologyClassificationRecord(f.store as unknown as CraftStore, cycles, { ...args, proposal: { ...args.proposal,
    concept_kind: "rule", confidence: 0.2, rationale: "Evidence is ambiguous.", created_at: "2026-11-19T00:01:00.000Z" } }, f.verifier);
  assert.equal((unresolved.decision as JsonObject).status, "unresolved");
  assert.deepEqual((unresolved.decision as JsonObject).effective_classification, (saved.decision as JsonObject).effective_classification);
  assert.equal(f.store.list("ontology_classification_revision", 10, () => true).length, 1);
  assert.equal(f.store.list("ontology_classification_receipt", 10, () => true).length, 2);
});

test("classification fails closed on stale, cross-project, source-less and unpromoted inputs", () => {
  const f = authorizedFixture();
  f.store.create("knowledge_claim", "claim", { content: "A supported statement.", kind: "fact", concept_kind: "fact", source_id: "source", scope: "project:project-a" });
  const events = [{ payload: f.events[0] }, { payload: f.events[1] }, { payload: { stage: "promote", authority_refs: [f.authority] } }];
  const cycles = { get: () => ({ cycle: f.cycle, events }) };
  const base = { claim_id: "claim", ontology_id: String(f.candidate.id), ontology_record_version: f.candidate.version, evolution_cycle_id: "cycle", proposal: { concept_kind: "decision", confidence: 0.9, rationale: "supported", created_at: "2026-11-19T00:00:00.000Z" } };
  assert.throws(() => ontologyClassificationRecord(f.store as unknown as CraftStore, cycles, { ...base, claim_version: 2 }, f.verifier), /missing knowledge_claim/u);
  const otherClaim = f.store.create("knowledge_claim", "other", { content: "Other scope fact", kind: "fact", concept_kind: "fact", source_id: "source", scope: "project:project-b" });
  assert.throws(() => ontologyClassificationRecord(f.store as unknown as CraftStore, cycles, { ...base, claim_id: otherClaim.id }, f.verifier), /cannot cross/u);
  const sourceLess = f.store.create("knowledge_claim", "source-less", { content: "No source", kind: "fact", concept_kind: "fact", scope: "project:project-a" });
  assert.throws(() => ontologyClassificationRecord(f.store as unknown as CraftStore, cycles, { ...base, claim_id: sourceLess.id }, f.verifier), /requires existing source/u);
  assert.throws(() => ontologyClassificationRecord(f.store as unknown as CraftStore, { get: () => ({ cycle: f.cycle, events: [] }) }, base, f.verifier), /completed EvolutionCycle promote/u);
  const mismatchedCycle = { ...f.cycle, candidate_refs: [{ ...f.candidate, version: 2 }] };
  assert.throws(() => ontologyClassificationRecord(f.store as unknown as CraftStore, { get: () => ({ cycle: mismatchedCycle, events }) }, base, f.verifier), /has not promoted this exact/u);
  assert.throws(() => ontologyClassificationRecord(f.store as unknown as CraftStore, cycles, { ...base, proposal: null }, f.verifier), /proposal must be an object/u);
});

test("Ontology authority validates refs and preserves Cycle report binding without a digest", () => {
  const f = authorizedFixture(), store = f.store as unknown as CraftStore;
  assert.throws(() => assertOntologyTaskEffectEvaluation(store, f.candidate, { ...f.evaluationRef, version: 0 }, "project-a", f.verifier), /positive integer/u);
  assert.throws(() => assertOntologyTaskEffectEvaluation(store, f.candidate, { ...f.evaluationRef, digest: "other" }, "project-a", f.verifier), /digest does not match/u);
  f.store.eventRows.set("evolution:cycle", [{ payload: f.events[0] }, { payload: { stage: "evaluate", evaluation_refs: [{ kind: "task_effect_evaluation", id: "eval", version: 1 }] } }]);
  assert.doesNotThrow(() => assertOntologyPromotionAuthority(store, f.cycle, [f.candidate], [f.authority], f.verifier));
  f.evaluation.candidate_ref = { ...(f.evaluation.candidate_ref as object), digest: "other" };
  assert.throws(() => assertOntologyPromotionAuthority(store, f.cycle, [f.candidate], [f.authority], f.verifier), /exact eligible Ontology/u);
});

test("classification validates ontology integrity, scope, event shape and source references", () => {
  const f = authorizedFixture();
  f.store.create("knowledge_claim", "claim", { content: "Text", kind: "fact", concept_kind: "fact", source_refs: [" a ", "a", 1], evidence_ids: ["b"], scope: "project:project-a" });
  const events = [{ payload: f.events[0] }, { payload: f.events[1] }, { payload: { stage: "promote", authority_refs: [f.authority] } }];
  const cycles = { get: () => ({ cycle: f.cycle, events }) };
  const base = { claim_id: "claim", ontology_id: String(f.candidate.id), evolution_cycle_id: "cycle", proposal: { concept_kind: "decision", confidence: 0.9, rationale: "supported" } };
  const store = f.store as unknown as CraftStore;
  assert.equal((ontologyClassificationRecord(store, cycles, base, f.verifier).decision as JsonObject).status, "appended");
  const corrupt = f.store.create("ontology_version", "corrupt", { ...f.store.get("ontology_version", String(f.candidate.id)), ontology_digest: "wrong" });
  assert.throws(() => ontologyClassificationRecord(store, cycles, { ...base, ontology_id: String(corrupt.id) }, f.verifier), /digest does not match/u);
  const noScope: JsonObject = { ...f.cycle }; delete noScope.project_scope_id;
  assert.throws(() => ontologyClassificationRecord(store, { get: () => ({ cycle: noScope, events }) }, base, f.verifier), /project scope is required/u);
  assert.throws(() => ontologyClassificationRecord(store, { get: () => ({ cycle: f.cycle, events: [{ stage: "evaluate" }, { stage: "promote" }] }) }, base, f.verifier), /routeable Evaluation Contract authority/u);
  assert.throws(() => ontologyClassificationRecord(store, { get: () => ({ cycle: f.cycle }) }, base, f.verifier), /completed EvolutionCycle promote/u);
});

test("classification rejects corrupt history chains and fails closed on concurrent writes", () => {
  const make = () => {
    const f = authorizedFixture();
    f.store.create("knowledge_claim", "claim", { content: "Text", kind: "fact", concept_kind: "fact", source_id: "source", scope: "project:project-a" });
    const events = [{ payload: f.events[0] }, { payload: f.events[1] }, { payload: { stage: "promote", authority_refs: [f.authority] } }];
    const cycles = { get: () => ({ cycle: f.cycle, events }) };
    const args = { claim_id: "claim", ontology_id: String(f.candidate.id), evolution_cycle_id: "cycle", proposal: { concept_kind: "decision", confidence: 0.9, rationale: "supported", created_at: "2026-11-19T00:00:00.000Z" } };
    return { f, cycles, args, store: f.store as unknown as CraftStore };
  };
  for (const rows of [
    [{ id: "r1", record_id: "claim", previous_revision_id: null }, { id: "r2", record_id: "claim", previous_revision_id: null }],
    [{ id: "r1", record_id: "claim", previous_revision_id: "missing" }],
  ]) {
    const x = make(); rows.forEach((row) => x.f.store.rows.set(`ontology_classification_revision:${row.id}`, row));
    assert.throws(() => ontologyClassificationRecord(x.store, x.cycles, x.args, x.f.verifier), /history has a fork|disconnected revision/u);
  }
  for (const race of ["claim", "ontology"] as const) {
    const x = make();
    const originalTransaction = x.store.transaction.bind(x.store), originalGet = x.store.get.bind(x.store);
    x.store.get = ((kind: string, id: string, version?: number) => ({ ...originalGet(kind, id, version) })) as CraftStore["get"];
    x.store.transaction = ((operation: (database: unknown) => unknown) => originalTransaction(((database: unknown) => {
      if (race === "claim") x.f.store.rows.get("knowledge_claim:claim")!.version = 2;
      else x.f.store.rows.get(`ontology_version:${String(x.f.candidate.id)}`)!.identity_digest = "changed";
      return operation(database);
    }) as never)) as CraftStore["transaction"];
    assert.throws(() => ontologyClassificationRecord(x.store, x.cycles, x.args, x.f.verifier), /changed while/u);
  }
});

test("Ontology Evaluation Contract rejection branches and verifier capability fail closed", () => {
  const mutations: Array<[string, (f: ReturnType<typeof authorizedFixture>) => void]> = [
    ["wrong effect", f => { f.store.get("evaluation_contract", "contract").effect = "other"; }],
    ["wrong capability", f => { f.store.get("evaluation_contract", "contract").capability_id = "other"; }],
    ["wrong stage", f => { f.store.get("evaluation_contract", "contract").verified_stage = "project"; }],
    ["wrong family", f => { f.store.get("evaluation_contract", "contract").task_effect = { candidate_family: "procedure" }; }],
    ["wrong scope kind", f => { f.store.get("evaluation_contract", "contract").scope = { kind: "global", id: "craft" }; }],
    ["missing business receipt", f => { f.store.get("evaluation_contract", "contract").stage_history = [{ stage: "routeable", verification: "trusted", evidence: ["eval"] }]; }],
    ["malformed history", f => { f.store.get("evaluation_contract", "contract").stage_history = null; }],
    ["mismatched report contract id", f => { f.evaluation.contract_id = "other"; f.store.create("evaluation_contract", "other", { ...f.store.get("evaluation_contract", "contract") }).id = "mismatched-row-id"; }],
  ];
  for (const [name, mutate] of mutations) {
    const f = authorizedFixture(); mutate(f);
    const run = () => assertOntologyTaskEffectEvaluation(f.store as unknown as CraftStore, f.candidate, f.evaluationRef, "project-a", f.verifier);
    if (name === "mismatched report contract id") assert.throws(run, /contract identity mismatch/u, name);
    else assert.throws(run, /routeable project Evaluation Contract/u, name);
  }
  const f = authorizedFixture();
  assert.throws(() => assertOntologyTaskEffectEvaluation(f.store as unknown as CraftStore, f.candidate, f.evaluationRef, "project-a"));
  assert.throws(() => assertOntologyTaskEffectEvaluation(f.store as unknown as CraftStore, f.candidate, f.evaluationRef, "project-a", {} as never), /installed Evaluation Contract verifier/u);
  assert.throws(() => assertOntologyTaskEffectEvaluation(f.store as unknown as CraftStore, f.candidate, f.evaluationRef, "project-a", fakeVerifier({ candidate_ref: undefined })), /signature, provenance/u);
});

test("Cycle promotion rejects incomplete candidate refs, report provenance and authority bindings", () => {
  const failures: Array<[string, (f: ReturnType<typeof authorizedFixture>) => void, RegExp]> = [
    ["no artifact refs", f => f.store.eventRows.set("evolution:cycle", [{ payload: { stage: "candidate" } }, { payload: f.events[1] }]), /does not bind this exact Ontology/u],
    ["no eval refs", f => f.store.eventRows.set("evolution:cycle", [{ payload: f.events[0] }, { payload: { stage: "evaluate" } }]), /exactly one Cycle evaluation/u],
    ["wrong report id", f => f.store.eventRows.set("evolution:cycle", [{ payload: f.events[0] }, { payload: { stage: "evaluate", evaluation_refs: [{ ...f.evaluationRef, id: "other" }] } }]), /missing task_effect_evaluation/u],
    ["wrong report version", f => f.store.eventRows.set("evolution:cycle", [{ payload: f.events[0] }, { payload: { stage: "evaluate", evaluation_refs: [{ ...f.evaluationRef, version: 2 }] } }]), /missing task_effect_evaluation/u],
    ["bad contract effect", f => { f.store.get("evaluation_contract", "contract").effect = "other"; }, /exact routeable project Evaluation Contract/u],
    ["bad contract capability", f => { f.store.get("evaluation_contract", "contract").capability_id = "other"; }, /exact routeable project Evaluation Contract/u],
    ["bad contract stage", f => { f.store.get("evaluation_contract", "contract").verified_stage = "project"; }, /exact routeable project Evaluation Contract/u],
    ["bad contract scope", f => { f.store.get("evaluation_contract", "contract").scope = { kind: "global", id: "craft" }; }, /exact routeable project Evaluation Contract/u],
    ["missing report receipt", f => { f.store.get("evaluation_contract", "contract").stage_history = []; }, /report recorded by the routeable/u],
    ["bad report receipt evidence", f => { f.store.get("evaluation_contract", "contract").stage_history = [{ stage: "routeable", verification: "trusted", evidence: null }]; }, /report recorded by the routeable/u],
    ["report bound elsewhere", f => { f.evaluation.contract_id = "other"; f.store.create("evaluation_contract", "other", { ...f.store.get("evaluation_contract", "contract") }).id = "mismatched-row-id"; }, /belongs to another Evaluation Contract/u],
    ["bad history shape", f => { f.store.get("evaluation_contract", "contract").stage_history = null; }, /report recorded by the routeable/u],
  ];
  for (const [name, mutate, expected] of failures) {
    const f = authorizedFixture(); mutate(f);
    assert.throws(() => assertOntologyPromotionAuthority(f.store as unknown as CraftStore, f.cycle, [f.candidate], [f.authority], f.verifier), expected, name);
  }
});

test("remaining Ontology defaults, stale refs, legacy classification and empty revision paths are covered", () => {
  const store = new MemoryStore() as unknown as CraftStore;
  const direct = ontologyVersionRegister(store, ontologyDefinition("default-scope"));
  assert.equal((direct.ontology as JsonObject).scope && ((direct.ontology as JsonObject).scope as JsonObject).kind, "global");
  const stored = direct.ontology as JsonObject; stored.identity_digest = "tampered";
  assert.throws(() => ontologyVersionRegister(store, ontologyDefinition("default-scope")), /idempotency conflict/u);

  for (const reportPatch of [{ id: "wrong" }, { version: 2 }]) {
    const f = authorizedFixture(), oldGet = f.store.get.bind(f.store);
    f.store.get = ((kind: string, id: string, version?: number) => {
      const row = oldGet(kind, id, version);
      return kind === "task_effect_evaluation" ? { ...row, ...reportPatch } : row;
    });
    assert.throws(() => assertOntologyPromotionAuthority(f.store as unknown as CraftStore, f.cycle, [f.candidate], [f.authority], f.verifier), /does not bind its exact/u);
  }

  const f = authorizedFixture(), claim = f.store.create("knowledge_claim", "claim", { content: "Text", kind: "fact", source_id: "source", scope: "project:project-a" });
  const events = [{ payload: f.events[0] }, { payload: f.events[1] }, { payload: "not-an-object" }, { stage: "promote", authority_refs: [f.authority] }];
  const cycles = { get: () => ({ cycle: { ...f.cycle, candidate_refs: undefined }, events }) };
  const args = { claim_id: "claim", ontology_id: String(f.candidate.id), evolution_cycle_id: "cycle", proposal: { concept_kind: "rule", confidence: 0.1, rationale: "weak evidence", created_at: "2026-11-19T00:00:00.000Z" } };
  assert.throws(() => ontologyClassificationRecord(f.store as unknown as CraftStore, cycles, args, f.verifier), /has not promoted/u);
  assert.equal(claim.concept_kind, undefined);
  const validCycles = { get: () => ({ cycle: f.cycle, events }) };
  const initial = ontologyClassificationRecord(f.store as unknown as CraftStore, validCycles, args, f.verifier);
  assert.equal((initial.decision as JsonObject).status, "unresolved");
  assert.equal(f.store.list("ontology_classification_revision", 10, () => true).length, 0);
});

test("Ontology classification covers stale current claims and history budget/cycle bounds", () => {
  const f = authorizedFixture();
  const claim = f.store.create("knowledge_claim", "claim", { content: "Text", kind: "fact", source_id: "source", scope: "project:project-a" });
  const oldGet = f.store.get.bind(f.store), oldClaim = { ...claim };
  claim.version = 2;
  f.store.get = ((kind: string, id: string, version?: number) => kind === "knowledge_claim" && version === 1 ? oldClaim : oldGet(kind, id, version));
  const events = [{ payload: f.events[0] }, { payload: f.events[1] }, { payload: { stage: "promote", authority_refs: [f.authority] } }];
  const cycles = { get: () => ({ cycle: f.cycle, events }) };
  const args = { claim_id: "claim", claim_version: 1, ontology_id: String(f.candidate.id), evolution_cycle_id: "cycle", proposal: { concept_kind: "decision", confidence: 0.9, rationale: "supported" } };
  assert.throws(() => ontologyClassificationRecord(f.store as unknown as CraftStore, cycles, args, f.verifier), /current stable Claim/u);
  for (const mode of ["budget", "cycle"] as const) {
    const x = authorizedFixture(); x.store.create("knowledge_claim", "claim", { content: "Text", kind: "fact", source_id: "source", scope: "project:project-a" });
    const list = x.store.list.bind(x.store);
    if (mode === "budget") x.store.list = ((kind: string, limit: number, predicate: (item: JsonObject) => boolean) => kind === "ontology_classification_revision"
      ? Array.from({ length: 10_001 }, (_, i) => ({ id: String(i), record_id: "claim" })) : list(kind, limit, predicate));
    else {
      x.store.rows.set("ontology_classification_revision:r1", { id: "r1", record_id: "claim", previous_revision_id: null });
      x.store.rows.set("ontology_classification_revision:r2", { id: "r1", record_id: "claim", previous_revision_id: "r1" });
    }
    assert.throws(() => ontologyClassificationRecord(x.store as unknown as CraftStore, { get: () => ({ cycle: x.cycle, events: [{ payload: x.events[0] }, { payload: x.events[1] }, { payload: { stage: "promote", authority_refs: [x.authority] } }] }) },
      { ...args, claim_version: undefined, ontology_id: String(x.candidate.id) }, x.verifier), mode === "budget" ? /read budget/u : /history has a cycle/u);
  }
});

test("classification returns the concurrent duplicate receipt idempotently", () => {
  const f = authorizedFixture();
  f.store.create("knowledge_claim", "claim", { content: "Text", kind: "fact", source_id: "source", scope: "project:project-a" });
  const events = [{ payload: f.events[0] }, { payload: f.events[1] }, { payload: { stage: "promote", authority_refs: [f.authority] } }];
  const store = f.store as unknown as CraftStore;
  const originalFind = store.find.bind(store);
  let receiptLookups = 0;
  store.find = ((kind: string, id: string) => {
    if (kind === "ontology_classification_receipt" && ++receiptLookups === 2) return { decision: { status: "unresolved" }, id };
    return originalFind(kind, id);
  }) as CraftStore["find"];
  const result = ontologyClassificationRecord(store, { get: () => ({ cycle: f.cycle, events }) },
    { claim_id: "claim", ontology_id: String(f.candidate.id), evolution_cycle_id: "cycle", proposal: { concept_kind: "rule", confidence: 0.1, rationale: "weak evidence" } }, f.verifier);
  assert.equal(result.idempotent, true);
  assert.equal(receiptLookups, 2);
});
