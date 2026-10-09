import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { stableDigest } from "./digest.ts";
import { contextAssetKey } from "../common/craft-common-base/src/context-assets.ts";
import { scopeAccess, scopeAllows, scopeEnvelope, scopeFromKey } from "../common/craft-common-base/src/scope-policy.ts";

export type HostDiscoveryMode = "full_mcp" | "native_deferred";
export type GraphCandidatePort = { edit(args: JsonObject): JsonObject; inspect(args: JsonObject): JsonObject };
const graphConfigurationDigest = (config: JsonObject): string => stableDigest({ title: config.title ?? null, procedure_kind: config.procedure_kind ?? null, definition: config.definition ?? null, scenario_id: config.procedure_kind === "workflow" ? config.scenario_id ?? null : null });
const members = new Set(["codex", "claude", "skill_mcp", "dsh", "external"]);
function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a nonnegative integer`);
  return Number(value);
}
function ids(value: unknown, label: string, limit = 1000): string[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} must be a bounded list`);
  const values = value.map(item => text(item, label));
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
  return values;
}

/** Host observations are bound to existing Runtime records; they never execute or grade a task. */
export class ContextHostEvaluation {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  private publish(kind: string, id: string, payload: JsonObject): JsonObject {
    return this.store.transaction(() => this.store.find(kind, id) ?? this.store.create(kind, id, payload));
  }

  registerHost(args: JsonObject): JsonObject {
    const host = text(args.host, "host");
    if (!members.has(host)) throw new Error("Unsupported Host family");
    const mode = text(args.discovery_mode, "discovery_mode");
    if (mode !== "full_mcp" && mode !== "native_deferred") throw new Error("Unsupported discovery mode");
    const protocol = text(args.protocol_version, "protocol_version"), schema = text(args.tool_schema_digest, "tool_schema_digest");
    const definitionIds = ids(args.definition_ids, "definition_ids", 4096), initialIds = ids(args.initial_ids, "initial_ids", 4096);
    if (!initialIds.length || initialIds.some(id => !definitionIds.includes(id))) throw new Error("Initial tools must exist in full definitions");
    if (mode === "full_mcp" && initialIds.length !== definitionIds.length) throw new Error("Full MCP must register all definitions");
    if (mode === "native_deferred") {
      const evidence = this.store.get("evidence", text(args.conformance_evidence_id, "conformance_evidence_id"));
      const meta = object(evidence.metadata, "metadata");
      if (evidence.source_type !== "program" || evidence.confidence !== "confirmed" || meta.discovery_mode !== mode || meta.host_fingerprint !== args.host_fingerprint || meta.tool_schema_digest !== schema) throw new Error("Native deferred loading requires bound Host conformance evidence");
    }
    const payload = { host, host_id: text(args.host_id ?? host, "host_id"), discovery_mode: mode, protocol_version: protocol, tool_schema_digest: schema, definition_ids: definitionIds, initial_ids: initialIds,
      host_fingerprint: text(args.host_fingerprint, "host_fingerprint"), model_fingerprint: text(args.model_fingerprint, "model_fingerprint"),
      capabilities: { hook: args.hook === true, precise_tokens: args.precise_tokens === true, native_deferred: mode === "native_deferred" }, conformance_evidence_id: args.conformance_evidence_id ?? null, verification: "declared", real_session_verified: false };
    return this.publish("context_host_contract", `host_contract_${stableDigest(payload).slice(-24)}`, payload);
  }

  matrix(): JsonObject {
    return { families: [...members], contracts: this.store.list("context_host_contract", 1000), unspecified_capabilities: "unknown", model_effect_proven: false };
  }

  recordEmission(args: JsonObject): JsonObject {
    const contract = this.store.get("context_host_contract", text(args.contract_id, "contract_id"));
    const run = this.store.get("task_run", text(args.task_run_id, "task_run_id"));
    const launchIdentity = object(run.launch_identity, "TaskRun.launch_identity");
    const launch = this.store.get("work_launch", text(run.launch_id, "TaskRun.launch_id"));
    const control = this.store.get("task_control_contract", text(run.contract_id, "TaskRun.contract_id"));
    const task = this.store.get("task", text(launch.task_id, "WorkLaunch.task_id"));
    if (control.status !== "active" || control.version !== run.contract_version || control.launch_id !== launch.id || control.task_id !== task.id || launchIdentity.task_id !== task.id || launchIdentity.host !== launch.host || launchIdentity.dispatch_id !== launch.dispatch_id || launchIdentity.workspace !== launch.workspace || control.workspace !== launch.workspace || launchIdentity.prompt_digest !== launch.prompt_digest) throw new Error("TaskRun launch/control binding changed");
    const receipt = this.store.get("context_pack_receipt", text(args.receipt_id, "receipt_id"));
    const workingSet = this.store.get("context_working_set_receipt", text(receipt.working_set_id, "Pack working_set_id"));
    const session = this.store.get("host_session", text(args.host_session_id, "host_session_id"));
    if (session.task_id !== task.id || session.host_id !== launch.host || session.host_id !== args.host_id || session.host_id !== contract.host_id || session.model_fingerprint !== contract.model_fingerprint || session.capability_fingerprint !== contract.tool_schema_digest) throw new Error("Host session or schema binding mismatch");
    const scope = object(receipt.scope, "receipt.scope");
    if (`${scope.kind}:${scope.id}` !== args.scope || !((scope.kind === "project" && scope.id === task.project_id) || (scope.kind === "task" && scope.id === task.id))) throw new Error("Emission scope mismatch");
    if (workingSet.task_id !== task.id || workingSet.session_id !== session.id) throw new Error("Context Working Set task/session binding mismatch");
    if (stableDigest(workingSet.scope) !== stableDigest(scope) || stableDigest(workingSet.asset_refs) !== stableDigest(receipt.asset_refs)) throw new Error("Context Pack/Working Set material binding mismatch");
    const emitted = ids(args.emitted_refs, "emitted_refs"), available = ids(args.available_refs, "available_refs");
    const packRefs = (receipt.asset_refs as JsonObject[]).map(contextAssetKey);
    if (stableDigest([...available].sort()) !== stableDigest(packRefs.sort()) || emitted.some(ref => !available.includes(ref)) || stableDigest(available) !== args.available_refs_digest) throw new Error("Emission references mismatch");
    const fields = ["injected_tokens", "schema_tokens", "history_tokens", "latency_ms"];
    const metrics = Object.fromEntries(fields.map(field => [field, count(args[field], field)]));
    let cost: number | null = null;
    if (args.cost_usd !== undefined) {
      if (typeof args.cost_usd !== "number" || !Number.isFinite(args.cost_usd) || args.cost_usd < 0) throw new Error("Invalid measured cost");
      cost = args.cost_usd;
    }
    const payload = { contract_id: contract.id, task_run_id: run.id, receipt_id: receipt.id, receipt_digest: receipt.identity_digest, host_session_id: session.id,
      scope: args.scope, task_id: task.id, launch_id: launch.id, task_control_contract_id: control.id, working_set_id: workingSet.id, emitted_refs: emitted, available_refs_digest: args.available_refs_digest, emission_digest: text(args.emission_digest, "emission_digest"),
      actual_model_use: "unknown", emission_content_verification: "host_reported_digest_only", metrics: { ...metrics, cost_usd: cost }, provenance: "host_reported", precise_tokens: (contract.capabilities as JsonObject).precise_tokens === true, model_effect_proven: false };
    const pending = this.store.find("context_host_observation_pending", String(run.id));
    if (pending && pending.contract_id !== contract.id) throw new Error("Pending Host observation contract mismatch");
    const emission = this.publish("context_host_emission", `emission_${stableDigest(payload).slice(-24)}`, payload);
    if (pending) this.store.save("context_host_observation_pending", String(run.id), { status: "recorded", contract_id: contract.id, emission_id: emission.id });
    return emission;
  }

  evaluateKnowledge(args: JsonObject): JsonObject {
    const emission = this.store.get("context_host_emission", text(args.emission_id, "emission_id"));
    const expected = ids(args.expected_relevant_refs, "expected_relevant_refs"), retrieved = ids(args.retrieved_refs, "retrieved_refs");
    if (retrieved.some(ref => !(emission.emitted_refs as string[]).includes(ref))) throw new Error("Knowledge evaluation must use emitted references");
    const judgements = args.citation_judgements;
    if (!Array.isArray(judgements) || judgements.length > 1000) throw new Error("Citation judgements must be bounded");
    const citations = judgements.map(raw => {
      const judgement = object(raw, "citation judgement"), ref = text(judgement.ref, "ref");
      if (!retrieved.includes(ref) || typeof judgement.supported !== "boolean") throw new Error("Citation judgement invalid");
      const evidence = this.store.get("evidence", text(judgement.evidence_id, "evidence_id")), meta = object(evidence.metadata, "evidence.metadata");
      if (evidence.confidence !== "confirmed" || !["program", "human"].includes(String(evidence.source_type)) || meta.emission_id !== emission.id || meta.claim_digest !== judgement.claim_digest || meta.reference !== ref || meta.supported !== judgement.supported) throw new Error("Citation support evidence binding mismatch");
      if (evidence.source_type === "human") text(meta.reviewer, "Evidence reviewer");
      return { ref, claim_digest: text(judgement.claim_digest, "claim_digest"), supported: judgement.supported, evidence_id: evidence.id, judge_origin: evidence.source_type };
    });
    const correct = retrieved.filter(ref => expected.includes(ref)).length;
    return this.publish("context_knowledge_assessment", `knowledge_assessment_${stableDigest({ args, emission: emission.id }).slice(-24)}`, {
      emission_id: emission.id, expected_relevant_refs: expected, retrieved_refs: retrieved,
      retrieval: { recall: expected.length ? correct / expected.length : Number(!retrieved.length), precision: retrieved.length ? correct / retrieved.length : Number(!expected.length) },
      citations, support: { checked: citations.length, supported: citations.filter(citation => citation.supported).length, accuracy: citations.length ? citations.filter(citation => citation.supported).length / citations.length : null },
      support_basis: "bound_evidence_attestation", judge_calibration: "unknown", support_truth_proven: false, changes_claim_status: false, model_effect_proven: false });
  }

  proposeGraphImprovement(args: JsonObject): JsonObject {
    const outcome = this.store.get("procedure_invocation_outcome", text(args.outcome_id, "outcome_id"));
    if (outcome.scope !== args.scope || !["failed", "blocked", "inconclusive"].includes(String(outcome.status))) throw new Error("Improvement requires a scoped non-success outcome");
    const receipt = this.store.get("procedure_invocation_receipt", String(outcome.receipt_id));
    if (receipt.invocation_id !== outcome.invocation_id || !outcome.failure_stage) throw new Error("Outcome receipt binding mismatch");
    const graph = this.store.get("experience_procedure", String(outcome.procedure_id));
    if (graph.scope !== outcome.scope || !scopeAllows(scopeEnvelope(graph.scope_envelope, scopeFromKey(String(graph.scope))), scopeAccess(args))) throw new Error("Graph improvement audience denied");
    if (args.graph_id !== undefined && args.graph_id !== graph.id) throw new Error("Graph improvement target mismatch");
    const payload = { scope: outcome.scope, procedure_id: outcome.procedure_id, procedure_version: outcome.procedure_version, definition_digest: outcome.definition_digest,
      invocation_id: outcome.invocation_id, outcome_id: outcome.id, receipt_id: receipt.id, node_path: outcome.call_path, failure_stage: outcome.failure_stage,
      public_output_refs: receipt.output_refs, evidence_ids: outcome.evidence_ids, proposal_digest: stableDigest(object(args.configuration, "configuration")), configuration: args.configuration,
      status: "pending_review", attribution: "observed_failure_location_not_proven_root_cause", execution_authorized: false, promotion_automatic: false };
    return this.publish("experience_improvement_proposal", `improvement_${stableDigest(payload).slice(-24)}`, payload);
  }

  submitGraphImprovement(args: JsonObject, graphs: GraphCandidatePort): JsonObject {
    const proposal = this.store.get("experience_improvement_proposal", text(args.proposal_id, "proposal_id"));
    if (proposal.scope !== args.scope || proposal.status !== "pending_review" || args.expected_proposal_digest !== proposal.proposal_digest) throw new Error("Improvement proposal scope or digest mismatch");
    text(args.reviewer, "reviewer");
    const action = args.action ?? "save";
    if (action !== "save" && action !== "submit") throw new Error("Unsupported improvement action");
    if (action === "submit") {
      text(args.expected_draft_digest, "expected_draft_digest");
      const read = graphs.inspect({ ...args, action: "draft", graph_id: proposal.procedure_id });
      if (read.draft_digest !== args.expected_draft_digest || graphConfigurationDigest(object(read.draft, "draft")) !== graphConfigurationDigest(object(proposal.configuration, "configuration"))) throw new Error("Improvement draft no longer matches reviewed proposal");
    }
    const result = graphs.edit({ ...args, action, graph_id: proposal.procedure_id, configuration: proposal.configuration });
    return { proposal_id: proposal.id, draft: result, status: action === "save" ? "draft_saved" : "candidate_submitted", submission_requires_draft_review: action === "save", promotion_automatic: false };
  }

  evaluateGraphApplicability(args: JsonObject, inspect: (args: JsonObject) => JsonObject): JsonObject {
    if (!Array.isArray(args.cases) || !args.cases.length || args.cases.length > 100) throw new Error("Applicability cases must contain 1..100 cases");
    const observations = args.cases.map(raw => {
      const item = object(raw, "case");
      const matched = inspect({ ...args, action: "match", query: text(item.query, "query"), input_keys: item.input_keys });
      const routes = matched.routes as JsonObject[];
      return { ...item, actual_applicable: routes.some(route => route.subscenario_id === item.scenario_id && route.ready_to_plan === true), definition_digest: matched.definition_digest, procedure_version: matched.procedure_version };
    });
    return { ...this.evaluateApplicability({ cases: observations }), observations, provenance: "runtime_graph_match", routing_only: true };
  }

  evaluateApplicability(args: JsonObject): JsonObject {
    const cases = args.cases;
    if (!Array.isArray(cases) || !cases.length || cases.length > 100) throw new Error("Applicability cases must contain 1..100 cases");
    const rows = cases.map(raw => {
      const item = object(raw, "case"), expected = item.expected_applicable, actual = item.actual_applicable;
      if (typeof expected !== "boolean" || typeof actual !== "boolean") throw new Error("Applicability labels must be boolean");
      return { scenario_id: text(item.scenario_id, "scenario_id"), host_fingerprint: text(item.host_fingerprint, "host_fingerprint"), model_fingerprint: text(item.model_fingerprint, "model_fingerprint"), expected_applicable: expected, actual_applicable: actual, correct: actual === expected };
    });
    return { cases: rows, applicability_accuracy: rows.filter(row => row.correct).length / rows.length, out_of_scope_count: rows.filter(row => !row.expected_applicable).length,
      false_activation_count: rows.filter(row => !row.expected_applicable && row.actual_applicable).length, provenance: "labelled_routing_observations", task_outcome_proven: false, promotion_automatic: false };
  }
}
