import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { stableDigest, payload } from "./digest.ts";
import { sessionStorageScopeId } from "../common/craft-common-store-local/src/paths.ts";
import { EvolutionCandidateWorkspace } from "./evolution-candidate-workspace.ts";
import { assessKnowledgeEvaluationProvenance, knowledgeClaimPromotionProofVerified, knowledgeEvaluationAdjudicationVerified, knowledgeEvaluationEvidence } from "./knowledge-evaluation-provenance.ts";
import { MemoryLedgerKernel } from "../capability/craft-memory/memory-ledger.ts";
import { activeProcedure } from "../capability/craft-experience/procedure-release.ts";
import { WorkspaceState } from "./workspace.ts";

const STAGES = new Set(["observe", "retrieve", "act", "feedback", "attribute", "candidate", "evaluate", "promote", "reject", "rollback", "replan"]);
const OUTCOMES = new Set(["passed", "failed", "blocked", "inconclusive", "cancelled"]);
const NEXT: Record<string, Set<string>> = {
  observe: new Set(["retrieve"]), retrieve: new Set(["act"]), act: new Set(["feedback"]), feedback: new Set(["attribute"]),
  attribute: new Set(["candidate", "evaluate", "replan"]), candidate: new Set(["evaluate"]), evaluate: new Set(["promote", "reject", "rollback"]),
  promote: new Set(["replan"]), reject: new Set(["replan"]), rollback: new Set(["replan"]), replan: new Set(["observe"]),
};
const FAILURE_CLASSES = new Set(["environment", "retrieval_or_routing", "execution", "missing_process", "evaluation"]);

function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function ref(store: CraftStore, raw: unknown, name: string): JsonObject {
  const input = object(raw, name), kind = text(input.kind, `${name}.kind`), id = text(input.id, `${name}.id`);
  const version = input.version === undefined ? undefined : Number(input.version);
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new Error(`${name}.version must be a positive integer`);
  const record = store.get(kind, id, version);
  return { kind, id: record.id, version: record.version };
}
function refs(store: CraftStore, value: unknown, name: string): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new Error(`${name} must be an array of at most 50 references`);
  const result = value.map((item, index) => ref(store, item, `${name}[${index}]`));
  const ids = result.map(item => `${item.kind}:${item.id}:${item.version}`);
  if (new Set(ids).size !== ids.length) throw new Error(`${name} must contain unique references`);
  return result.sort((a, b) => `${a.kind}:${a.id}:${a.version}`.localeCompare(`${b.kind}:${b.id}:${b.version}`));
}
function metrics(raw: unknown): JsonObject {
  const value = raw === undefined ? {} : object(raw, "metrics");
  const result: JsonObject = { input_tokens: null, output_tokens: null, duration_ms: null, cost_usd: null };
  for (const key of ["input_tokens", "output_tokens", "duration_ms", "cost_usd"] as const) {
    if (value[key] === undefined || value[key] === null) continue;
    const number = Number(value[key]);
    if (!Number.isFinite(number) || number < 0 || ((key === "input_tokens" || key === "output_tokens") && !Number.isSafeInteger(number)))
      throw new Error(`metrics.${key} must be non-negative${key.endsWith("tokens") ? " integer" : " finite"}`);
    result[key] = number;
  }
  return result;
}
function traceMetrics(store: CraftStore, cycle: JsonObject, traceRefs: JsonObject[]): JsonObject {
  const totals: JsonObject = { input_tokens: null, output_tokens: null, duration_ms: null, cost_usd: null };
  const seen = new Set<string>();
  for (const reference of traceRefs) {
    if (reference.kind !== "trace_event") throw new Error("trace_refs must reference trace_event records");
    const event = store.get("trace_event", String(reference.id), Number(reference.version));
    if (event.trust !== "observed" && event.trust !== "verified") throw new Error("Evolution Cycle metrics require observed Trace events");
    const trace = store.get("trace", text(event.trace_id, "trace_event.trace_id"));
    if (trace.task_id !== (cycle.task_ref as JsonObject).id) throw new Error("Evolution Cycle metrics Trace belongs to another task");
    if (trace.id !== cycle.session_trace_id) throw new Error("Evolution Cycle metrics Trace must belong to its Host Session");
    const usage = event.usage === null || event.usage === undefined ? {} : object(event.usage, "trace_event.usage");
    for (const key of ["input_tokens", "output_tokens", "duration_ms", "cost_usd"] as const) {
      const value = key === "duration_ms" || key === "cost_usd" ? event[key] : usage[key];
      if (value === null || value === undefined) continue;
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || ((key === "input_tokens" || key === "output_tokens") && !Number.isSafeInteger(number)))
        throw new Error(`trace_event.${key} must be a non-negative${key.endsWith("tokens") ? " integer" : " finite number"}`);
      totals[key] = Number(totals[key] ?? 0) + number;
      if (!Number.isFinite(totals[key]) || ((key === "input_tokens" || key === "output_tokens") && !Number.isSafeInteger(totals[key])))
        throw new Error(`trace_refs ${key} total exceeds its numeric range`);
      seen.add(key);
    }
  }
  for (const key of ["input_tokens", "output_tokens", "duration_ms", "cost_usd"] as const) if (!seen.has(key)) totals[key] = null;
  return totals;
}
function hasMeasuredMetrics(value: JsonObject): boolean {
  return ["input_tokens", "output_tokens", "duration_ms", "cost_usd"].some(key => typeof value[key] === "number");
}
function candidateSourceIdentities(store: CraftStore, cycle: JsonObject): { taskIds: Set<string>; sessionIds: Set<string> } {
  const history = store.events(`evolution:${cycle.id}`);
  const candidateEvent = [...history].reverse().map(event => event.payload as JsonObject | undefined)
    .find(event => event?.stage === "candidate");
  const taskIds = new Set<string>(), sessionIds = new Set<string>();
  for (const reference of (candidateEvent?.evidence_refs as JsonObject[] | undefined) ?? []) {
    const evidence = store.get("evidence", String(reference.id), Number(reference.version));
    const metadata = evidence.metadata === undefined ? {} : object(evidence.metadata, "evidence.metadata");
    const taskId = metadata.source_task_id ?? metadata.task_id;
    if (typeof taskId === "string" && taskId.length) taskIds.add(taskId);
    if (typeof metadata.source_session_id === "string" && metadata.source_session_id.length) sessionIds.add(metadata.source_session_id);
  }
  return { taskIds, sessionIds };
}
function assertHeldOutEvaluation(store: CraftStore, cycle: JsonObject, artifactRefs: JsonObject[], evaluationRefs: JsonObject[]): boolean {
  if (artifactRefs.length !== 1 || evaluationRefs.length !== 1) throw new Error("Evaluation must bind one exact candidate and one held-out run");
  const candidate = artifactRefs[0]!, evaluationRef = evaluationRefs[0]!;
  if (evaluationRef.kind === "evaluation_run") {
    const evaluation = store.get("evaluation_run", String(evaluationRef.id), Number(evaluationRef.version));
    if (evaluation.split !== "held_out" || evaluation.subject_type !== candidate.kind || evaluation.subject_id !== candidate.id
      || Number(evaluation.subject_version) !== Number(candidate.version) || !["passed", "failed"].includes(String(evaluation.verdict)))
      throw new Error("Evaluation must be an observed held-out run for the exact candidate version");
    const trials = Array.isArray(evaluation.trial_ids) ? evaluation.trial_ids as string[] : [];
    if (!trials.length) throw new Error("Held-out evaluation requires independently sourced trials");
    const candidateSources = candidateSourceIdentities(store, cycle);
    let allTrialsPassed = true;
    for (const trialId of trials) {
      const trial = store.get("trial", trialId), task = store.get("task", String(trial.task_id));
      if (trial.subject_type !== candidate.kind || trial.subject_id !== candidate.id || Number(trial.subject_version) !== Number(candidate.version))
        throw new Error("Held-out trial must bind the exact candidate version");
      const sessionId = task.host_session_id ?? task.session_id ?? task.source_session_id;
      if (task.id === (cycle.task_ref as JsonObject).id || typeof sessionId !== "string" || sessionId === cycle.session_id)
        throw new Error("Held-out evaluation requires an independent task and Host session");
      if (candidateSources.taskIds.has(String(task.id)) || candidateSources.sessionIds.has(sessionId))
        throw new Error("Held-out evaluation source overlaps the candidate-generation evidence");
      const session = store.get("host_session", sessionId);
      if (session.task_id !== task.id || session.status !== "terminal" || session.raw_content_stored === true)
        throw new Error("Held-out evaluation requires a terminal content-free Host Session bound to its task");
      const sessionTrace = store.get("trace", text(session.trace_id, "host_session.trace_id"));
      if (sessionTrace.task_id !== task.id) throw new Error("Held-out evaluation Host Session Trace belongs to another task");
      const outcome = store.find("outcome", `outcome_${trial.id}`);
      if (!outcome || !["passed", "failed"].includes(String(outcome.verdict))) throw new Error("Held-out trial requires an observed terminal outcome");
      if (outcome.verdict !== "passed") allTrialsPassed = false;
    }
    return evaluation.verdict === "passed" && allTrialsPassed;
  }
  if (evaluationRef.kind === "knowledge_evaluation_run" && candidate.kind === "knowledge_claim") {
    const evaluation = store.get("knowledge_evaluation_run", String(evaluationRef.id), Number(evaluationRef.version));
    const cases = Array.isArray(evaluation.case_refs) ? evaluation.case_refs as JsonObject[] : [];
    const candidates = Array.isArray(evaluation.candidate_claim_refs) ? evaluation.candidate_claim_refs as JsonObject[] : [];
    const results = Array.isArray(evaluation.results) ? evaluation.results as JsonObject[] : [];
    const candidateSources = candidateSourceIdentities(store, cycle);
    if (evaluation.mode !== "candidate_shadow" || !["eligible", "insufficient"].includes(String(evaluation.status))
      || (evaluation.metrics as JsonObject | undefined)?.provenance_eligible !== true
      || !cases.length || !candidates.some(item => item.claim_id === candidate.id && Number(item.claim_version) === Number(candidate.version)))
      throw new Error("Knowledge evaluation must bind the exact candidate and held-out cases");
    for (const caseRef of cases) {
      const testCase = store.get("knowledge_evaluation_case", String(caseRef.case_id), Number(caseRef.case_version));
      const result = results.find(item => item.case_id === testCase.id);
      const provenance = knowledgeEvaluationEvidence(store, testCase);
      const independentlyVerified = assessKnowledgeEvaluationProvenance(testCase, provenance.sourceEvidence, provenance.claimEvidence,
        knowledgeEvaluationAdjudicationVerified(store, testCase));
      if (testCase.dataset_partition !== "held_out" || testCase.evaluation_channel !== "real_session" || testCase.sanitized !== true
        || typeof testCase.source_task_id !== "string" || testCase.source_task_id === (cycle.task_ref as JsonObject).id
        || typeof testCase.source_session_id !== "string" || testCase.source_session_id === cycle.session_id
        || candidateSources.taskIds.has(String(testCase.source_task_id)) || candidateSources.sessionIds.has(String(testCase.source_session_id))
        || !result || result.evaluation_eligible !== true || result.provenance_status !== "verified_independent"
        || !independentlyVerified.evaluation_eligible || caseRef.identity_digest !== testCase.identity_digest)
        throw new Error("Knowledge held-out case must have independent real-session provenance");
    }
    return evaluation.status === "eligible";
  }
  throw new Error("Evaluation reference type is unsupported for independent held-out verification");
}
function assertPromotionAuthority(store: CraftStore, cycle: JsonObject, candidateRefs: JsonObject[], authorityRefs: JsonObject[]): void {
  const candidate = candidateRefs[0]!;
  if (candidate.kind === "experience_procedure") {
    const releaseRef = authorityRefs.find(reference => reference.kind === "experience_release" && reference.id === candidate.id);
    const release = releaseRef ? store.get("experience_release", String(releaseRef.id), Number(releaseRef.version)) : null;
    const procedure = release ? activeProcedure(store, String(candidate.id)) : null;
    if (!release || release.status !== "active" || Number(release.record_version) !== Number(candidate.version)
      || Number(procedure?.version) !== Number(candidate.version) || release.definition_digest !== procedure?.definition_digest
      || procedure?.scope !== `project:${cycle.project_scope_id}`)
      throw new Error("Experience candidate has no active release for the evaluated revision");
    return;
  }
  if (candidate.kind === "memory_ledger") {
    const memoryRef = authorityRefs.find(reference => reference.kind === "memory_ledger" && reference.id === candidate.id
      && Number(reference.version) === Number(candidate.version));
    const memory = memoryRef ? store.get("memory_ledger", String(memoryRef.id), Number(memoryRef.version)) : null;
    const scope = memory?.scope as JsonObject | undefined;
    if (!memory || memory.status !== "active" || Number(store.get("memory_ledger", String(candidate.id)).version) !== Number(candidate.version)
      || scope?.kind !== "project" || scope.id !== cycle.project_scope_id)
      throw new Error("Memory candidate is not an active project promotion for this Evolution Cycle");
    const supportRefs = memory.promotion_support_refs;
    if (!Array.isArray(supportRefs) || supportRefs.length < 2 || !new MemoryLedgerKernel(store).promotionSupported(memory))
      throw new Error("Memory candidate has no verified automatic promotion support");
    return;
  }
  if (candidate.kind === "codebase_index") {
    const indexRef = authorityRefs.find(reference => reference.kind === "codebase_index" && reference.id === candidate.id
      && Number(reference.version) === Number(candidate.version));
    const index = indexRef ? store.get("codebase_index", String(indexRef.id), Number(indexRef.version)) : null;
    if (!index || index.status !== "ready" || Number(store.get("codebase_index", String(candidate.id)).version) !== Number(candidate.version))
      throw new Error("Codebase index is not a ready artifact for this Evolution Cycle");
    const snapshot = cycle.snapshot as JsonObject;
    const workspace = store.get("workspace", String(snapshot.workspace_id));
    if (index.workspace_id !== snapshot.workspace_id || index.checkpoint_id !== snapshot.checkpoint_id
      || workspace.latest_checkpoint_id !== snapshot.checkpoint_id)
      throw new Error("Codebase index does not match the evaluated project snapshot");
    const identity = { workspace_id: index.workspace_id, checkpoint_id: index.checkpoint_id, snapshot_digest: index.snapshot_digest, analyzer: index.analyzer };
    if (index.identity_digest !== stableDigest(identity)) throw new Error("Codebase index identity digest is invalid");
    return;
  }
  if (candidate.kind !== "knowledge_claim") throw new Error(`Promotion verifier is unavailable for candidate kind: ${candidate.kind}`);
  const promotion = authorityRefs.flatMap(reference => {
    if (reference.kind !== "knowledge_auto_review") return [];
    const record = store.get("knowledge_auto_review", String(reference.id), Number(reference.version));
    return record.claim_id === candidate.id && Number(record.claim_version) === Number(candidate.version)
      && record.verdict === "eligible" ? [record] : [];
  }).find(record => true);
  if (!promotion) throw new Error("Promotion authority must bind the exact candidate version and an eligible Knowledge review");
  const reviewed = store.get("knowledge_claim", String(candidate.id));
  const review = reviewed.review as JsonObject | undefined;
  if (reviewed.status !== "reviewed" || Number(reviewed.version) <= Number(candidate.version)
    || review?.promotion_review_id !== promotion.id || !knowledgeClaimPromotionProofVerified(store, reviewed))
    throw new Error("Knowledge candidate has no verified formal promotion for the evaluated revision");
}

function verifiedEvents(events: JsonObject[], cycle: JsonObject): JsonObject[] {
  let previous: string | null = null;
  for (const [index, stored] of events.entries()) {
    const event = stored.payload as JsonObject | undefined;
    if (!event || event.sequence !== index + 1 || event.cycle_id !== cycle.id || event.event_id !== `${cycle.id}:${index + 1}`
      || event.previous_event_digest !== previous) throw new Error("Evolution Cycle event chain is invalid");
    const { event_digest: eventDigest, ...body } = event;
    if (typeof eventDigest !== "string" || stableDigest(body) !== eventDigest) throw new Error("Evolution Cycle event digest is invalid");
    previous = eventDigest;
  }
  if (events.length !== Number(cycle.sequence) || cycle.last_event_digest !== previous) throw new Error("Evolution Cycle head does not match its append-only event chain");
  return events;
}

/** Shared, append-only control record. Capability-specific gates retain promotion authority. */
export class EvolutionCycleKernel {
  readonly store: CraftStore;
  readonly candidateWorkspaces: EvolutionCandidateWorkspace;
  readonly workspaceState: WorkspaceState;
  constructor(store: CraftStore) { this.store = store; this.candidateWorkspaces = new EvolutionCandidateWorkspace(store, store.paths); this.workspaceState = new WorkspaceState(store, store.paths); }

  start(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id"));
    const host = text(args.session_host, "session_host");
    const sessionId = text(args.session_id, "session_id");
    const session = this.store.get("host_session", sessionId);
    if (session.host_id !== host || session.status !== "running" || session.raw_content_stored === true)
      throw new Error("Evolution Cycle requires the matching live Host Session");
    const sessionTrace = this.store.get("trace", text(session.trace_id, "host_session.trace_id"));
    if (sessionTrace.task_id !== task.id) throw new Error("Evolution Cycle Host Session Trace belongs to another task");
    const sessionScope = sessionStorageScopeId(host, sessionId);
    const workspace = this.store.get("workspace", text(args.workspace_id, "workspace_id"));
    const checkpoint = this.store.get("workspace_checkpoint", text(args.checkpoint_id, "checkpoint_id"));
    if (checkpoint.workspace_id !== workspace.id || workspace.latest_checkpoint_id !== checkpoint.id)
      throw new Error("Evolution Cycle requires the latest checkpoint for its workspace");
    const root = realpathSync(text(workspace.root_path, "workspace.root_path"));
    const projectScopeId = text(args.project_scope_id, "project_scope_id");
    const identity = this.store.get("project_identity", projectScopeId);
    const identityScope = identity.canonical_scope as JsonObject | undefined;
    if (identityScope?.kind !== "project" || identityScope.id !== projectScopeId || typeof identity.local_path_alias !== "string"
      || realpathSync(identity.local_path_alias) !== root) throw new Error("Evolution Cycle project identity does not match the workspace root");
    const repository = object(checkpoint.repository_state, "checkpoint.repository_state");
    for (const key of ["root", "branch", "revision", "working_tree_digest"] as const) if (typeof repository[key] !== "string" || !String(repository[key]).length)
      throw new Error(`checkpoint.repository_state.${key} is required`);
    if (realpathSync(String(repository.root)) !== root || !/^[a-f0-9]{64}$/u.test(String(repository.working_tree_digest)))
      throw new Error("Evolution Cycle checkpoint repository identity is invalid");
    const entries = Array.isArray(checkpoint.entries) ? checkpoint.entries as JsonObject[] : null;
    if (!entries || entries.some(entry => typeof entry.path !== "string" || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/u.test(entry.digest)))
      throw new Error("Evolution Cycle checkpoint entries are invalid");
    const freshness = this.workspaceState.freshness({ workspace_id: workspace.id });
    if (freshness.status !== "current") throw new Error("Evolution Cycle requires a checkpoint matching the current project working tree");
    const snapshot: JsonObject = { workspace_id: workspace.id, workspace_version: workspace.version, checkpoint_id: checkpoint.id, checkpoint_version: checkpoint.version,
      project_path_digest: digest(root), branch: repository.branch, revision: repository.revision, working_tree_digest: repository.working_tree_digest,
      source_digest: digest([...entries].map(entry => [entry.path, entry.digest]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))) };
    const trigger = text(args.trigger, "trigger");
    const triggerRefs = refs(this.store, args.trigger_refs, "trigger_refs");
    if (!triggerRefs.length) throw new Error("trigger_refs must contain a versioned task result or Host event");
    const cycleId = text(args.cycle_id ?? `evolution_cycle_${randomUUID().replaceAll("-", "")}`, "cycle_id");
    const candidateId = `candidate_${stableDigest({ cycle_id: cycleId, workspace_id: workspace.id, checkpoint_id: checkpoint.id, checkpoint_version: checkpoint.version }).slice(-32)}`;
    const candidateWorkspace = this.candidateWorkspaces.create({ workspace_id: workspace.id, checkpoint_id: checkpoint.id,
      checkpoint_version: checkpoint.version, candidate_id: candidateId });
    const allowedPaths = args.allowed_paths ?? [];
    this.candidateWorkspaces.validateChanges({ workspace_id: workspace.id, checkpoint_id: checkpoint.id,
      checkpoint_version: checkpoint.version, candidate_id: candidateId, allowed_paths: allowedPaths });
    snapshot.candidate_workspace_id = candidateId;
    snapshot.candidate_workspace_digest = (candidateWorkspace.manifest as JsonObject).source_digest;
    snapshot.candidate_allowed_paths = allowedPaths;
    const identityValue = { task_ref: { id: task.id, version: task.version }, project_scope_id: projectScopeId,
      scope: { kind: "project", id: projectScopeId },
      session_host: host, session_id: sessionId, session_trace_id: sessionTrace.id, session_scope_id: sessionScope, session_identity_digest: session.identity_digest,
      snapshot, trigger, trigger_refs: triggerRefs };
    const identityDigest = stableDigest(identityValue), existing = this.store.find("evolution_cycle", cycleId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Evolution Cycle idempotency conflict");
      return { cycle: existing, events: verifiedEvents(this.store.events(`evolution:${cycleId}`), existing), candidate_workspace: candidateWorkspace, idempotent: true };
    }
    return this.store.transaction(() => {
      const current = this.store.find("evolution_cycle", cycleId);
      if (current) {
        if (current.identity_digest !== identityDigest) throw new Error("Evolution Cycle idempotency conflict");
        return { cycle: current, events: verifiedEvents(this.store.events(`evolution:${cycleId}`), current), candidate_workspace: candidateWorkspace, idempotent: true };
      }
      const eventBody = { event_id: `${cycleId}:1`, cycle_id: cycleId, sequence: 1, previous_event_digest: null, from_stage: null, stage: "observe",
        evidence_refs: [], artifact_refs: [], evaluation_refs: [], authority_refs: [], trace_refs: [], outcome: null, metrics: metrics(undefined), metrics_source: "unavailable", trigger_refs: triggerRefs, snapshot_digest: stableDigest(snapshot) };
      const event = { ...eventBody, event_digest: stableDigest(eventBody) };
      const cycle = this.store.create("evolution_cycle", cycleId, { ...identityValue, identity_digest: identityDigest, snapshot, snapshot_digest: stableDigest(snapshot),
        stage: "observe", status: "active", sequence: 1, candidate_refs: [], evaluation_refs: [], outcome: null, last_event_digest: event.event_digest });
      this.store.appendEvent(`evolution:${cycleId}`, "observe", event);
      return { cycle, events: verifiedEvents(this.store.events(`evolution:${cycleId}`), cycle), candidate_workspace: candidateWorkspace, idempotent: false };
    });
  }

  advance(args: JsonObject): JsonObject {
    const cycleId = text(args.cycle_id, "cycle_id"), transitionId = text(args.transition_id, "transition_id");
    const requestedVersion = Number(args.expected_version);
    if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1) throw new Error("expected_version must be a positive integer");
    const stage = text(args.stage, "stage");
    if (!STAGES.has(stage)) throw new Error("Evolution Cycle stage is unsupported");
    const cycle = this.store.get("evolution_cycle", cycleId);
    const evidenceRefs = refs(this.store, args.evidence_refs, "evidence_refs"), artifactRefs = refs(this.store, args.artifact_refs, "artifact_refs");
    const evaluationRefs = refs(this.store, args.evaluation_refs, "evaluation_refs"), authorityRefs = refs(this.store, args.authority_refs, "authority_refs");
    const traceRefs = refs(this.store, args.trace_refs, "trace_refs"), reportedMetrics = metrics(args.metrics);
    if (traceRefs.length && hasMeasuredMetrics(reportedMetrics)) throw new Error("Supply measured metrics through trace_refs or caller metrics, not both");
    const metricsValue = traceRefs.length ? traceMetrics(this.store, cycle, traceRefs) : reportedMetrics;
    const metricsSource = traceRefs.length ? "trace_event" : hasMeasuredMetrics(reportedMetrics) ? "caller_reported" : "unavailable";
    const failureClass = args.failure_class === undefined ? null : text(args.failure_class, "failure_class");
    if (failureClass !== null && !FAILURE_CLASSES.has(failureClass)) throw new Error("Evolution Cycle failure_class is unsupported");
    const outcome = args.outcome === undefined || args.outcome === null ? null : text(args.outcome, "outcome");
    if (outcome !== null && !OUTCOMES.has(outcome)) throw new Error("Evolution Cycle outcome is unsupported");
    if (stage === "feedback" && outcome === null) throw new Error("Feedback requires a terminal outcome");
    if (stage !== "feedback" && outcome !== null) throw new Error("outcome is only valid for the feedback stage");
    const terminal = args.terminal === true;
    const eventIdentity = { transition_id: transitionId, stage, evidence_refs: evidenceRefs, artifact_refs: artifactRefs, evaluation_refs: evaluationRefs,
      authority_refs: authorityRefs, trace_refs: traceRefs, failure_class: failureClass, outcome, metrics: metricsValue, metrics_source: metricsSource,
      reason_digest: args.reason === undefined ? null : digest(text(args.reason, "reason")), terminal };
    const requestDigest = stableDigest(eventIdentity);
    const history = verifiedEvents(this.store.events(`evolution:${cycleId}`), cycle);
    const priorEvent = history.find(event => (event.payload as JsonObject | undefined)?.transition_id === transitionId);
    if (priorEvent) {
      if ((priorEvent.payload as JsonObject).request_digest !== requestDigest) throw new Error("Evolution Cycle transition idempotency conflict");
      return { cycle, event: priorEvent, idempotent: true };
    }
    if (cycle.status !== "active") throw new Error("Evolution Cycle is terminal");
    if (Number(cycle.version) !== requestedVersion) throw new Error("Evolution Cycle version conflict; reread before advancing");
    this.assertSessionForStage(cycle, stage);
    if (!NEXT[String(cycle.stage)]?.has(stage)) throw new Error(`Invalid Evolution Cycle transition: ${cycle.stage} -> ${stage}`);
    if (stage === "attribute") {
      const failedOutcome = cycle.outcome !== "passed";
      if (failedOutcome && failureClass === null) throw new Error("Failed outcome attribution requires a failure_class");
      if (!failedOutcome && failureClass !== null) throw new Error("Passed outcome attribution must not include a failure_class");
    }
    if (stage === "candidate" && (!artifactRefs.length || !evidenceRefs.length)) throw new Error("Candidate requires versioned artifact and evidence references");
    if (stage === "candidate" && evidenceRefs.some(reference => reference.kind !== "evidence"))
      throw new Error("Candidate evidence_refs must reference Evidence records");
    let candidateWorkspaceState: JsonObject | null = null;
    if (stage === "candidate" || stage === "evaluate" || stage === "promote") {
      const snapshot = object(cycle.snapshot, "cycle.snapshot");
      if (typeof snapshot.candidate_workspace_id === "string") {
        candidateWorkspaceState = this.candidateWorkspaces.validateChanges({ workspace_id: snapshot.workspace_id, checkpoint_id: snapshot.checkpoint_id,
          checkpoint_version: snapshot.checkpoint_version, candidate_id: snapshot.candidate_workspace_id, allowed_paths: snapshot.candidate_allowed_paths ?? [] });
      }
    }
    if (stage === "evaluate" || stage === "promote") {
      const priorCandidate = [...history].reverse().map(event => event.payload as JsonObject | undefined).find(event => event?.stage === "candidate");
      if (priorCandidate && priorCandidate.candidate_workspace_digest !== candidateWorkspaceState?.candidate_digest)
        throw new Error("Candidate workspace changed after its version was frozen; create a new candidate and reevaluate");
    }
    if (stage === "evaluate") {
      if (!artifactRefs.length || !evaluationRefs.length) throw new Error("Evaluation requires candidate artifacts and evaluation references");
      if (stableDigest(artifactRefs) !== stableDigest(cycle.candidate_refs)) throw new Error("Evaluation candidate differs from the recorded candidate version");
      assertHeldOutEvaluation(this.store, cycle, artifactRefs, evaluationRefs);
    }
    // Candidate and evaluation stay bound to the immutable checkpoint. Only a
    // promotion also needs a live working-tree scan; doing that at every stage
    // would repeatedly spawn Git and rescan a project during the task.
    if (stage === "candidate" || stage === "evaluate") this.assertCheckpointCurrent(cycle);
    if (stage === "promote") this.assertBaselineUnchanged(cycle);
    if (new Set(["promote", "reject", "rollback"]).has(stage)) {
      if (!(cycle.evaluation_refs as JsonObject[]).length) throw new Error("A decision requires the previously recorded evaluation");
      if (stage === "promote") {
        if (!authorityRefs.length) throw new Error("Promotion record requires capability authority references");
        if (!assertHeldOutEvaluation(this.store, cycle, cycle.candidate_refs as JsonObject[], cycle.evaluation_refs as JsonObject[]))
          throw new Error("Promotion requires a passing held-out evaluation for the exact candidate version");
        assertPromotionAuthority(this.store, cycle, cycle.candidate_refs as JsonObject[], authorityRefs);
      }
      if (stage !== "promote" && !evidenceRefs.length) throw new Error("Reject or rollback requires evidence references");
    }
    if (stage === "attribute" && failureClass === "environment" && args.next_stage !== "replan")
      throw new Error("Environment failure attribution must replan without changing capability assets");
    const nextStage = stage === "attribute" && failureClass === "environment" ? "replan" : stage;
    const nextFailure = stage === "attribute" ? failureClass : stage === "observe" ? null : cycle.failure_class ?? null;
    const nextOutcome = stage === "feedback" ? outcome : stage === "observe" ? null : cycle.outcome ?? null;
    const eventBody = { ...eventIdentity, request_digest: requestDigest, event_id: `${cycleId}:${Number(cycle.sequence) + 1}`, cycle_id: cycleId,
      sequence: Number(cycle.sequence) + 1, previous_event_digest: cycle.last_event_digest, from_stage: cycle.stage, stage, next_stage: nextStage,
      outcome: nextOutcome, ...(stage === "candidate" && candidateWorkspaceState ? { candidate_workspace_digest: candidateWorkspaceState.candidate_digest } : {}),
      failure_class: nextFailure, snapshot_digest: cycle.snapshot_digest };
    const event = { ...eventBody, event_digest: stableDigest(eventBody) };
    const nextStatus = stage === "replan" && terminal ? "completed" : "active";
    const result = this.store.advanceEvolutionCycle(cycleId, requestedVersion, { ...payload(cycle), stage: nextStage, status: nextStatus, sequence: event.sequence,
      failure_class: nextFailure, candidate_refs: stage === "candidate" ? artifactRefs : cycle.candidate_refs,
      ...(stage === "candidate" && candidateWorkspaceState ? { candidate_workspace_revision_digest: candidateWorkspaceState.candidate_digest } : {}),
      outcome: nextOutcome, evaluation_refs: stage === "evaluate" ? evaluationRefs : cycle.evaluation_refs, last_event_digest: event.event_digest }, stage, event);
    return { ...result, idempotent: result.idempotent === true };
  }

  private assertBaselineUnchanged(cycle: JsonObject): void {
    this.assertCheckpointCurrent(cycle);
    const snapshot = object(cycle.snapshot, "cycle.snapshot");
    const workspace = this.store.get("workspace", text(snapshot.workspace_id, "snapshot.workspace_id"));
    const freshness = this.workspaceState.freshness({ workspace_id: workspace.id });
    if (freshness.status !== "current") throw new Error("Project working tree changed after the Evolution Cycle started; replan and reevaluate the candidate");
  }

  private assertSessionForStage(cycle: JsonObject, stage: string): void {
    const sessionId = text(cycle.session_id, "cycle.session_id");
    const host = text(cycle.session_host, "cycle.session_host");
    const session = this.store.get("host_session", sessionId);
    const task = object(cycle.task_ref, "cycle.task_ref");
    if (session.host_id !== host || session.task_id !== task.id
      || session.identity_digest !== cycle.session_identity_digest || session.trace_id !== cycle.session_trace_id)
      throw new Error("Evolution Cycle requires its original Host Session identity for new transitions");
    // Learning consumes a completed task's evidence after the execution session
    // terminates. Only another observation/retrieval/action requires a live Host.
    if (session.status !== "running" && (session.status !== "terminal" || ["observe", "retrieve", "act"].includes(stage)))
      throw new Error("Evolution Cycle requires its original live Host Session for execution transitions");
    const trace = this.store.get("trace", text(session.trace_id, "host_session.trace_id"));
    if (trace.task_id !== task.id) throw new Error("Evolution Cycle Host Session Trace belongs to another task");
  }

  private assertCheckpointCurrent(cycle: JsonObject): void {
    const snapshot = object(cycle.snapshot, "cycle.snapshot");
    const workspace = this.store.get("workspace", text(snapshot.workspace_id, "snapshot.workspace_id"));
    const checkpoint = this.store.get("workspace_checkpoint", text(snapshot.checkpoint_id, "snapshot.checkpoint_id"), Number(snapshot.checkpoint_version));
    const latestCheckpoint = this.store.get("workspace_checkpoint", text(checkpoint.id, "checkpoint.id"));
    if (workspace.latest_checkpoint_id !== checkpoint.id || Number(workspace.version) !== Number(snapshot.workspace_version)
      || Number(latestCheckpoint.version) !== Number(snapshot.checkpoint_version))
      throw new Error("Promotion baseline changed after the Evolution Cycle started; replan and reevaluate the candidate");
  }

  get(args: JsonObject): JsonObject {
    const cycleId = text(args.cycle_id, "cycle_id"), cycle = this.store.get("evolution_cycle", cycleId);
    const snapshot = object(cycle.snapshot, "cycle.snapshot");
    const candidateWorkspace = typeof snapshot.candidate_workspace_id === "string" ? this.candidateWorkspaces.get({
      workspace_id: snapshot.workspace_id, checkpoint_id: snapshot.checkpoint_id, checkpoint_version: snapshot.checkpoint_version,
      candidate_id: snapshot.candidate_workspace_id,
    }) : null;
    if (candidateWorkspace && (candidateWorkspace.manifest as JsonObject).source_digest !== snapshot.candidate_workspace_digest)
      throw new Error("Evolution Cycle candidate workspace baseline digest is invalid");
    return { cycle, events: verifiedEvents(this.store.events(`evolution:${cycleId}`), cycle), candidate_workspace: candidateWorkspace };
  }
}
