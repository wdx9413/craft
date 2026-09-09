import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture(name: string) {
  const root = join(tmpdir(), `craft-contract-${name}-${process.pid}-${Date.now()}`); await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store); const mcp = new McpServer(service, "full");
  const task = service.taskOpen({ title: name, goal: "Learn a bounded contract" }).task as JsonObject;
  const evidence = service.evidenceRecord({ evidence_id: `e-${name}`, source_type: "probe", confidence: "confirmed", claim: "Observed schema" });
  return { root, store, service, mcp, task, evidence };
}
const schema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
const observation = (f: Awaited<ReturnType<typeof fixture>>, id: string, extra: JsonObject = {}) => ({ observation_id: id,
  task_id: f.task.id, adapter_kind: "api", endpoint: "https://api.example.test/items", operation: "GET item",
  input_schema: schema, output_schema: schema, observed_effect: "read_only", outcome: "succeeded", evidence_ids: [f.evidence.id], ...extra });

test("contract inference turns repeated schema evidence into a reviewed, sandbox-verified, non-executable contract", async () => {
  const f = await fixture("happy");
  try {
    const left = await f.mcp.handlers.craft_contract_observation_record(observation(f, "left", { idempotency_observed: true }));
    const right = await f.mcp.handlers.craft_contract_observation_record(observation(f, "right", { compensation_observed: true,
      credential_handles_required: ["credential:api"] }));
    assert.equal((left.observation as JsonObject).raw_payload_stored, false);
    assert.equal((await f.mcp.handlers.craft_contract_observation_record(observation(f, "left", { idempotency_observed: true }))).idempotent, true);
    const inferred = await f.mcp.handlers.craft_contract_candidate_infer({ candidate_id: "candidate",
      observation_ids: [(left.observation as JsonObject).id, (right.observation as JsonObject).id] });
    assert.equal((inferred.candidate as JsonObject).idempotency, "unknown"); assert.equal((inferred.candidate as JsonObject).execution_authority, false);
    assert.equal((await f.mcp.handlers.craft_contract_candidate_infer({ candidate_id: "candidate",
      observation_ids: [(left.observation as JsonObject).id, (right.observation as JsonObject).id] })).idempotent, true);
    const reviewed = await f.mcp.handlers.craft_contract_candidate_review({ candidate_id: "candidate", decision: "accept", reviewer: "owner",
      review_ref: "review:1", corrected_contract: { input_schema: schema, output_schema: schema, effect: "read_only",
        idempotency: true, compensation: false, credential_handles_required: [] } });
    assert.equal((reviewed.candidate as JsonObject).status, "reviewed");
    const sandbox = f.store.create("sandbox_profile", "sandbox", { status: "verified" });
    f.store.create("harness_configuration", "candidate", { name: "Contract probe" });
    const trial = f.service.trialStart({ trial_id: "contract-trial", task_id: f.task.id, subject_type: "harness_configuration",
      subject_id: "candidate", subject_version: 1 });
    f.service.outcomeRecord({ trial_id: trial.id, verdict: "passed", summary: "Probe passed", evidence_ids: [f.evidence.id] });
    const verified = await f.mcp.handlers.craft_contract_candidate_verify({ candidate_id: "candidate", sandbox_profile_id: sandbox.id,
      sandbox_profile_version: sandbox.version, trial_id: trial.id });
    assert.equal((verified.contract as JsonObject).status, "verified"); assert.equal(verified.executable, false);
    assert.equal((await f.mcp.handlers.craft_contract_diff({ baseline_id: "candidate", baseline_version: (verified.contract as JsonObject).version,
      candidate_id: "candidate", candidate_version: (verified.contract as JsonObject).version })).classification, "equivalent");
    const published = await f.mcp.handlers.craft_contract_publish({ publication_id: "publication", candidate_id: "candidate",
      candidate_version: (verified.contract as JsonObject).version, asset_id: "contract-adapter", name: "Item API", publisher: "release-owner", approval_ref: "release:1" });
    assert.equal((published.asset as JsonObject).trust, "verified"); assert.equal((published.asset as JsonObject).requires_credential, false);
    assert.equal((await f.mcp.handlers.craft_contract_publish({ publication_id: "publication", candidate_id: "candidate",
      candidate_version: (verified.contract as JsonObject).version, asset_id: "contract-adapter", name: "Ignored", publisher: "ignored", approval_ref: "ignored" })).idempotent, true);
    const rolled = await f.mcp.handlers.craft_contract_publication_rollback({ publication_id: "publication", reason: "Regression",
      actor: "release-owner", rollback_ref: "rollback:1" });
    assert.equal((rolled.asset as JsonObject).health, "stale");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("contract inference fails closed for weak, conflicting, or unverified evidence", async () => {
  const f = await fixture("errors");
  try {
    assert.throws(() => f.service.contractObservationRecord(observation(f, "bad-adapter", { adapter_kind: "magic" })), /adapter_kind/);
    assert.throws(() => f.service.contractObservationRecord(observation(f, "bad-effect", { observed_effect: "magic" })), /observed_effect/);
    assert.throws(() => f.service.contractObservationRecord(observation(f, "bad-outcome", { outcome: "maybe" })), /outcome/);
    assert.throws(() => f.service.contractObservationRecord(observation(f, "bad-schema", { input_schema: [] })), /input_schema/);
    assert.throws(() => f.service.contractObservationRecord(observation(f, "bad-evidence", { evidence_ids: [] })), /at least 1/);
    assert.throws(() => f.service.contractObservationRecord(observation(f, "blank", { endpoint: " " })), /endpoint/);
    assert.throws(() => f.service.contractObservationRecord(observation(f, "duplicate-handles", { credential_handles_required: ["x", "x"] })), /unique/);
    const one = f.service.contractObservationRecord(observation(f, "one")).observation as JsonObject;
    assert.throws(() => f.service.contractObservationRecord(observation(f, "one", { operation: "changed" })), /idempotency conflict/);
    const failed = f.service.contractObservationRecord(observation(f, "failed", { outcome: "failed" })).observation as JsonObject;
    const different = f.service.contractObservationRecord(observation(f, "different", { output_schema: { type: "string" } })).observation as JsonObject;
    assert.throws(() => f.service.contractCandidateInfer({ observation_ids: [one.id] }), /at least 2/);
    assert.throws(() => f.service.contractCandidateInfer({ observation_ids: [one.id, different.id] }), /not structurally consistent/);
    assert.throws(() => f.service.contractCandidateInfer({ observation_ids: [one.id, failed.id] }), /successful observations/);
    const two = f.service.contractObservationRecord(observation(f, "two")).observation as JsonObject;
    const generated = f.service.contractObservationRecord({ ...observation(f, "temporary"), observation_id: undefined }).observation as JsonObject;
    assert.match(String(generated.id), /^contract_observation_/u);
    const generatedCandidate = f.service.contractCandidateInfer({ observation_ids: [one.id, generated.id] }).candidate as JsonObject;
    assert.match(String(generatedCandidate.id), /^contract_candidate_/u);
    const candidate = f.service.contractCandidateInfer({ candidate_id: "candidate", observation_ids: [one.id, two.id] }).candidate as JsonObject;
    assert.throws(() => f.service.contractCandidateInfer({ candidate_id: "candidate", observation_ids: [one.id, generated.id] }), /idempotency conflict/);
    assert.throws(() => f.service.contractCandidateReview({ candidate_id: candidate.id, decision: "maybe", reviewer: "r", review_ref: "x" }), /decision/);
    assert.throws(() => f.service.contractCandidateReview({ candidate_id: candidate.id, decision: "reject", reviewer: "r", review_ref: "x",
      corrected_contract: { effect: "read_only" } }), /cannot include corrections/);
    assert.throws(() => f.service.contractCandidateReview({ candidate_id: candidate.id, decision: "accept", reviewer: "r", review_ref: "x",
      corrected_contract: { effect: "magic" } }), /effect/);
    const rejected = f.service.contractCandidateInfer({ candidate_id: "rejected", observation_ids: [one.id, two.id] }).candidate as JsonObject;
    f.service.contractCandidateReview({ candidate_id: rejected.id, decision: "reject", reviewer: "r", review_ref: "x" });
    assert.throws(() => f.service.contractCandidateReview({ candidate_id: rejected.id, decision: "accept", reviewer: "r", review_ref: "x" }), /not awaiting/);
    assert.throws(() => f.service.contractCandidateVerify({ candidate_id: candidate.id, sandbox_profile_id: "none", sandbox_profile_version: 1, trial_id: "none" }), /not reviewed/);
    f.service.contractCandidateReview({ candidate_id: candidate.id, decision: "accept", reviewer: "r", review_ref: "x" });
    const unverified = f.store.create("sandbox_profile", "unverified", { status: "declared" });
    assert.throws(() => f.service.contractCandidateVerify({ candidate_id: candidate.id, sandbox_profile_id: unverified.id,
      sandbox_profile_version: unverified.version, trial_id: "none" }), /verified Sandbox/);
    const sandbox = f.store.create("sandbox_profile", "verified", { status: "verified" }); f.store.create("harness_configuration", "x", { name: "Probe" });
    const other = f.service.taskOpen({ title: "Other", goal: "Other" }).task as JsonObject;
    const wrongTrial = f.service.trialStart({ trial_id: "wrong", task_id: other.id, subject_type: "harness_configuration", subject_id: "x", subject_version: 1 });
    assert.throws(() => f.service.contractCandidateVerify({ candidate_id: candidate.id, sandbox_profile_id: sandbox.id,
      sandbox_profile_version: sandbox.version, trial_id: wrongTrial.id }), /another task/);
    const weakTrial = f.service.trialStart({ trial_id: "weak", task_id: f.task.id, subject_type: "harness_configuration", subject_id: "x", subject_version: 1 });
    f.service.outcomeRecord({ trial_id: weakTrial.id, verdict: "failed", summary: "failed" });
    assert.throws(() => f.service.contractCandidateVerify({ candidate_id: candidate.id, sandbox_profile_id: sandbox.id,
      sandbox_profile_version: sandbox.version, trial_id: weakTrial.id }), /evidence-backed/);

    const reviewedContract = { input_schema: schema, output_schema: schema, effect: "read_only", idempotency: false,
      compensation: false, credential_handles_required: [] };
    const contractRecord = (id: string, contract: JsonObject, extra: JsonObject = {}) => f.store.create("contract_candidate", id, {
      task_id: f.task.id, adapter_kind: "api", endpoint: "endpoint", operation: "get", status: "verified", reviewer: "reviewer",
      reviewed_contract: contract, ...extra });
    const base = contractRecord("diff-base", reviewedContract); const compatible = contractRecord("diff-compatible", { ...reviewedContract, idempotency: true });
    const breaking = contractRecord("diff-breaking", { ...reviewedContract, input_schema: { type: "string" } });
    const compensating = contractRecord("diff-compensating", { ...reviewedContract, compensation: true });
    assert.equal(f.service.contractDiff({ baseline_id: base.id, baseline_version: base.version, candidate_id: compatible.id,
      candidate_version: compatible.version }).classification, "compatible");
    assert.equal(f.service.contractDiff({ baseline_id: base.id, baseline_version: base.version, candidate_id: breaking.id,
      candidate_version: breaking.version }).classification, "breaking");
    assert.equal(f.service.contractDiff({ baseline_id: compensating.id, baseline_version: compensating.version, candidate_id: base.id,
      candidate_version: base.version }).classification, "breaking");
    const unrelated = contractRecord("unrelated", reviewedContract, { endpoint: "other" });
    assert.throws(() => f.service.contractDiff({ baseline_id: base.id, baseline_version: base.version, candidate_id: unrelated.id,
      candidate_version: unrelated.version }), /unrelated/);
    assert.throws(() => f.service.contractPublish({ candidate_id: candidate.id, candidate_version: candidate.version, asset_id: "x",
      name: "X", publisher: "p", approval_ref: "a" }), /verified Contract/);
    assert.throws(() => f.service.contractPublish({ candidate_id: base.id, candidate_version: base.version, asset_id: "x",
      name: "X", publisher: "reviewer", approval_ref: "a" }), /independent publisher/);
    const unknown = contractRecord("unknown-effect", { ...reviewedContract, effect: "unknown" });
    assert.throws(() => f.service.contractPublish({ candidate_id: unknown.id, candidate_version: unknown.version, asset_id: "x",
      name: "X", publisher: "p", approval_ref: "a" }), /not executable/);
    const publication = f.service.contractPublish({ candidate_id: base.id, candidate_version: base.version, asset_id: "published",
      name: "Published", publisher: "publisher", approval_ref: "a" }).publication as JsonObject;
    assert.match(String(publication.id), /^contract_publication_/u);
    assert.throws(() => f.service.contractPublish({ publication_id: publication.id, candidate_id: compatible.id,
      candidate_version: compatible.version, asset_id: "published", name: "Changed", publisher: "publisher", approval_ref: "a" }), /idempotency conflict/);
    f.store.save("capability_asset", "published", { ...f.store.get("capability_asset", "published"), health: "failed" });
    assert.throws(() => f.service.contractPublicationRollback({ publication_id: publication.id, reason: "x", actor: "p", rollback_ref: "r" }), /no longer owns/);
    const clean = f.service.contractPublish({ publication_id: "clean-publication", candidate_id: compatible.id,
      candidate_version: compatible.version, asset_id: "clean", name: "Clean", publisher: "publisher", approval_ref: "a" }).publication as JsonObject;
    f.service.contractPublicationRollback({ publication_id: clean.id, reason: "x", actor: "p", rollback_ref: "r" });
    assert.throws(() => f.service.contractPublicationRollback({ publication_id: clean.id, reason: "x", actor: "p", rollback_ref: "r" }), /not active/);
    const republished = f.service.contractPublish({ publication_id: "republished", candidate_id: breaking.id,
      candidate_version: breaking.version, asset_id: "clean", name: "Clean v2", publisher: "publisher", approval_ref: "a" });
    assert.equal((republished.asset as JsonObject).version, 3);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
