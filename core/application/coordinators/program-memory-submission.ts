import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";
import { stableDigest, payload } from "../../digest.ts";
import { object, text } from "../../validation.ts";

/** Two local commits, with the same target operation replayed after a lost response. */
export class ProgramMemorySubmissionCoordinator {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  submit(plan: JsonObject, execute: (plan: JsonObject) => JsonObject): JsonObject {
    const candidate = object(plan.candidate, "candidate");
    const requestId = text(plan.request_id, "request_id");
    const scope = object(candidate.scope, "candidate.scope");
    if (scope.kind !== "project" || typeof scope.id !== "string" || !scope.id.startsWith("project:")
      || !Number.isSafeInteger(candidate.version) || Number(candidate.version) < 1) throw new Error("Submission requires an exact project candidate version");
    const identity = { request_id: requestId, candidate_id: text(candidate.id, "candidate.id"),
      candidate_version: candidate.version, candidate_digest: text(candidate.digest, "candidate.digest"), scope,
      intent_digest: stableDigest(plan) };
    const id = `program_memory_submission_${stableDigest(requestId).slice(-24)}`;
    const existing = this.store.find("program_memory_submission", id);
    if (existing && stableDigest(existing.identity) !== stableDigest(identity)) throw new Error("Submission operation intent conflict");
    if (existing?.status === "committed") return object(existing.receipt, "receipt");
    const operation = existing ?? this.store.create("program_memory_submission", id, { identity, status: "pending",
      target_owner: "experience", attempts: 0, reason: null });
    const pending = this.store.save("program_memory_submission", id, { ...payload(operation), status: "pending",
      attempts: Number(operation.attempts) + 1, reason: null });
    try {
      const receipt = execute(plan);
      if (receipt.request_id !== requestId || receipt.procedure_id !== plan.procedure_id
        || !Number.isSafeInteger(receipt.procedure_candidate_version) || Number(receipt.procedure_candidate_version) < 1) {
        throw new Error("Experience submission returned a mismatched receipt");
      }
      this.store.save("program_memory_submission", id, { ...payload(pending), status: "committed", receipt,
        receipt_digest: stableDigest(receipt), reason: null });
      return receipt;
    } catch (error) {
      // Persist only a bounded reason; transport errors can contain private payloads.
      this.store.save("program_memory_submission", id, { ...payload(pending), status: "retryable",
        reason: error instanceof Error && error.message === "Experience submission returned a mismatched receipt"
          ? "receipt_mismatch" : "target_unavailable_or_response_lost" });
      throw error;
    }
  }
}
