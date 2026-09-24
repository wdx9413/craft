import { randomUUID } from "node:crypto";
import type { MemoryLedgerKernel } from "../capability/craft-memory/memory-ledger.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { object } from "./validation.ts";
import { canonicalJson, stableDigest, payload } from "./digest.ts";

const SCOPE_KINDS = new Set(["user", "project", "workspace", "task"]);
/**
 * Intents a proposal may declare.
 *
 * `memory` and `experience` are here because the context decision below reads them. They used
 * to be absent, and the decision read only `knowledge` — so a Host that declared it needed
 * memory, or experience, got `context: "none"` and no context pack at all. The member was in
 * the MCP surface and not in the decision that decides whether to consult it.
 */
const INTENTS = new Set(["conversation", "knowledge", "memory", "experience", "capability", "task", "execution", "learning"]);
/**
 * Signals a proposal may declare, and the defaults a policy may rely on.
 *
 * `needs_memory` and `needs_experience` name the two accumulated members that had no signal of
 * their own, which is the other half of the same defect: a Host could not say "I need memory"
 * in a way the policy could match.
 */
const SIGNALS = new Set(["needs_context", "needs_memory", "needs_experience", "needs_capability", "needs_workflow", "needs_execution", "durable_value", "sensitive"]);
const MEMORY_KINDS = new Set(["working", "episodic", "preference", "procedural"]);
const CONFIDENCE = new Set(["confirmed", "bounded", "unverified"]);
const CANDIDATE_STATUS = new Set(["accepted", "rejected", "revoked"]);
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  const result = value.trim();
  if (SECRET.test(result)) throw new Error(`${name} must not contain credentials or secrets`);
  return result;
}

function strings(value: unknown, name: string, allowed?: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${name} must be a non-empty array`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`);
  if (allowed && result.some((item) => !allowed.has(item))) throw new Error(`${name} contains an unsupported value`);
  return result.sort();
}
function optionalStrings(value: unknown, name: string, allowed?: ReadonlySet<string>): string[] {
  return value === undefined ? [] : strings(value, name, allowed);
}
function scope(args: JsonObject): JsonObject {
  const kind = text(args.scope_kind, "scope_kind");
  if (!SCOPE_KINDS.has(kind)) throw new Error("scope_kind is unsupported");
  return { kind, id: text(args.scope_id, "scope_id") };
}
function sameScope(left: JsonObject, right: JsonObject): boolean { return canonicalJson(left) === canonicalJson(right); }

type Actions = { context: "none" | "resolve"; capability: "none" | "discover"; workflow: "none" | "route"; work: "none" | "prepare"; memory: "none" | "candidate"; evaluation: "none" | "observe" };

function candidate(args: JsonObject): JsonObject | null {
  if (args.memory_candidate === undefined) return null;
  const input = object(args.memory_candidate, "memory_candidate");
  const kind = text(input.kind, "memory_candidate.kind");
  if (!MEMORY_KINDS.has(kind)) throw new Error("memory_candidate.kind is unsupported");
  const sensitivity = text(input.sensitivity ?? "internal", "memory_candidate.sensitivity");
  if (!new Set(["public", "internal", "restricted"]).has(sensitivity)) throw new Error("memory_candidate.sensitivity is unsupported");
  return { source_id: text(input.source_id, "memory_candidate.source_id"), kind, content: text(input.content, "memory_candidate.content"), sensitivity,
    evidence_ids: optionalStrings(input.evidence_ids, "memory_candidate.evidence_ids"), valid_until: input.valid_until === undefined ? null : text(input.valid_until, "memory_candidate.valid_until") };
}

/**
 * A small, deterministic cognitive control plane. Hosts own semantic
 * understanding; Craft records the bounded proposal, decides what additional
 * state may be useful, and never treats a candidate as durable memory by
 * itself. It does not install a hook into Codex, Claude, or an IDE.
 */
export class TurnCognitiveRuntime {
  readonly store: CraftStore;
  readonly memory: MemoryLedgerKernel;
  constructor(store: CraftStore, memory: MemoryLedgerKernel) { this.store = store; this.memory = memory; }

  policySave(args: JsonObject): JsonObject {
    const policyScope = scope(args); const mode = text(args.mode ?? "governed", "mode");
    if (!new Set(["observe_only", "candidate_only", "governed"]).has(mode)) throw new Error("Turn Policy mode is unsupported");
    const identity = { scope: policyScope, mode, context_on: optionalStrings(args.context_on, "context_on", SIGNALS),
      capability_on: optionalStrings(args.capability_on, "capability_on", SIGNALS), workflow_on: optionalStrings(args.workflow_on, "workflow_on", SIGNALS),
      memory_capture: text(args.memory_capture ?? "candidate", "memory_capture"), evaluation_capture: text(args.evaluation_capture ?? "observe", "evaluation_capture") };
    if (!new Set(["none", "candidate"]).has(identity.memory_capture)) throw new Error("memory_capture is unsupported");
    if (!new Set(["none", "observe"]).has(identity.evaluation_capture)) throw new Error("evaluation_capture is unsupported");
    const policyId = String(args.policy_id ?? `turn_policy_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("turn_policy", policyId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Turn Policy idempotency conflict"); return { policy: existing, idempotent: true }; }
    return { policy: this.store.create("turn_policy", policyId, { ...identity, identity_digest: identityDigest, status: "active", execution_authority: false }), idempotent: false };
  }

  policyGet(args: JsonObject): JsonObject { return { policy: this.store.get("turn_policy", text(args.policy_id, "policy_id"), args.version === undefined ? undefined : Number(args.version)) }; }

  proposalSubmit(args: JsonObject): JsonObject {
    const proposalScope = scope(args); const semanticOwner = text(args.semantic_owner, "semantic_owner");
    if (!new Set(["host", "craft_agent"]).has(semanticOwner)) throw new Error("semantic_owner is unsupported");
    const modeProfile = args.work_runtime_mode_id === undefined ? null : this.store.get("work_runtime_mode", text(args.work_runtime_mode_id, "work_runtime_mode_id"));
    if (semanticOwner === "craft_agent" && (modeProfile === null || modeProfile.mode !== "agent" || modeProfile.default_model === null)) throw new Error("Craft Agent proposal requires an active Agent Work Runtime mode");
    if (semanticOwner === "host" && args.host_adapter_id === undefined) throw new Error("Host proposal requires host_adapter_id");
    const identity = { scope: proposalScope, semantic_owner: semanticOwner, host_adapter_id: args.host_adapter_id === undefined ? null : text(args.host_adapter_id, "host_adapter_id"),
      work_runtime_mode_id: modeProfile?.id ?? null, work_runtime_mode_version: modeProfile?.version ?? null, model: modeProfile?.default_model ?? null,
      input_digest: text(args.input_digest, "input_digest"), intents: strings(args.intents, "intents", INTENTS), signals: optionalStrings(args.signals, "signals", SIGNALS), memory_candidate: candidate(args) };
    const proposalId = String(args.proposal_id ?? `turn_proposal_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("turn_proposal", proposalId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Turn Proposal idempotency conflict"); return { proposal: existing, idempotent: true }; }
    return { proposal: this.store.create("turn_proposal", proposalId, { ...identity, identity_digest: identityDigest, content_free_input: true, execution_authority: false }), idempotent: false };
  }

  hostAdapterSave(args: JsonObject): JsonObject {
    const host = text(args.host, "host"); if (!new Set(["codex", "claude", "ide", "generic"]).has(host)) throw new Error("Turn Host Adapter host is unsupported");
    const delivery = text(args.delivery ?? "manual", "delivery"); if (!new Set(["manual", "event_hook"]).has(delivery)) throw new Error("Turn Host Adapter delivery is unsupported");
    const identity = { host, delivery, supports_turn_hook: args.supports_turn_hook === true, proposal_contract: text(args.proposal_contract ?? "turn-proposal/v1", "proposal_contract") };
    if (delivery === "event_hook" && identity.supports_turn_hook !== true) throw new Error("event_hook requires supports_turn_hook");
    const adapterId = String(args.adapter_id ?? `turn_host_adapter_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("turn_host_adapter", adapterId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Turn Host Adapter idempotency conflict"); return { adapter: existing, idempotent: true }; }
    return { adapter: this.store.create("turn_host_adapter", adapterId, { ...identity, identity_digest: identityDigest, status: "declared", modifies_host_configuration: false }), idempotent: false };
  }

  hookPlan(args: JsonObject): JsonObject {
    const adapter = this.store.get("turn_host_adapter", text(args.adapter_id, "adapter_id"));
    return { plan: { adapter_id: adapter.id, adapter_version: adapter.version, host: adapter.host, proposal_contract: adapter.proposal_contract,
      status: adapter.delivery === "event_hook" ? "requires_host_install" : "manual_submission", automatic: false, modifies_host_configuration: false } };
  }

  assess(args: JsonObject): JsonObject {
    const proposal = this.store.get("turn_proposal", text(args.proposal_id, "proposal_id")); const policy = this.store.get("turn_policy", text(args.policy_id, "policy_id"));
    if (policy.status !== "active" || !sameScope(policy.scope as JsonObject, proposal.scope as JsonObject)) throw new Error("Turn Proposal is outside the active Policy scope");
    const actions = this.decide(policy, proposal); const receiptIdentity = { proposal_id: proposal.id, proposal_version: proposal.version, policy_id: policy.id, policy_version: policy.version, actions,
      input_digest: proposal.input_digest, semantic_owner: proposal.semantic_owner, selected_refs: { host_adapter_id: proposal.host_adapter_id, work_runtime_mode_id: proposal.work_runtime_mode_id } };
    const receiptId = String(args.receipt_id ?? `turn_receipt_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("turn_receipt", receiptId); const receiptDigest = stableDigest(receiptIdentity);
    if (existing) { if (existing.identity_digest !== receiptDigest) throw new Error("Turn Receipt idempotency conflict"); return { receipt: existing, candidate: existing.memory_candidate_id ? this.store.get("turn_memory_candidate", String(existing.memory_candidate_id)) : null, idempotent: true }; }
    const memoryCandidate = actions.memory === "candidate" ? this.createCandidate(proposal, policy) : null;
    const receipt = this.store.create("turn_receipt", receiptId, { ...receiptIdentity, identity_digest: receiptDigest, memory_candidate_id: memoryCandidate?.id ?? null, content_free: true, execution_authority: false });
    return { receipt, candidate: memoryCandidate, idempotent: false };
  }

  receiptGet(args: JsonObject): JsonObject { return { receipt: this.store.get("turn_receipt", text(args.receipt_id, "receipt_id"), args.version === undefined ? undefined : Number(args.version)) }; }

  candidateList(args: JsonObject = {}): JsonObject {
    const requestedScope = args.scope_kind === undefined ? null : scope(args); const status = args.status === undefined ? null : text(args.status, "status");
    if (status !== null && !new Set(["candidate", ...CANDIDATE_STATUS]).has(status)) throw new Error("Memory Candidate status is unsupported");
    return { candidates: this.store.list("turn_memory_candidate", Number(args.limit ?? 100), (item) => (requestedScope === null || sameScope(item.scope as JsonObject, requestedScope)) && (status === null || item.status === status)) };
  }

  candidateDecide(args: JsonObject): JsonObject {
    const record = this.store.get("turn_memory_candidate", text(args.candidate_id, "candidate_id")); const status = text(args.status, "status");
    if (!CANDIDATE_STATUS.has(status)) throw new Error("Memory Candidate status is unsupported");
    if (record.status !== "candidate") throw new Error("Memory Candidate is already decided");
    const reasonDigest = stableDigest(text(args.reason, "reason")); let memoryId: string | null = null;
    if (status === "accepted") {
      const confidence = text(args.confidence ?? "bounded", "confidence"); if (!CONFIDENCE.has(confidence)) throw new Error("Memory Candidate confidence is unsupported");
      const remembered = this.memory.remember({ memory_id: args.memory_id ?? `memory_from_${record.id}`, source_id: record.source_id, kind: record.kind, scope_kind: (record.scope as JsonObject).kind,
        scope_id: (record.scope as JsonObject).id, content: record.content, sensitivity: record.sensitivity, confidence, evidence_ids: record.evidence_ids, valid_until: record.valid_until }).memory as JsonObject;
      memoryId = String(remembered.id);
    }
    return { candidate: this.store.save("turn_memory_candidate", String(record.id), { ...payload(record), status, decision_reason_digest: reasonDigest, memory_id: memoryId }), memory_id: memoryId };
  }

  evaluationCaseSave(args: JsonObject): JsonObject {
    const policy = this.store.get("turn_policy", text(args.policy_id, "policy_id")); const proposal = object(args.proposal, "proposal");
    if (proposal.memory_candidate !== undefined) throw new Error("Turn Evaluation Case proposal must be content-free");
    const expected = object(args.expected_actions, "expected_actions"); const identity = { policy_id: policy.id, policy_version: policy.version, proposal, expected_actions: expected };
    const caseId = String(args.case_id ?? `turn_evaluation_case_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("turn_evaluation_case", caseId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Turn Evaluation Case idempotency conflict"); return { case: existing, idempotent: true }; }
    return { case: this.store.create("turn_evaluation_case", caseId, { ...identity, identity_digest: identityDigest, content_free: true }), idempotent: false };
  }

  evaluationRun(args: JsonObject): JsonObject {
    const requested = optionalStrings(args.case_ids, "case_ids"); const cases = requested.length ? requested.map((caseId) => this.store.get("turn_evaluation_case", caseId)) : this.store.list("turn_evaluation_case", 1_000);
    if (!cases.length) throw new Error("Turn Evaluation Run requires at least one Case");
    const results = cases.map((item) => this.evaluate(item)); const passed = results.filter((item) => item.passed).length;
    const metrics = { cases: results.length, passed, decision_accuracy: passed / results.length, false_positive_count: results.reduce((sum, item) => sum + item.false_positive_count, 0), scope_rejection_count: results.filter((item) => item.scope_rejected).length };
    const identity = { case_refs: cases.map((item) => ({ id: item.id, version: item.version })), metrics, verdict: passed === results.length ? "eligible" : "rejected" };
    const evaluationId = String(args.evaluation_id ?? `turn_evaluation_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("turn_evaluation", evaluationId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Turn Evaluation Run idempotency conflict"); return { evaluation: existing, results, idempotent: true }; }
    return { evaluation: this.store.create("turn_evaluation", evaluationId, { ...identity, identity_digest: identityDigest, results, execution_authority: false }), results, idempotent: false };
  }

  private decide(policy: JsonObject, proposal: JsonObject): Actions {
    const signals = new Set(proposal.signals as string[]); const intents = new Set(proposal.intents as string[]);
    const matches = (configured: unknown, defaults: readonly string[]) => (configured as string[]).some((item) => signals.has(item)) || defaults.some((item) => signals.has(item));
    // Resolving context means assembling the pack from all three accumulated members at once,
    // so the decision is "does this turn need any of them" rather than "does it need
    // knowledge". The three intents and the three signals are listed explicitly because that
    // list is the claim: adding a fourth member without adding it here is the bug this fixes,
    // and `context_members_are_all_decidable` in the tests pins the correspondence.
    const context = policy.mode === "observe_only" ? "none"
      : (matches(policy.context_on, ["needs_context", "needs_memory", "needs_experience"])
        || intents.has("knowledge") || intents.has("memory") || intents.has("experience") ? "resolve" : "none");
    const capability = policy.mode === "observe_only" ? "none" : (matches(policy.capability_on, ["needs_capability"]) || intents.has("capability") ? "discover" : "none");
    const workflow = policy.mode === "governed" && (matches(policy.workflow_on, ["needs_workflow"]) || intents.has("task") || intents.has("execution")) ? "route" : "none";
    const work = policy.mode === "governed" && (signals.has("needs_execution") || intents.has("execution")) ? "prepare" : "none";
    const memory = policy.memory_capture === "candidate" && proposal.memory_candidate !== null && signals.has("durable_value") ? "candidate" : "none";
    const evaluation = policy.evaluation_capture === "observe" && (work !== "none" || memory !== "none" || signals.has("durable_value")) ? "observe" : "none";
    return { context, capability, workflow, work, memory, evaluation };
  }

  private createCandidate(proposal: JsonObject, policy: JsonObject): JsonObject {
    const memoryCandidate = proposal.memory_candidate as JsonObject;
    const source = this.store.get("knowledge_source", String(memoryCandidate.source_id));
    if (source.status !== "active" || source.trust === "untrusted") throw new Error("Memory Candidate source is unavailable");
    const identity = { proposal_id: proposal.id, proposal_version: proposal.version, policy_id: policy.id, policy_version: policy.version, source_id: source.id, source_version: source.version,
      kind: memoryCandidate.kind, scope: proposal.scope, content: memoryCandidate.content, content_digest: stableDigest(memoryCandidate.content), sensitivity: memoryCandidate.sensitivity, evidence_ids: memoryCandidate.evidence_ids, valid_until: memoryCandidate.valid_until };
    const candidateId = `turn_memory_candidate_${stableDigest(identity).slice(-24)}`; const existing = this.store.find("turn_memory_candidate", candidateId); const identityDigest = stableDigest(identity);
    if (existing) return existing;
    return this.store.create("turn_memory_candidate", candidateId, { ...identity, identity_digest: identityDigest, status: "candidate", lifecycle: "proposed_not_memory" });
  }

  private evaluate(item: JsonObject): { case_id: string; passed: boolean; false_positive_count: number; scope_rejected: boolean } {
    const policy = this.store.get("turn_policy", String(item.policy_id), Number(item.policy_version)); const proposal = object(item.proposal, "proposal");
    const expected = object(item.expected_actions, "expected_actions"); const proposalScope = scope(proposal); const scopeRejected = !sameScope(policy.scope as JsonObject, proposalScope);
    if (scopeRejected) return { case_id: String(item.id), passed: false, false_positive_count: 0, scope_rejected: true };
    const normalized = { ...proposal, scope: proposalScope, signals: optionalStrings(proposal.signals, "signals", SIGNALS), intents: strings(proposal.intents, "intents", INTENTS), memory_candidate: null };
    const actual = this.decide(policy, normalized); const fields = Object.keys(actual) as Array<keyof Actions>;
    const falsePositives = fields.filter((field) => expected[field] === "none" && actual[field] !== "none").length;
    return { case_id: String(item.id), passed: canonicalJson(actual) === canonicalJson(expected), false_positive_count: falsePositives, scope_rejected: false };
  }
}