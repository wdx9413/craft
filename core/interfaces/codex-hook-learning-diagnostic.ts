import type { JsonObject } from "../infrastructure/store.ts";

/** Project only content-free statuses for the terminal Host learning stages. */
export function codexHookLearningStageDiagnostic(journal: JsonObject | null, finalized: JsonObject | null,
  candidates: JsonObject[]): JsonObject {
  const observation = finalized?.observation as JsonObject | undefined;
  const observationId = typeof observation?.id === "string" ? observation.id : null;
  const candidateStatuses = candidates.filter(candidate => observationId !== null && Array.isArray(candidate.evidence_ids)
      && (candidate.evidence_ids as unknown[]).includes(observationId))
    .map(candidate => typeof candidate.status === "string" ? candidate.status : "")
    .filter(Boolean).slice(0, 5);
  const hasCandidate = candidateStatuses.length > 0;
  return {
    edit_seen: journal?.has_edit === true,
    verification_status: journal?.verification_outcome === "passed" || journal?.verification_outcome === "failed" ? journal.verification_outcome : "missing",
    context_receipt_bound: typeof journal?.context_receipt_id === "string",
    observation_status: observationId ? "stored" : "not_written",
    program_memory_candidate_status: candidateStatuses.join(",") || "not_created",
    promotion_status: candidateStatuses.includes("promoted") ? "promoted" : hasCandidate ? "not_promoted" : "not_reached",
  };
}
