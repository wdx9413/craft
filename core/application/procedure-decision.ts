import type { CraftService } from "./craft-service.ts";
import type { JsonObject } from "../infrastructure/store.ts";
import { object, text } from "../validation.ts";
import { stableDigest } from "../digest.ts";

/** Three-valued guards: absent/invalid data never means false or zero. No code is evaluated. */
export function matchesDecisionGuard(raw: unknown, values: JsonObject): boolean | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw new Error("Decision guard requires 1..100 clauses");
  const outcomes = raw.map(value => {
    const clause = object(value, "guard clause"), field = text(clause.field, "guard field"), op = text(clause.op, "guard op");
    if (!["eq", "eq_field", "gte"].includes(op)) throw new Error("Unsupported decision guard operator");
    const actual = Object.hasOwn(values, field) ? values[field] : undefined;
    const expected = op === "eq_field" ? values[text(clause.value_field, "value_field")] : clause.value;
    if (actual === undefined || actual === null || expected === undefined || expected === null) return null;
    if (op === "gte") return typeof actual === "number" && Number.isFinite(actual) && typeof expected === "number" && Number.isFinite(expected) ? actual >= expected : null;
    if (!["string", "number", "boolean"].includes(typeof expected) || typeof actual !== typeof expected) return null;
    if (typeof actual === "number" && (!Number.isFinite(actual) || !Number.isFinite(expected as number))) return null;
    return actual === expected;
  });
  // A known false conjunct rules out this branch; unrelated missing fields do not make it viable.
  return outcomes.includes(false) ? false : outcomes.includes(null) ? null : true;
}

/** Selects and advances only a unique edge proved by the current accepted node's evidence. */
export function procedureDecisionEvaluate(service: CraftService, args: JsonObject): JsonObject {
  return service.store.transaction(() => {
    const state = service.procedureInvocationGet(args), run = object(state.invocation, "invocation");
    const decisionId = `${run.id}:${text(args.decision_id, "decision_id")}`, requestDigest = stableDigest(args);
    const existing = service.store.find("procedure_host_decision", decisionId);
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new Error("Decision idempotency conflict");
      return { decision: existing, invocation: run, idempotent: true, host_execution_authority: false };
    }
    if (run.version !== args.expected_version || run.lifecycle !== "active") throw new Error("Decision requires current active Invocation version");
    const graph = object(run.graph, "runtime Graph"), progress = object(run.graph_state, "graph state");
    const node = (graph.nodes as JsonObject[]).find(node => node.id === progress.active_node);
    if (!node) throw new Error("Graph is at its selected exit, not a decision node");
    const receipt = service.store.get("procedure_invocation_receipt", text(args.receipt_id, "receipt_id"));
    const snapshot = service.store.get("state_snapshot", text(args.snapshot_id, "snapshot_id"));
    const loop = object(state.loop, "loop");
    if (receipt.id !== run.last_receipt_id || receipt.invocation_id !== run.id || receipt.status !== "passed"
      || snapshot.workspace_id !== run.workspace_id || snapshot.snapshot_digest !== loop.latest_snapshot_digest) throw new Error("Decision receipt or snapshot is not current");
    const source = service.store.get("evidence", text(args.fact_evidence_id, "fact_evidence_id")), meta = object(source.metadata, "fact metadata");
    const observation = service.store.get("outcome_observation", String(receipt.observation_id));
    const acceptance = service.store.get("acceptance_gate", String(receipt.acceptance_gate_id));
    const programBound = source.source_type === "program" && (observation.evidence_ids as string[]).includes(String(source.id))
      && (acceptance.required_evidence_ids as string[]).includes(String(source.id))
      && meta.dispatch_digest === receipt.dispatch_digest && meta.state_after_digest === snapshot.snapshot_digest;
    const humanBound = source.source_type === "human" && meta.invocation_id === run.id && meta.receipt_id === receipt.id
      && meta.snapshot_digest === snapshot.snapshot_digest && Number.isFinite(Date.parse(String(meta.expires_at))) && Date.parse(String(meta.expires_at)) > Date.now();
    if (source.confidence !== "confirmed" || !(programBound || humanBound)) throw new Error("Decision facts are unverified, stale or bound to another node");
    const values = object(meta.fact_values, "verified fact_values"), rules = object(node.decision_rules ?? {}, "decision_rules");
    const edges = (graph.edges as JsonObject[]).filter(edge => edge.from === node.id && (graph.scenario as JsonObject).allowed_edges instanceof Array
      && ((graph.scenario as JsonObject).allowed_edges as string[]).includes(String(edge.id)));
    let unknown = false;
    const matched = edges.filter(edge => {
      if (edge.kind === "human_resume" && !humanBound || edge.kind !== "human_resume" && !programBound) return false;
      if (!["success", "condition", "human_resume"].includes(String(edge.kind))) return false;
      if (!edge.predicate_ref) return true;
      const guard = rules[String(edge.predicate_ref)];
      if (guard === undefined) { unknown = true; return false; }
      const result = matchesDecisionGuard(guard, values); if (result === null) unknown = true;
      return result === true;
    });
    if (unknown || matched.length !== 1) return { status: "blocked", reason: unknown ? "decision_inputs_or_evaluator_unavailable" : "no_unique_matching_edge", host_execution_authority: false };
    const edge = matched[0]!;
    if (programBound && (edge.predicate_ref || edge.rework === true) && (meta.fact_values_ref !== `artifact:${stableDigest(values)}`
      || !Object.values(object(receipt.output_refs, "accepted outputs")).includes(meta.fact_values_ref))) throw new Error("Decision facts changed after accepted output or lack a digest-pinned artifact");
    if (edge.rework === true && values.safe_to_retry !== true) return { status: "blocked", reason: "safe_target_state_not_verified", host_execution_authority: false };
    const evidenceId = `procedure_decision:${decisionId}`;
    service.evidenceRecord({ evidence_id: evidenceId, source_type: edge.kind === "human_resume" ? "human" : "program", confidence: "confirmed",
      claim: "The declared guard matched one current graph edge; source facts remain Host-attested.", metadata: {
        scope: run.scope, invocation_id: run.id, receipt_id: receipt.id, graph_state_digest: stableDigest(progress), snapshot_digest: snapshot.snapshot_digest,
        workspace_state_revision: snapshot.workspace_state_revision, expires_at: new Date(Date.now() + 60_000).toISOString(),
        matched_edge_ids: [edge.id], result: true, predicate_ref: edge.predicate_ref, safe_to_retry: values.safe_to_retry === true,
        source_fact_evidence_id: source.id, fact_digest: stableDigest(values), verification_provenance: "host_attested" } });
    const transitioned = service.procedureInvocationTransition({ ...args, transition_id: decisionId, edge_id: edge.id, evidence_id: evidenceId });
    const decision = service.store.create("procedure_host_decision", decisionId, { invocation_id: run.id, scope: run.scope, request_digest: requestDigest,
      node_id: node.id, edge_id: edge.id, evidence_id: evidenceId, fact_digest: stableDigest(values), status: "advanced", verification_provenance: "host_attested" });
    return { ...transitioned, decision, host_execution_authority: false };
  });
}
