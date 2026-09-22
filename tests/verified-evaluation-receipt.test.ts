import assert from "node:assert/strict";
import test from "node:test";
import { receiptEvidenceIds, receiptPassed, receiptPayload, verifiedEvaluationReceipt } from "../capability/verified-evaluation-receipt.ts";

function receipt(overrides: Record<string, unknown> = {}) {
  const check = { evidence_id: "evidence", command_digest: "sha256:command", result_digest: "sha256:result", status: "passed" };
  return { kind: "craft.engineering-evaluation.v1", issued_by: "engineering-eval-cli", host_terminal: check, frozen_input_digest: "sha256:frozen", workspace_before_digest: "sha256:before", workspace_after_digest: "sha256:after", acceptance: check, siblings: [check, check], effect_check: check, safety_check: check, factual_check: check, root_cause_evidence_ids: ["root"], retry_count: 0, cost_units: 0, latency_ms: 0, ...overrides };
}

test("Verified Evaluation Receipt validates every independent program check and scalar", () => {
  const accepted = verifiedEvaluationReceipt(receipt());
  assert.equal(receiptPassed(accepted), true); assert.equal(receiptEvidenceIds(accepted).length, 8);
  assert.equal(receiptPayload(accepted).kind, "craft.engineering-evaluation.v1");
  const failed = verifiedEvaluationReceipt(receipt({ acceptance: { evidence_id: "accept", command_digest: "sha256:command", result_digest: "sha256:result", status: "failed" } }));
  assert.equal(receiptPassed(failed), false);
  for (const invalid of [
    receipt({ kind: "other" }), receipt({ issued_by: "other" }), receipt({ siblings: [] }), receipt({ root_cause_evidence_ids: [] }), receipt({ root_cause_evidence_ids: ["root", "root"] }), receipt({ frozen_input_digest: "invalid" }), receipt({ acceptance: { evidence_id: "x", command_digest: "sha256:x", result_digest: "sha256:y", status: "other" } }), receipt({ retry_count: -1 }), receipt({ retry_count: 0.5 }), receipt({ cost_units: -1 }), receipt({ latency_ms: Number.NaN }), null,
  ]) assert.throws(() => verifiedEvaluationReceipt(invalid));
});
