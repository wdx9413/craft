import assert from "node:assert/strict";
import test from "node:test";
import { stableDigest } from "../core/digest.ts";
import { ontologyActivationResolve, ontologyActivationRollback, ontologyActivationRevoke, ontologyActivationSet } from "../core/ontology-activation.ts";
import type { CraftStore, JsonObject } from "../core/infrastructure/store.ts";

class MemoryStore {
  readonly rows = new Map<string, JsonObject>();
  find(kind: string, id: string) { return this.rows.get(`${kind}:${id}`); }
  get(kind: string, id: string, version?: number) {
    const row = this.find(kind, id);
    if (!row || (version !== undefined && Number(row.version) !== version)) throw new Error(`missing ${kind}:${id}`);
    return row;
  }
  create(kind: string, id: string, value: JsonObject) {
    if (this.find(kind, id)) throw new Error(`duplicate ${kind}:${id}`);
    const row = { ...value, id, version: 1 };
    this.rows.set(`${kind}:${id}`, row);
    return row;
  }
  list(kind: string, limit: number, predicate: (row: JsonObject) => boolean) {
    return [...this.rows.entries()].filter(([key, row]) => key.startsWith(`${kind}:`) && predicate(row)).map(([, row]) => row).slice(0, limit);
  }
  transaction<T>(operation: () => T): T { return operation(); }
}

function fixture(scope: { kind: "project" | "global"; id: string } = { kind: "project", id: "project-a" }) {
  const store = new MemoryStore();
  const candidate = store.create("ontology_version", "ontology-a", { identity_digest: "sha256:ontology-a", ontology_digest: "sha256:ontology-a", scope }) as JsonObject;
  const projection = store.create("ontology_classification_projection", "projection-a", { projection_digest: "sha256:projection-a", ontology_digest: "sha256:ontology-a", scope }) as JsonObject;
  const contract = store.create("evaluation_contract", "contract-a", { contract_digest: "sha256:contract-a", scope }) as JsonObject;
  const report = store.create("task_effect_evaluation", "report-a", { evaluation_digest: "sha256:report-a", contract_id: "contract-a",
    candidate_ref: { kind: "ontology_version", id: "ontology-a", version: 1, digest: "sha256:ontology-a" } }) as JsonObject;
  const args = { scope, stage: scope.kind === "global" ? "global" : "project", request_id: "request-a", created_at: "2026-11-19T00:00:00.000Z",
    candidate_ref: { kind: "ontology_version", id: candidate.id, version: candidate.version, digest: candidate.identity_digest },
    classification_projection_ref: { kind: "ontology_classification_projection", id: projection.id, version: projection.version, digest: projection.projection_digest },
    evaluation_contract_ref: { kind: "evaluation_contract", id: contract.id, version: contract.version, digest: contract.contract_digest },
    evaluation_result_ref: { kind: "task_effect_evaluation", id: report.id, version: report.version, digest: report.evaluation_digest } };
  const verifier = { verify: (input: JsonObject) => ({ verified: true, verdict: "passed", eligible: true, routeable: true,
    global_authorized: true, cohort_authorized: true, cohort_id: input.cohort_id ?? null,
    evaluation_digest: (input.evaluation_result_ref as JsonObject).digest, candidate_ref: input.candidate_ref,
    evaluation_contract_ref: input.evaluation_contract_ref, scope: input.scope, verification_receipt: "verified:receipt-a" }) };
  return { store: store as unknown as CraftStore, memory: store, args, verifier };
}

const authorizer = { authorize: () => true };
const projectArgs = (f: ReturnType<typeof fixture>, request_id: string, stage = "project", extra: JsonObject = {}) => ({
  ...f.args, request_id, stage, ...extra,
});
function addControlEvent(f: ReturnType<typeof fixture>, patch: JsonObject = {}) {
  const identity: JsonObject = { stream_key: "project:project-a:project", pointer_revision: 1, previous_event_id: null,
    previous_effective_pointer_id: null, action: "revoke", stage: "project", scope: { kind: "project", id: "project-a" },
    cohort_id: null, target_pointer_id: "missing-target", reason: "test", verified: true, verification_receipt: "runtime-control:test", ...patch };
  const keys = ["stream_key", "pointer_revision", "previous_event_id", "previous_effective_pointer_id", "action", "stage", "scope",
    "cohort_id", "candidate_ref", "classification_projection_ref", "evaluation_contract_ref", "evaluation_result_ref",
    "target_pointer_id", "reason", "verified", "verification_receipt"];
  const pointerIdentity = Object.fromEntries(keys.filter(key => identity[key] !== undefined).map(key => [key, identity[key]]));
  const id = "ontology_pointer_control-test";
  f.memory.create("ontology_activation_pointer", id, { ...identity, id, identity_digest: stableDigest(pointerIdentity), request_digest: "sha256:test", raw_content_stored: false });
  return id;
}

test("Ontology activation resolves project, cohort and global pointers with compatibility fallback", () => {
  const f = fixture();
  assert.equal(ontologyActivationResolve(f.store, { project_scope_id: "project-a" }).status, "compatibility_baseline");
  const global = fixture({ kind: "global", id: "craft" });
  const globalPointer = ontologyActivationSet(global.store, global.args, global.verifier);
  const local = fixture();
  ontologyActivationSet(local.store, local.args, local.verifier);
  const projectPointer = ontologyActivationSet(local.store, { ...local.args, request_id: "project-pointer-2" }, local.verifier);
  const selectedProject = ontologyActivationResolve(local.store, { project_scope_id: "project-a" });
  assert.equal((selectedProject.pointer as JsonObject).id, projectPointer.id);
  assert.equal(selectedProject.selected_stage, "project");
  assert.equal((ontologyActivationResolve(global.store, { project_scope_id: "unrelated", global_scope_id: "craft" }).pointer as JsonObject).id, globalPointer.id);

  const small = fixture();
  const smallArgs = projectArgs(small, "cohort-on", "small-scope", { cohort_id: "pilot" });
  const smallPointer = ontologyActivationSet(small.store, smallArgs, small.verifier);
  const project = ontologyActivationSet(small.store, { ...small.args, request_id: "project-on" }, small.verifier);
  assert.equal((ontologyActivationResolve(small.store, { project_scope_id: "project-a", cohort_id: "pilot" }).pointer as JsonObject).id, smallPointer.id);
  assert.equal((ontologyActivationResolve(small.store, { project_scope_id: "project-a", cohort_id: "other" }).pointer as JsonObject).id, project.id);
  ontologyActivationRevoke(small.store, { active_pointer_id: String(smallPointer.id), reason: "cohort complete", actor: "operator", request_id: "cohort-revoke" }, authorizer);
  assert.equal((ontologyActivationResolve(small.store, { project_scope_id: "project-a", cohort_id: "pilot" }).pointer as JsonObject).id, project.id);
});

test("shadow is verified and recorded but never changes the active projection", () => {
  const f = fixture();
  const shadow = ontologyActivationSet(f.store, projectArgs(f, "shadow-a", "shadow"), f.verifier);
  assert.equal(shadow.action, "activate");
  assert.equal(shadow.stage, "shadow");
  assert.equal(ontologyActivationResolve(f.store, { project_scope_id: "project-a" }).status, "compatibility_baseline");
  assert.throws(() => ontologyActivationSet(f.store, projectArgs(f, "shadow-no-verifier", "shadow")), /trusted evaluation verifier/u);
  const nonRouteable = { verify: (input: JsonObject) => ({ ...f.verifier.verify(input), eligible: false, routeable: false }) };
  assert.equal(ontologyActivationSet(f.store, projectArgs(f, "shadow-nonrouteable", "shadow"), nonRouteable).verified, true);
});

test("activation requires exact immutable candidate, projection, contract, report, scope and trusted evaluation", () => {
  const f = fixture();
  const cases: Array<[string, JsonObject, unknown, RegExp]> = [
    ["unsupported scope", { ...f.args, request_id: "x1", scope: { kind: "tenant", id: "x" } }, f.verifier, /scope.kind must/u],
    ["unsupported stage", { ...f.args, request_id: "x2", stage: "canary" }, f.verifier, /stage is unsupported/u],
    ["small without cohort", { ...f.args, request_id: "x3", stage: "small-scope" }, f.verifier, /cohort_id/u],
    ["project stage wrong scope", { ...f.args, request_id: "x4", scope: { kind: "global", id: "craft" }, stage: "project" }, f.verifier, /Project activation/u],
    ["global stage wrong scope", { ...f.args, request_id: "x5", stage: "global" }, f.verifier, /Global activation/u],
    ["cohort not allowed for project stage", { ...f.args, request_id: "x6", cohort_id: "pilot" }, f.verifier, /cohort_id is valid/u],
    ["candidate wrong kind", { ...f.args, request_id: "x7", candidate_ref: { ...f.args.candidate_ref, kind: "knowledge_claim" } }, f.verifier, /candidate_ref.kind/u],
    ["candidate invalid version", { ...f.args, request_id: "x7a", candidate_ref: { ...f.args.candidate_ref, version: 0 } }, f.verifier, /positive integer/u],
    ["candidate wrong digest", { ...f.args, request_id: "x8", candidate_ref: { ...f.args.candidate_ref, digest: "sha256:wrong" } }, f.verifier, /candidate digest/u],
    ["projection wrong kind", { ...f.args, request_id: "x9", classification_projection_ref: { ...f.args.classification_projection_ref, kind: "ontology_version" } }, f.verifier, /classification_projection_ref.kind/u],
    ["contract wrong digest", { ...f.args, request_id: "x10", evaluation_contract_ref: { ...f.args.evaluation_contract_ref, digest: "sha256:wrong" } }, f.verifier, /Evaluation Contract digest/u],
    ["report wrong kind", { ...f.args, request_id: "x11", evaluation_result_ref: { ...f.args.evaluation_result_ref, kind: "evaluation_run" } }, f.verifier, /evaluation_result_ref.kind/u],
    ["report contract mismatch", { ...f.args, request_id: "x12", evaluation_contract_ref: { ...f.args.evaluation_contract_ref, id: "missing" } }, f.verifier, /missing evaluation_contract/u],
    ["contract scope mismatch", { ...f.args, request_id: "x13", evaluation_contract_ref: f.args.evaluation_contract_ref,
      scope: { kind: "project", id: "project-b" } }, f.verifier, /does not match the activation scope/u],
    ["unverified verdict", f.args, { verify: (input: JsonObject) => ({ ...f.verifier.verify(input), verdict: "failed" }) }, /does not bind the exact candidate/u],
    ["missing verifier", projectArgs(f, "x15"), undefined, /trusted evaluation verifier/u],
    ["missing proof receipt", projectArgs(f, "x16"), { verify: (input: JsonObject) => ({ ...f.verifier.verify(input), verification_receipt: "" }) }, /evaluation_verification.verification_receipt/u],
    ["unrouteable live candidate", projectArgs(f, "x17"), { verify: (input: JsonObject) => ({ ...f.verifier.verify(input), eligible: false }) }, /eligible routeable/u],
    ["cohort not authorized", projectArgs(f, "x19", "small-scope", { cohort_id: "pilot" }), { verify: (input: JsonObject) => ({ ...f.verifier.verify(input), cohort_authorized: false }) }, /authorized exact cohort/u],
  ];
  for (const [name, args, verifier, expected] of cases) assert.throws(() => ontologyActivationSet(f.store, args, verifier as never), expected, name);
  const wrongBinding = { verify: (input: JsonObject) => ({ ...f.verifier.verify(input), candidate_ref: { ...(input.candidate_ref as JsonObject), digest: "sha256:other" } }) };
  assert.throws(() => ontologyActivationSet(f.store, projectArgs(f, "x20"), wrongBinding), /does not bind the exact candidate/u);
  const reportCandidateDigest = fixture();
  (reportCandidateDigest.memory.find("task_effect_evaluation", "report-a")!.candidate_ref as JsonObject).digest = "sha256:other";
  assert.throws(() => ontologyActivationSet(reportCandidateDigest.store, reportCandidateDigest.args, reportCandidateDigest.verifier), /report candidate binding/u);
  const projection = f.memory.find("ontology_classification_projection", "projection-a")!;
  projection.scope = { kind: "project", id: "project-b" };
  assert.throws(() => ontologyActivationSet(f.store, projectArgs(f, "projection-scope"), f.verifier), /does not bind the candidate/u);
  const global = fixture({ kind: "global", id: "craft" });
  const noGlobalAuthority = { verify: (input: JsonObject) => ({ ...global.verifier.verify(input), global_authorized: false }) };
  assert.throws(() => ontologyActivationSet(global.store, global.args, noGlobalAuthority), /independently authorized global/u);
  const noDigest = fixture();
  delete noDigest.memory.find("ontology_version", "ontology-a")!.identity_digest;
  delete noDigest.memory.find("ontology_version", "ontology-a")!.ontology_digest;
  assert.throws(() => ontologyActivationSet(noDigest.store, noDigest.args, noDigest.verifier), /Ontology candidate has no immutable digest/u);
  const reportMismatch = fixture();
  reportMismatch.memory.find("task_effect_evaluation", "report-a")!.contract_id = "other-contract";
  assert.throws(() => ontologyActivationSet(reportMismatch.store, reportMismatch.args, reportMismatch.verifier), /does not bind its exact contract/u);
  const missingReportCandidate = fixture();
  delete missingReportCandidate.memory.find("task_effect_evaluation", "report-a")!.candidate_ref;
  assert.throws(() => ontologyActivationSet(missingReportCandidate.store, missingReportCandidate.args, missingReportCandidate.verifier), /does not bind its exact contract/u);
});

test("control revisions roll back or revoke exact active projections and fail closed without authorization", () => {
  const f = fixture();
  const first = ontologyActivationSet(f.store, f.args, f.verifier);
  const second = ontologyActivationSet(f.store, { ...f.args, request_id: "request-b" }, f.verifier);
  assert.throws(() => ontologyActivationRollback(f.store, { active_pointer_id: second.id, reason: "restore", actor: "runtime", request_id: "rollback-no-auth" }), /trusted Runtime authorization/u);
  assert.throws(() => ontologyActivationRollback(f.store, { active_pointer_id: second.id, reason: "restore", actor: "runtime", request_id: "rollback-denied" }, { authorize: () => false }), /trusted Runtime authorization/u);
  assert.throws(() => ontologyActivationRollback(f.store, { active_pointer_id: second.id, reason: "restore", actor: "runtime", request_id: "rollback-missing-method" }, {} as never), /trusted Runtime authorization/u);
  const rollback = ontologyActivationRollback(f.store, { active_pointer_id: second.id, target_pointer_id: first.id,
    expected_pointer_revision: 2, reason: "metric regression", actor: "runtime", request_id: "rollback-ok",
    verification_receipt: "task-effect:regression-report@1:sha256:trusted" }, authorizer);
  assert.equal(rollback.action, "rollback");
  assert.equal(rollback.target_pointer_id, first.id);
  assert.equal(rollback.verification_receipt, "task-effect:regression-report@1:sha256:trusted");
  assert.equal((ontologyActivationResolve(f.store, { project_scope_id: "project-a" }).pointer as JsonObject).id, first.id);
  const revoke = ontologyActivationRevoke(f.store, { active_pointer_id: first.id, reason: "user revoked", actor: "user", request_id: "revoke-ok" }, authorizer);
  assert.equal(revoke.action, "revoke");
  assert.equal(ontologyActivationResolve(f.store, { project_scope_id: "project-a" }).status, "compatibility_baseline");
  assert.throws(() => ontologyActivationRollback(f.store, { active_pointer_id: second.id, reason: "stale", actor: "runtime", request_id: "stale" }, authorizer), /no longer active/u);
  assert.throws(() => ontologyActivationRevoke(f.store, { active_pointer_id: second.id, reason: "different", actor: "runtime", request_id: "rollback-ok" }, authorizer), /request id was reused/u);
  const missingReason = fixture();
  const onlyPointer = ontologyActivationSet(missingReason.store, missingReason.args, missingReason.verifier);
  assert.throws(() => ontologyActivationRevoke(missingReason.store, { active_pointer_id: onlyPointer.id, reason: "", actor: "user", request_id: "missing-reason" }, authorizer), /reason must not be empty/u);
  const nonActivationTarget = fixture();
  ontologyActivationSet(nonActivationTarget.store, nonActivationTarget.args, nonActivationTarget.verifier);
  const newer = ontologyActivationSet(nonActivationTarget.store, { ...nonActivationTarget.args, request_id: "newer" }, nonActivationTarget.verifier);
  const reverted = ontologyActivationRollback(nonActivationTarget.store, { active_pointer_id: newer.id, reason: "revert", actor: "runtime", request_id: "revert" }, authorizer);
  const afterRevert = ontologyActivationSet(nonActivationTarget.store, { ...nonActivationTarget.args, request_id: "after-revert" }, nonActivationTarget.verifier);
  assert.throws(() => ontologyActivationRollback(nonActivationTarget.store, { active_pointer_id: afterRevert.id,
    target_pointer_id: String(reverted.id), reason: "bad target", actor: "runtime", request_id: "bad-target-action" }, authorizer), /previously verified pointer/u);
  const history = f.memory.list("ontology_activation_pointer", 10, () => true);
  assert.equal(history.length, 4);
  assert.equal(new Set(history.map(item => item.pointer_revision)).size, 4);
  assert.throws(() => ontologyActivationRevoke(f.store, { active_pointer_id: String(rollback.id), reason: "wrong event", actor: "user", request_id: "wrong-event" }, authorizer), /Only a verified active/u);
});

test("rollback requires a prior verified target and pointer streams reject stale writes and corrupt history", () => {
  const f = fixture();
  const first = ontologyActivationSet(f.store, f.args, f.verifier);
  assert.throws(() => ontologyActivationRollback(f.store, { active_pointer_id: first.id, reason: "none", actor: "runtime", request_id: "no-prior" }, authorizer), /previously verified pointer target/u);
  assert.throws(() => ontologyActivationSet(f.store, { ...f.args, request_id: "stale-write", expected_pointer_revision: 7 }, f.verifier), /revision changed/u);
  const duplicate = ontologyActivationSet(f.store, f.args, f.verifier);
  assert.equal(duplicate.idempotent, true);
  assert.throws(() => ontologyActivationSet(f.store, { ...f.args, created_at: "different", stage: "project" }, f.verifier), /request id was reused/u);
  const row = f.memory.find("ontology_activation_pointer", String(first.id))!;
  row.identity_digest = "sha256:tampered";
  assert.throws(() => ontologyActivationResolve(f.store, { project_scope_id: "project-a" }), /history is corrupt/u);
  const noTarget = fixture();
  addControlEvent(noTarget);
  assert.equal(ontologyActivationResolve(noTarget.store, { project_scope_id: "project-a" }).status, "compatibility_baseline");
});

test("revoking the only active pointer returns to baseline and idempotency does not add history", () => {
  const f = fixture();
  const pointer = ontologyActivationSet(f.store, f.args, f.verifier);
  const revoked = ontologyActivationRevoke(f.store, { active_pointer_id: pointer.id, reason: "remove", actor: "user", request_id: "revoke-only" }, authorizer);
  assert.equal(revoked.target_pointer_id, null);
  assert.equal(ontologyActivationResolve(f.store, { project_scope_id: "project-a" }).projection_ref, null);
  const repeat = ontologyActivationRevoke(f.store, { active_pointer_id: pointer.id, reason: "remove", actor: "user", request_id: "revoke-only" }, authorizer);
  assert.equal(repeat.idempotent, true);
});
