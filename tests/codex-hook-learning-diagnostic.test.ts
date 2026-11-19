import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { codexHookLearningStageDiagnostic } from "../core/interfaces/codex-hook-learning-diagnostic.ts";

test("learning stage projection distinguishes missing, stored, candidate and promoted states", () => {
  assert.deepEqual(codexHookLearningStageDiagnostic(null, null, []), {
    edit_seen: false, verification_status: "missing", context_receipt_bound: false, observation_status: "not_written",
    program_memory_candidate_status: "not_created", promotion_status: "not_reached",
  });
  assert.deepEqual(codexHookLearningStageDiagnostic({ verification_outcome: "unknown" }, { observation: {} }, []), {
    edit_seen: false, verification_status: "missing", context_receipt_bound: false, observation_status: "not_written",
    program_memory_candidate_status: "not_created", promotion_status: "not_reached",
  });
  assert.deepEqual(codexHookLearningStageDiagnostic({ has_edit: true, verification_outcome: "failed", context_receipt_id: "receipt" },
    { observation: { id: "observation-1" } }, [{ evidence_ids: ["another-observation"], status: "diagnostic" }, { status: "diagnostic" }]), {
    edit_seen: true, verification_status: "failed", context_receipt_bound: true, observation_status: "stored",
    program_memory_candidate_status: "not_created", promotion_status: "not_reached",
  });
  assert.deepEqual(codexHookLearningStageDiagnostic({ has_edit: true, verification_outcome: "passed" },
    { observation: { id: "observation-2" } }, [{ evidence_ids: ["observation-2"], status: "diagnostic" }]), {
    edit_seen: true, verification_status: "passed", context_receipt_bound: false, observation_status: "stored",
    program_memory_candidate_status: "diagnostic", promotion_status: "not_promoted",
  });
  assert.deepEqual(codexHookLearningStageDiagnostic({ verification_outcome: "passed" }, { observation: { id: "observation-3" } }, [
    { evidence_ids: ["observation-3"], status: "" }, { evidence_ids: ["observation-3"] }, { evidence_ids: ["observation-3"], status: "promoted" },
  ]), {
    edit_seen: false, verification_status: "passed", context_receipt_bound: false, observation_status: "stored",
    program_memory_candidate_status: "promoted", promotion_status: "promoted",
  } satisfies JsonObject);
});
