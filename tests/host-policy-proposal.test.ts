import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CraftStore, JsonObject } from "../core/infrastructure/store.ts";
import { HostPolicyProposalKernel, hostPolicyCandidateRef } from "../core/host-policy-proposal.ts";
import { TOOLS } from "../core/mcp/tool-catalog.ts";
import { EvaluationContractKernel } from "../core/evaluation-contract.ts";
import { digestJson } from "../core/digest.ts";

const digest = `sha256:${"a".repeat(64)}`;
const diff = "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-old\n+new\n";
const proposalArgs = (patch: JsonObject = {}) => ({ target: "repository_agents", scope: { kind: "project", id: "project-a" },
  base_digest: digest, diff, proposed_by: "codex", evaluation_contract_id: "contract", evaluation_id: "evaluation", ...patch });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-host-policy-proposal-"));
  const records = new Map<string, JsonObject>();
  const store = {
    find(kind: string, id: string) { return records.get(`${kind}:${id}`) ?? null; },
    get(kind: string, id: string, version?: number) { const record = records.get(`${kind}:${id}`); if (!record) throw new Error(`Unknown ${kind}: ${id}`); if (version !== undefined && Number(record.version) !== version) throw new Error(`${kind} version not found: ${version}`); return record; },
    create(kind: string, id: string, data: JsonObject) { const record = { id, version: 1, ...data }; records.set(`${kind}:${id}`, record); return record; },
    save(kind: string, id: string, data: JsonObject) { const record = { ...data, id, version: Number(records.get(`${kind}:${id}`)?.version ?? 0) + 1 }; records.set(`${kind}:${id}`, record); return record; },
  } as unknown as CraftStore;
  const contractDigest = `sha256:${"b".repeat(64)}`, evaluationDigest = `sha256:${"c".repeat(64)}`;
  store.create("evaluation_contract", "contract", { effect: "task_effect", verified_stage: "routeable", contract_digest: contractDigest });
  store.create("task_effect_evaluation", "evaluation", { contract_id: "contract", contract_digest: contractDigest, evaluation_digest: evaluationDigest, result: { eligible: true } });
  const prototype = EvaluationContractKernel.prototype as unknown as { verifyTaskEffectEvaluation: (input: JsonObject) => JsonObject };
  const original = prototype.verifyTaskEffectEvaluation;
  let proof: JsonObject = { valid: true, eligible: true, routeable: true, contract_digest: contractDigest, evaluation_digest: evaluationDigest };
  let expectedCandidate: JsonObject | undefined;
  prototype.verifyTaskEffectEvaluation = (input) => expectedCandidate && JSON.stringify(input.candidate_ref) === JSON.stringify(expectedCandidate)
    ? (proof.valid === true ? { ...proof, candidate_ref: proof.candidate_ref ?? expectedCandidate } : proof) : { valid: false };
  const kernel = new HostPolicyProposalKernel(store);
  const prepare = (patch: JsonObject = {}) => {
    const prepared = kernel.prepare({ ...proposalArgs(patch), ...patch });
    expectedCandidate = prepared.candidate_ref as unknown as JsonObject;
    return prepared;
  };
  const propose = (patch: JsonObject = {}) => {
    const args = proposalArgs(patch);
    const prepared = kernel.prepare(args);
    expectedCandidate = prepared.candidate_ref as unknown as JsonObject;
    if (proof.valid === true) proof = { ...proof, candidate_ref: expectedCandidate };
    return kernel.propose(args);
  };
  const approve = (proposal: JsonObject, decision: string, reason: string) => {
    const approvalArgs = { proposal_id: String(proposal.id), expected_version: Number(proposal.version), decision, reason };
    const approval = store.create("internal_action_approval", `approval-${proposal.id}`, { status: "consumed", action: "host_policy_proposal_review",
      effect: "external_write", args_digest: digestJson(approvalArgs), decided_at: new Date().toISOString() });
    return kernel.review({ ...approvalArgs, approval_ref: String(approval.id) });
  };
  return { root, store, kernel, propose, prepare, approve, setProof(value: JsonObject) { proof = value; }, get expectedCandidate() { return expectedCandidate; }, async close() {
    prototype.verifyTaskEffectEvaluation = original; rmSync(root, { recursive: true, force: true });
  } };
}

test("host-policy proposals require an exact prepared candidate and human approval receipt", async () => {
  const f = await fixture();
  try {
    for (const name of ["craft_host_policy_proposal_prepare", "craft_host_policy_proposal_propose", "craft_host_policy_proposal_review", "craft_host_policy_proposal_get"]) {
      assert(TOOLS.some((item) => item.name === name), `${name} is exposed on the Runtime MCP catalog`);
    }
    const candidate = f.prepare();
    assert.equal(f.prepare().idempotent, true);
    assert.deepEqual(candidate.candidate_ref, hostPolicyCandidateRef(proposalArgs()));
    f.setProof({ valid: true, eligible: true, routeable: true, contract_digest: `sha256:${"b".repeat(64)}`,
      evaluation_digest: `sha256:${"c".repeat(64)}`, candidate_ref: candidate.candidate_ref });
    const proposed = f.kernel.propose(proposalArgs());
    const proposal = proposed.proposal as JsonObject;
    assert.equal(proposed.can_apply, false);
    assert.equal(proposal.status, "review_required");
    assert.equal(((proposal.effect_evidence as JsonObject).candidate_ref as JsonObject).digest, (candidate.candidate_ref as unknown as JsonObject).digest);
    const read = f.kernel.get({ proposal_id: proposal.id });
    assert.equal(read.can_apply, false);
    assert.throws(() => f.kernel.review({ proposal_id: proposal.id, expected_version: proposal.version,
      reviewer: "caller", decision: "accept", reason: "looks good" }), /approval_ref/u);
    const reviewArgs = { proposal_id: String(proposal.id), expected_version: Number(proposal.version), decision: "accept", reason: "looks good" };
    for (const [id, overrides] of [["pending", { status: "approved" }], ["wrong-action", { action: "other" }],
      ["wrong-effect", { effect: "local_write" }], ["wrong-digest", { args_digest: "wrong" }], ["no-human-time", { decided_at: null }]] as const) {
      f.store.create("internal_action_approval", id, { status: "consumed", action: "host_policy_proposal_review", effect: "external_write",
        args_digest: digestJson(reviewArgs), decided_at: new Date().toISOString(), ...overrides });
      assert.throws(() => f.kernel.review({ ...reviewArgs, approval_ref: id }), /consumed Workbench human approval/u);
    }
    const reviewed = f.approve(proposal, "accept", "The user will apply this manually");
    assert.equal(reviewed.can_apply, false);
    assert.equal((reviewed.proposal as JsonObject).status, "accepted_for_manual_application");
    assert.equal((reviewed.proposal as JsonObject).applied, false);
    const staleApprovalArgs = { proposal_id: String(proposal.id), expected_version: 1, decision: "reject", reason: "stale" };
    const staleApproval = f.store.create("internal_action_approval", "stale-version", { status: "consumed", action: "host_policy_proposal_review",
      effect: "external_write", args_digest: digestJson(staleApprovalArgs), decided_at: new Date().toISOString() });
    assert.throws(() => f.kernel.review({ ...staleApprovalArgs, approval_ref: staleApproval.id }), /version conflict/u);
    const replayArgs = { proposal_id: String(proposal.id), expected_version: 2, decision: "reject", reason: "again" };
    const replayApproval = f.store.create("internal_action_approval", "already-reviewed", { status: "consumed", action: "host_policy_proposal_review",
      effect: "external_write", args_digest: digestJson(replayArgs), decided_at: new Date().toISOString() });
    assert.throws(() => f.kernel.review({ ...replayArgs, approval_ref: replayApproval.id }), /already been reviewed/u);
    const rejected = f.propose({ proposal_id: "reject-me", target: "codex_user_config", scope: { kind: "user", id: "user-a" } }).proposal as JsonObject;
    f.approve(rejected, "reject", "Do not change this");
    assert.equal((f.kernel.get({ proposal_id: rejected.id }).proposal as JsonObject).status, "rejected");
  } finally { await f.close(); }
});

test("source references are normalized, checked and make proposal creation idempotent", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence", "source-a", { title: "Evidence" });
    f.store.create("evidence", "source-b", { title: "Evidence" });
    const refs = [{ kind: "evidence", id: "source-b", version: 1 }, { kind: "evidence", id: "source-a", version: 1 }];
    const first = f.propose({ proposal_id: "with-sources", source_refs: refs });
    assert.deepEqual((first.proposal as JsonObject).source_refs, [...refs].reverse());
    assert.equal(f.propose({ proposal_id: "with-sources", source_refs: refs }).idempotent, true);
    assert.throws(() => f.propose({ proposal_id: "duplicates", source_refs: [refs[0]!, refs[0]!] }), /unique/u);
    assert.throws(() => f.propose({ proposal_id: "too-many", source_refs: Array.from({ length: 21 }, (_, index) => ({ kind: "evidence", id: `e-${index}`, version: 1 })) }), /at most 20/u);
    assert.throws(() => f.propose({ proposal_id: "bad-version", source_refs: [{ kind: "evidence", id: "source-a", version: 0 }] }), /positive integer/u);
    assert.throws(() => f.propose({ proposal_id: "missing-source", source_refs: [{ kind: "evidence", id: "missing", version: 1 }] }), /Unknown evidence/u);
    assert.throws(() => f.propose({ proposal_id: "bad-array", source_refs: "invalid" }), /at most 20/u);
  } finally { await f.close(); }
});

test("host-policy validation fails closed and evaluation cannot be reused for another diff", async () => {
  const f = await fixture();
  try {
    const invalidInputs: JsonObject[] = [
      { target: "other" }, { scope: { kind: "workspace", id: "p" } }, { scope: { kind: "project" } },
      { base_digest: "bad" }, { diff: "not a diff" }, { diff: "--- a/x\n+++ b/x\n+api_key=abc" },
      { diff: `--- a/x\n+++ b/x\n+${"x".repeat(20_001)}` }, { diff: "--- a/x\n+++ b/x\n+bad\u0001text" },
    ];
    for (const patch of invalidInputs) assert.throws(() => f.prepare(patch));
    const prepared = f.prepare();
    const candidate = prepared.candidate as JsonObject;
    const candidateId = String(candidate.id);
    f.store.save("host_policy_candidate", candidateId, { ...candidate, identity_digest: "tampered" });
    assert.throws(() => f.prepare(), /identity conflict/u);
    f.store.save("host_policy_candidate", candidateId, candidate);
    assert.throws(() => f.kernel.propose({ ...proposalArgs(), target: "unsupported" }), /target is unsupported/u);
    assert.throws(() => f.kernel.propose({ ...proposalArgs(), scope: { kind: "workspace", id: "p" } }), /scope must be user or project/u);
    assert.throws(() => f.kernel.propose({ ...proposalArgs(), base_digest: "bad" }), /base_digest must be a sha256 digest/u);
    f.store.save("host_policy_candidate", candidateId, { ...candidate, diff: "mutated" });
    assert.throws(() => f.kernel.propose(proposalArgs()), /diff changed after candidate preparation/u);
    f.store.save("host_policy_candidate", candidateId, candidate);
    f.setProof({ valid: true, eligible: true, routeable: true, contract_digest: `sha256:${"b".repeat(64)}`,
      evaluation_digest: `sha256:${"c".repeat(64)}`, candidate_ref: prepared.candidate_ref });
    const altered = { ...proposalArgs(), diff: "--- a/AGENTS.md\n+++ b/AGENTS.md\n+different\n" };
    assert.throws(() => f.kernel.propose(altered), /Unknown host_policy_candidate/u);
    for (const invalid of [
      { valid: false }, { valid: true, eligible: false }, { valid: true, eligible: true, routeable: false },
      { valid: true, eligible: true, routeable: true, contract_digest: 1 },
      { valid: true, eligible: true, routeable: true, contract_digest: "contract", evaluation_digest: 1 },
      { valid: true, eligible: true, routeable: true, contract_digest: "contract", evaluation_digest: "evaluation" },
      { valid: true, eligible: true, routeable: true, contract_digest: `sha256:${"b".repeat(64)}`, evaluation_digest: `sha256:${"c".repeat(64)}`, candidate_ref: { kind: "other" } },
    ]) {
      f.setProof(invalid);
      assert.throws(() => f.kernel.propose(proposalArgs()), /routeable exact task-effect Evaluation Contract|effect evidence changed/u);
    }
    f.setProof({ valid: true, eligible: true, routeable: true, contract_digest: `sha256:${"b".repeat(64)}`,
      evaluation_digest: `sha256:${"c".repeat(64)}`, candidate_ref: prepared.candidate_ref });
    const first = f.propose({ proposal_id: "fixed-id" });
    assert.throws(() => f.propose({ proposal_id: "fixed-id", diff: "--- a/AGENTS.md\n+++ b/AGENTS.md\n+different\n" }), /idempotency conflict/u);
    const proposal = first.proposal as JsonObject;
    for (const args of [
      { proposal_id: proposal.id, expected_version: 0, approval_ref: "x", decision: "accept", reason: "ok" },
      { proposal_id: proposal.id, expected_version: proposal.version, approval_ref: "x", decision: "maybe", reason: "ok" },
      { proposal_id: proposal.id, expected_version: proposal.version, approval_ref: "x", decision: "accept", reason: "" },
    ]) assert.throws(() => f.kernel.review(args));
    assert.throws(() => f.kernel.get({ proposal_id: "missing" }), /Unknown host_policy_proposal/u);
  } finally { await f.close(); }
});
