import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { stableDigest } from "../core/digest.ts";
import { autoDemoteFromVerifiedHostFeedback } from "../core/application/host-feedback-procedure-demotion.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-host-feedback-procedure-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  store.create("scope_alias", "project-p", { status: "active", scope: { kind: "project", id: "project:p" }, alias_kind: "path", alias: root, alias_digest: stableDigest(root) });
  store.create("experience_procedure", "procedure-p", { scope: "project:p", lifecycle: "routeable", routeable: true, completed_gates: ["shadow", "held_out", "signoff", "canary"], procedure_kind: "workflow",
    title: "Rollback the failed change", trigger: "rollback failed changes", acceptance_ref: "acceptance:rollback", content_digest: "sha256:procedure",
    scenario_signature: {} });
  return { root, store, service, async close() { await store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("caller supplied negative Context feedback cannot revoke an Experience Procedure", async () => {
  const f = await fixture();
  try {
    const initial = await f.service.contextResolution.resolve({ query: "rollback", scope_kind: "project", scope_id: "p" });
    const receipt = initial.receipt as JsonObject;
    const experience = (initial.contributions as JsonObject[]).find(item => item.member === "experience")!;
    const item = (experience.items as JsonObject[])[0]!;
    assert.equal(item.procedure_id, "procedure-p");
    f.store.create("evidence", "host-failed-use", { source_type: "program", confidence: "confirmed",
      metadata: { context_receipt_id: receipt.id, verdict: "passed" } });
    const server = new McpServer(f.service);
    const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "craft_context_resolution_feedback", arguments: {
      receipt_id: receipt.id, outcome: "incorrect", usage_stage: "verified", turn_outcome: "failed", evidence_ids: ["host-failed-use"],
      asset_refs: [{ member: "experience", id: item.procedure_id, version: item.procedure_version, digest: item.content_digest }],
    } } }) as JsonObject;
    assert.equal((response.result as JsonObject).isError, false, JSON.stringify(response));
    const result = (response.result as JsonObject).structuredContent as JsonObject;
    assert.equal((result.auto_demotions as JsonObject[]).length, 0);
    assert.equal((result.feedback as JsonObject).provenance, "caller_reported");
    assert.equal(f.store.get("experience_procedure", "procedure-p").routeable, true);
  } finally { await f.close(); }
});

test("unverified, merely shown, or stale Host feedback cannot revoke a Procedure", async () => {
  const f = await fixture();
  try {
    const initial = await f.service.contextResolution.resolve({ query: "rollback", scope_kind: "project", scope_id: "p" });
    const receipt = initial.receipt as JsonObject;
    const experience = (initial.contributions as JsonObject[]).find(item => item.member === "experience")!;
    const item = (experience.items as JsonObject[])[0]!;
    f.store.create("evidence", "host-evidence", { source_type: "program", confidence: "confirmed", metadata: { context_receipt_id: receipt.id, verdict: "passed" } });
    const response = await f.service.contextResolutionFeedback({ receipt_id: receipt.id, outcome: "stale", usage_stage: "shown", turn_outcome: "failed",
      evidence_ids: ["host-evidence"], asset_refs: [{ member: "experience", id: item.procedure_id, version: item.procedure_version, digest: item.content_digest }] });
    assert.equal((response.auto_demotions as JsonObject[]).length, 0);
    const current = f.store.get("experience_procedure", "procedure-p");
    assert.equal(current.routeable, true);
  } finally { await f.close(); }
});

test("Host feedback demotion requires a trusted paired failure for the exact current candidate", async () => {
  const f = await fixture();
  try {
    const procedure = f.store.get("experience_procedure", "procedure-p");
    const ref = { member: "experience", id: procedure.id, version: procedure.version, digest: procedure.content_digest };
    const contractDigest = `sha256:${"b".repeat(64)}`, evaluationDigest = `sha256:${"c".repeat(64)}`;
    f.store.create("evaluation_contract", "contract", { contract_digest: contractDigest });
    f.store.create("task_effect_evaluation", "evaluation", { contract_id: "contract", evaluation_digest: evaluationDigest });
    let candidateRef = { kind: "experience_procedure", id: String(procedure.id), version: Number(procedure.candidate_version ?? procedure.version),
      digest: String(procedure.definition_digest ?? procedure.content_digest) };
    const base = { id: "feedback-1", outcome: "incorrect", evaluation_contract_id: "contract", evaluation_id: "evaluation",
      asset_refs: [ref], receipt_id: "receipt-1" };
    const gateCalls: JsonObject[] = [];
    const gate = (args: JsonObject) => { gateCalls.push(args); return { procedure: { routeable: false }, idempotent: true }; };
    let proof: JsonObject = { valid: true, eligible: false, contract_digest: contractDigest, evaluation_digest: evaluationDigest, candidate_ref: candidateRef };
    const evaluations = { verifyTaskEffectEvaluation(args: JsonObject) { assert.deepEqual(args.candidate_ref, candidateRef); return proof; } };
    for (const feedback of [undefined, { ...base, outcome: "helpful" }, { ...base, evaluation_id: undefined },
      { ...base, asset_refs: "not-an-array" }, { ...base, asset_refs: [{ ...ref, version: 2 }] }, { ...base, asset_refs: [{ ...ref, digest: "sha256:stale" }] },
      { ...base, asset_refs: [{ ...ref, member: "memory" }, { ...ref, id: 7 }, { ...ref, version: 1.5 }, { ...ref, digest: 7 }] }]) {
      assert.deepEqual(autoDemoteFromVerifiedHostFeedback(feedback, f.store, { gate }, evaluations), []);
    }
    for (const invalid of [{ valid: false }, { valid: true, eligible: true },
      { valid: true, eligible: false, contract_digest: contractDigest, evaluation_digest: evaluationDigest,
        candidate_ref: { ...candidateRef, digest: "sha256:wrong" } }]) {
      proof = invalid;
      assert.deepEqual(autoDemoteFromVerifiedHostFeedback(base, f.store, { gate }, evaluations), []);
    }
    proof = { valid: true, eligible: false, contract_digest: contractDigest, evaluation_digest: evaluationDigest, candidate_ref: candidateRef };
    const originalContract = f.store.get("evaluation_contract", "contract"), originalEvaluation = f.store.get("task_effect_evaluation", "evaluation");
    for (const [contractPatch, evaluationPatch] of [[{}, { contract_id: "other" }], [{ contract_digest: "other" }, {}],
      [{}, { evaluation_digest: "other" }]] as const) {
      f.store.save("evaluation_contract", "contract", { ...originalContract, ...contractPatch });
      f.store.save("task_effect_evaluation", "evaluation", { ...originalEvaluation, ...evaluationPatch });
      assert.deepEqual(autoDemoteFromVerifiedHostFeedback(base, f.store, { gate }, evaluations), []);
    }
    f.store.save("evaluation_contract", "contract", originalContract);
    f.store.save("task_effect_evaluation", "evaluation", originalEvaluation);
    const demoted = autoDemoteFromVerifiedHostFeedback(base, f.store, { gate }, evaluations);
    assert.equal(demoted.length, 1);
    assert.equal(demoted[0]!.idempotent, true);
    assert.match(String((gateCalls[0]!.evidence_ids as string[])[0]), /^experience_feedback_failure_/u);
    assert.equal(f.store.get("evidence", String((gateCalls[0]!.evidence_ids as string[])[0])).record_origin, "experience_evaluator");
    assert.equal(autoDemoteFromVerifiedHostFeedback(base, f.store, { gate }, evaluations).length, 1, "the evaluator receipt is reused idempotently");
    assert.equal(f.store.list("evidence", 10, row => row.record_origin === "experience_evaluator").length, 1);
    const revisedProcedure = f.store.save("experience_procedure", String(procedure.id), { ...procedure, candidate_version: 3, definition_digest: "sha256:definition" });
    base.asset_refs = [{ ...ref, version: revisedProcedure.version }];
    candidateRef = { kind: "experience_procedure", id: String(procedure.id), version: 3, digest: "sha256:definition" };
    proof = { valid: true, eligible: false, contract_digest: contractDigest, evaluation_digest: evaluationDigest, candidate_ref: candidateRef };
    assert.equal(autoDemoteFromVerifiedHostFeedback(base, f.store, { gate }, evaluations).length, 1, "candidate version and digest override the active projection fallback");
    const currentProcedure = f.store.get("experience_procedure", String(procedure.id));
    f.store.save("experience_procedure", String(procedure.id), { ...currentProcedure, lifecycle: "candidate", routeable: false });
    assert.deepEqual(autoDemoteFromVerifiedHostFeedback(base, f.store, { gate }, evaluations), []);
    assert.equal(gateCalls.length, 3);
  } finally { await f.close(); }
});
