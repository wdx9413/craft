import { stableDigest } from "../../core/digest.ts";
import type { CraftService } from "../../core/service.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";
import { knowledgeEvaluationCaseBindingDigest } from "../../core/knowledge-evaluation-provenance.ts";

/** Internal validator fixture. This synthetic Trace is not Host execution proof. */
export function adjudicateKnowledgeCase(service: CraftService, case_: JsonObject,
  decision: "accepted" | "corrected" | "rejected" | "uncertain" = "accepted",
  expectedClaimIds = Array.isArray(case_.expected_claim_ids) ? case_.expected_claim_ids as string[] : [], overrides: JsonObject = {}): JsonObject {
  const traceId = `trace_knowledge_adjudication_${String(case_.id)}`;
  const binding = knowledgeEvaluationCaseBindingDigest(case_);
  const inputDigest = stableDigest({ case_id: case_.id, case_version: case_.version, binding });
  const responseDigest = stableDigest({ decision, expected_claim_ids: expectedClaimIds });
  const modelFingerprint = "sha256:test-host-adjudicator";
  service.traceStart({ trace_id: traceId, task_id: `knowledge:adjudication:${case_.id}`, operation_id: String(case_.id), model_fingerprint: modelFingerprint });
  service.traceAppend({ trace_id: traceId, event_kind: "model.request", actor: "knowledge-session-adjudication-worker",
    source: "codex-cli-learning-transport", trust: "observed", model_fingerprint: modelFingerprint, input_refs: [binding, inputDigest],
    data: { case_binding_digest: binding, input_digest: inputDigest, content_stored: false }, summary: "test request" });
  service.traceAppend({ trace_id: traceId, event_kind: "model.completed", actor: "knowledge-session-adjudication-worker",
    source: "codex-cli-learning-transport", trust: "observed", model_fingerprint: modelFingerprint,
    data: { case_binding_digest: binding, input_digest: inputDigest, response_digest: responseDigest }, summary: "test completion" });
  service.traceAppend({ trace_id: traceId, event_kind: "knowledge.evaluation_adjudication_candidate",
    actor: "knowledge-session-adjudication-worker", source: "craft-knowledge", trust: "observed", model_fingerprint: modelFingerprint,
    data: { case_binding_digest: binding, input_digest: inputDigest, response_digest: responseDigest, decision, expected_claim_ids: expectedClaimIds },
    output_refs: [String(case_.id)], summary: "test decision" });
  service.traceFinalize({ trace_id: traceId, status: "completed", summary: "test adjudication complete" });
  return service.knowledgeEvaluationCaseAdjudicate({ case_id: String(case_.id), expected_version: case_.version, trace_id: traceId,
    input_digest: inputDigest, response_digest: responseDigest, decision, expected_claim_ids: expectedClaimIds, ...overrides }, true);
}
