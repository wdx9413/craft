import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { canonicalJson, stableDigest } from "../../common/craft-common-base/src/digest.ts";
import { credentialStatus, selectModel, type ModelProviderSpec, type ModelTier } from "../../common/craft-common-base/src/model-compat.ts";
import { CraftStore, type JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { scopeFromKey } from "../../common/craft-common-base/src/scope-policy.ts";
import { knowledgeDirectoryForScope, projectRootForKnowledgeSource } from "../../core/project-knowledge-content.ts";
import { listKnowledgeScenarios } from "../craft-knowledge/scenario-catalog.ts";

const PURPOSES = new Set(["evaluation", "workflow_evolution", "knowledge_scenario_classification"]);
const KNOWLEDGE_CLASSIFIABLE_STATUSES = new Set(["candidate", "reviewed"]);
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  const result = value.trim();
  if (SECRET.test(result)) throw new Error(`${name} must not contain credentials or secrets`);
  return result;
}
function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return number;
}
function bool(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}
function strings(value: unknown, name: string, fallback: string[]): string[] {
  const input = value === undefined ? fallback : value;
  if (!Array.isArray(input) || !input.length) throw new Error(`${name} must be a non-empty array`);
  const result = input.map((item) => text(item, name));
  if (new Set(result).size !== result.length || result.some((item) => !PURPOSES.has(item))) throw new Error(`${name} contains an unsupported purpose`);
  return result.sort();
}
/**
 * Stores a secret-free, version-pinned model configuration for evaluation work.
 * It only issues a bounded invocation contract; a Host/Adapter still owns the
 * actual network call and must later bind an observed Task Run to the Campaign.
 */
export class EvaluationModelProfileKernel {
  readonly store: CraftStore;
  readonly providers: readonly ModelProviderSpec[];
  readonly env: NodeJS.ProcessEnv;
  readonly traceReader: { get(args: JsonObject): JsonObject } | undefined;

  constructor(store: CraftStore, providers: readonly ModelProviderSpec[], env: NodeJS.ProcessEnv = process.env,
    traceReader?: { get(args: JsonObject): JsonObject }) {
    this.store = store; this.providers = providers; this.env = env; this.traceReader = traceReader;
  }

  save(args: JsonObject): JsonObject {
    const spec = this.provider(args.provider); const requestedTier = args.tier === undefined ? null : text(args.tier, "tier") as ModelTier;
    const selected = requestedTier === null ? null : selectModel(spec, requestedTier);
    const model = args.model === undefined ? selected?.model : text(args.model, "model");
    if (!model) throw new Error("model or tier is required");
    const temperature = args.temperature === undefined ? 0 : Number(args.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error("temperature must be between 0 and 2");
    const identity = {
      provider: spec.provider, model, selected_tier: selected?.tier ?? null, requested_tier: requestedTier,
      api_key_env: credentialStatus(spec, this.env).api_key_env, temperature, max_output_tokens: integer(args.max_output_tokens, "max_output_tokens", 4_096, 1, 1_000_000),
      max_attempts: integer(args.max_attempts, "max_attempts", 1, 1, 20), purposes: strings(args.purposes, "purposes", ["evaluation", "workflow_evolution"]),
      network_execution_enabled: bool(args.network_execution_enabled, "network_execution_enabled", false),
    };
    const profileId = String(args.profile_id ?? `evaluation_model_profile_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("evaluation_model_profile", profileId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Evaluation Model Profile idempotency conflict"); return { profile: existing, readiness: this.readiness(existing), idempotent: true }; }
    const profile = this.store.create("evaluation_model_profile", profileId, { ...identity, identity_digest: identityDigest, lifecycle: "active", secret_stored: false, execution_authority: "adapter_only" });
    return { profile, readiness: this.readiness(profile), idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const profile = this.store.get("evaluation_model_profile", text(args.profile_id, "profile_id"), args.version === undefined ? undefined : integer(args.version, "version", 1, 1, Number.MAX_SAFE_INTEGER));
    const spec = this.provider(profile.provider);
    return { profile, provider: { provider: spec.provider, label: spec.label, protocol: spec.protocol, base_url: spec.base_url,
      api_key_env: spec.host_managed_auth ? "host-managed-auth-store" : spec.api_key_env, chat_path: spec.chat_path, models: spec.models, cost_hint: spec.cost_hint, supports_tools: spec.supports_tools,
      ...(spec.host_managed_auth ? { host_managed_auth: true } : {}),
      context_cache: spec.context_cache ?? { mode: "none", requires_exact_prefix: false, usage_fields: "none" } }, readiness: this.readiness(profile) };
  }

  list(args: JsonObject = {}): JsonObject {
    const limit = integer(args.limit, "limit", 100, 1, 1_000);
    return { profiles: this.store.list("evaluation_model_profile", limit).map((profile) => ({ ...profile, readiness: this.readiness(profile) })) };
  }

  ticketList(args: JsonObject = {}): JsonObject {
    const limit = integer(args.limit, "limit", 100, 1, 1_000);
    const purpose = args.purpose === undefined ? null : text(args.purpose, "purpose");
    if (purpose !== null && !PURPOSES.has(purpose)) throw new Error("purpose is unsupported");
    const tickets = this.store.list("evaluation_model_ticket", limit, (ticket) => {
      if (purpose !== null && ticket.purpose !== purpose) return false;
      if (ticket.status !== "ready_for_adapter") return false;
      const target = ticket.target as JsonObject | undefined;
      if (target?.kind === "knowledge_scenario_classification") {
        if (ticket.purpose !== "knowledge_scenario_classification") return false;
        const claim = this.store.find("knowledge_claim", String(target.id));
        if (!claim || typeof claim.scope !== "string" || !KNOWLEDGE_CLASSIFIABLE_STATUSES.has(String(claim.status)) || typeof claim.scenario_key === "string"
          || Number(claim.version) !== Number(target.version) || claim.content_digest !== target.content_digest) return false;
        const scope = scopeFromKey(String(claim.scope));
        if (scope.kind !== "project" && scope.kind !== "global") return false;
        const source = typeof claim.source_id === "string" ? this.store.find("knowledge_source", claim.source_id) : null;
        if (!source || source.status !== "active" || source.trust === "untrusted") return false;
        const contentPath = (claim.content_ref as JsonObject | undefined)?.path;
        const projectRoot = typeof target.project_root === "string" ? target.project_root : projectRootForKnowledgeSource(source);
        if (scope.kind === "project" && !projectRoot && typeof contentPath !== "string") return false;
        let knowledgeDirectory: string;
        try {
          knowledgeDirectory = knowledgeDirectoryForScope(this.store, scope.kind === "global" ? "global" : `project:${scope.id}`, {
            ...(typeof contentPath === "string" ? { reference_path: contentPath } : {}),
            ...(projectRoot ? { project_root: projectRoot } : {}),
          });
        } catch { return false; }
        return Number(listKnowledgeScenarios(knowledgeDirectory, scope.id, scope.kind).catalog_version) === Number(target.catalog_version);
      }
      if (target?.kind === "experience_scenario_classification_request") {
        if (ticket.purpose !== "workflow_evolution") return false;
        const request = this.store.find("experience_scenario_classification_request_ref", String(target.id));
        return request?.status === "awaiting_model" && request.scope === target.scope
          && Number(request.request_version) === Number(target.version);
      }
      if (ticket.purpose === "evaluation") return true;
      if (ticket.purpose !== "workflow_evolution") return false;
      if (target?.kind !== "workflow_evolution_request") return false;
      const request = this.store.find("workflow_evolution_request", String(target.id));
      return request?.lifecycle === "awaiting_model" && Number(request.version) === Number(target.version);
    });
    return { tickets: tickets.map((ticket) => {
      const profile = this.store.get("evaluation_model_profile", String(ticket.profile_id), Number(ticket.profile_version));
      const readiness = this.readiness(profile);
      return { ...ticket, readiness };
    }) };
  }

  ticketComplete(args: JsonObject): JsonObject {
    const ticketId = text(args.ticket_id, "ticket_id");
    const ticket = this.store.get("evaluation_model_ticket", ticketId);
    if (!(new Set(["knowledge_scenario_classification", "workflow_evolution"])).has(String(ticket.purpose))) throw new Error("Only a Knowledge classification or Workflow-evolution ticket can be completed");
    const resultDigest = text(args.result_digest, "result_digest");
    if (!/^sha256:[a-f0-9]{64}$/u.test(resultDigest)) throw new Error("result_digest must be a SHA-256 digest");
    if (ticket.status === "completed") {
      if (ticket.result_digest !== resultDigest) throw new Error("Evaluation Model Ticket completion digest conflicts with its prior result");
      const traceId = ticket.purpose === "knowledge_scenario_classification" || args.trace_id !== undefined ? text(args.trace_id, "trace_id") : undefined;
      if (traceId && ticket.purpose === "knowledge_scenario_classification" && !this.knowledgeResultTraceMatches(ticket, traceId, resultDigest)) {
        throw new Error("Knowledge classification ticket requires its exact model and result Trace before completion");
      }
      if (traceId && ticket.trace_id !== traceId) throw new Error("Evaluation Model Ticket completion Trace conflicts with its prior result");
      return { ticket, idempotent: true };
    }
    if (ticket.status !== "ready_for_adapter") throw new Error("Evaluation Model Ticket is not ready for completion");
    const traceId = ticket.purpose === "knowledge_scenario_classification" || args.trace_id !== undefined ? text(args.trace_id, "trace_id") : undefined;
    if (traceId && ticket.purpose === "knowledge_scenario_classification" && !this.knowledgeResultTraceMatches(ticket, traceId, resultDigest)) {
      throw new Error("Knowledge classification ticket requires its exact model and result Trace before completion");
    }
    if (ticket.purpose === "workflow_evolution") {
      const target = ticket.target as JsonObject;
      if (traceId) {
        const trace = this.store.find("trace", traceId);
        const profile = this.store.get("evaluation_model_profile", String(ticket.profile_id), Number(ticket.profile_version));
        if (!trace || trace.operation_id !== ticket.id || trace.task_id !== `experience:${target.id}`
          || trace.model_fingerprint !== stableDigest({ provider: profile.provider, model: profile.model })) {
          throw new Error("Experience ticket requires its exact model Trace");
        }
      }
      if (target.kind === "experience_scenario_classification_request") {
        const request = this.store.find("experience_scenario_classification_request_ref", String(target.id));
        if (!request || request.scope !== target.scope || !["classified", "unclassified"].includes(String(request.status))
          || request.result_digest !== resultDigest) throw new Error("Experience classification ticket requires its exact resolved request before completion");
      } else {
        const proposal = this.store.list("workflow_evolution_proposal", 1_000, (item) => item.model_ticket_id === ticket.id
          && item.request_id === target.id && Number(item.request_version) === Number(target.version))[0];
        const request = proposal ? this.store.find("workflow_evolution_request", String(target.id)) : null;
        if (!proposal || request?.lifecycle !== "draft_submitted" || request.proposal_id !== proposal.id) {
          throw new Error("Workflow-evolution ticket requires its exact submitted candidate before completion");
        }
      }
    }
    const completed = this.store.save("evaluation_model_ticket", ticketId, { ...ticket, status: "completed", result_digest: resultDigest,
      ...(traceId ? { trace_id: traceId } : {}), completed_at: new Date().toISOString() });
    this.store.appendEvent(`evaluation-model:${ticket.profile_id}`, "evaluation_model.ticket_completed", { ticket_id: ticket.id, purpose: ticket.purpose, result_digest: resultDigest });
    return { ticket: completed, idempotent: completed === ticket };
  }

  issue(args: JsonObject): JsonObject {
    const profile = this.store.get("evaluation_model_profile", text(args.profile_id, "profile_id"));
    if (profile.lifecycle !== "active") throw new Error("Evaluation Model Profile is not active");
    const purpose = text(args.purpose, "purpose"); if (!(profile.purposes as string[]).includes(purpose)) throw new Error("Evaluation Model Profile does not allow this purpose");
    const target = this.target(args, purpose); const inputRef = text(args.input_ref, "input_ref"); const outputContractRef = text(args.output_contract_ref, "output_contract_ref");
    const identity = { profile_id: profile.id, profile_version: profile.version, profile_digest: profile.identity_digest, purpose, target, input_ref: inputRef, output_contract_ref: outputContractRef, content_stored: false, execution_authority: "adapter_only" };
    const ticketId = String(args.ticket_id ?? `evaluation_model_ticket_${stableDigest(identity).slice(-20)}`); const existing = this.store.find("evaluation_model_ticket", ticketId); const identityDigest = stableDigest(identity);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Evaluation Model Ticket idempotency conflict");
      if (purpose !== "knowledge_scenario_classification" || existing.status !== "completed" || this.knowledgeTicketCompletionVerified(existing)) {
        return { ticket: existing, readiness: this.readiness(profile), idempotent: true };
      }
      return this.issueKnowledgeRecoveryTicket(ticketId, identity, identityDigest, profile);
    }
    const readiness = this.readiness(profile); const ticket = this.store.create("evaluation_model_ticket", ticketId, { ...identity, identity_digest: identityDigest, status: readiness.status, next_action: readiness.next_action });
    this.store.appendEvent(`evaluation-model:${profile.id}`, "evaluation_model.ticket_issued", { ticket_id: ticket.id, purpose, target_kind: target.kind, target_id: target.id });
    return { ticket, readiness, idempotent: false };
  }

  private knowledgeTicketCompletionVerified(ticket: JsonObject): boolean {
    return typeof ticket.trace_id === "string" && typeof ticket.result_digest === "string"
      && this.knowledgeResultTraceMatches(ticket, ticket.trace_id, ticket.result_digest);
  }

  private knowledgeResultTraceMatches(ticket: JsonObject, traceId: string, resultDigest: string): boolean {
    if (!/^sha256:[a-f0-9]{64}$/u.test(resultDigest)) return false;
    const target = ticket.target as JsonObject | undefined;
    const profile = this.store.find("evaluation_model_profile", String(ticket.profile_id), Number(ticket.profile_version));
    let trace = this.store.find("trace", traceId);
    let archivedEvents: JsonObject[] | undefined;
    if (!trace && this.store.find("trace_archive", traceId)) {
      // An unreadable archive is an unavailable proof, not evidence that the model
      // never ran. Propagate the error so issuance cannot silently replay the call.
      if (!this.traceReader) throw new Error("Archived model Trace reader is unavailable");
      const archived = this.traceReader.get({ trace_id: traceId });
      if (!archived.trace || typeof archived.trace !== "object" || Array.isArray(archived.trace)
        || !Array.isArray(archived.events) || (archived.trace as JsonObject).id !== traceId) throw new Error("Archived model Trace is malformed");
      trace = archived.trace as JsonObject;
      archivedEvents = archived.events as JsonObject[];
    }
    if (ticket.purpose !== "knowledge_scenario_classification" || target?.kind !== "knowledge_scenario_classification"
      || typeof target.id !== "string" || !profile || !trace || trace.task_id !== `knowledge:${target.id}` || trace.operation_id !== ticket.id) return false;
    const expectedFingerprint = stableDigest({ provider: profile.provider, model: profile.model });
    if (trace.model_fingerprint !== expectedFingerprint) return false;
    const count = Number(trace.event_count);
    if (!Number.isSafeInteger(count) || count < 2 || count > 10_000) return false;
    const events = archivedEvents ?? Array.from({ length: count }, (_, index) => this.store.find("trace_event", `${traceId}:${index + 1}`))
      .filter((event): event is JsonObject => Boolean(event));
    const modelEvent = events.find(event => event.event_kind === "model.completed" && event.operation_id === ticket.id
      && event.model_fingerprint === expectedFingerprint);
    const resultEvent = events.find(event => event.event_kind === "model.result_bound" && event.actor === "knowledge-classification-worker"
      && event.source === "craft-knowledge" && event.trust === "verified" && event.operation_id === ticket.id
      && Array.isArray(event.output_refs) && event.output_refs.includes(target.id)
      && event.data_digest === stableDigest({ ticket_id: ticket.id, result_digest: resultDigest }));
    return Boolean(modelEvent && resultEvent && Number(modelEvent.sequence) < Number(resultEvent.sequence));
  }

  private issueKnowledgeRecoveryTicket(baseTicketId: string, identity: JsonObject, identityDigest: string, profile: JsonObject): JsonObject {
    const readiness = this.readiness(profile);
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const retryId = `evaluation_model_ticket_retry_${stableDigest({ base_ticket_id: baseTicketId, identity_digest: identityDigest, attempt }).slice(-20)}`;
      const existing = this.store.find("evaluation_model_ticket", retryId);
      if (existing) {
        if (existing.identity_digest !== identityDigest) throw new Error("Evaluation Model Ticket recovery idempotency conflict");
        if (existing.status !== "completed" || this.knowledgeTicketCompletionVerified(existing)) {
          return { ticket: existing, readiness, idempotent: true, recovered_from: baseTicketId };
        }
        continue;
      }
      const ticket = this.store.create("evaluation_model_ticket", retryId, { ...identity, identity_digest: identityDigest,
        status: readiness.status, next_action: readiness.next_action, recovery_of: baseTicketId, recovery_attempt: attempt });
      this.store.appendEvent(`evaluation-model:${profile.id}`, "evaluation_model.ticket_reissued", { ticket_id: ticket.id,
        purpose: ticket.purpose, target_kind: (ticket.target as JsonObject).kind, target_id: (ticket.target as JsonObject).id,
        recovery_of: baseTicketId, recovery_attempt: attempt, reason: "completed_ticket_missing_verified_trace" });
      return { ticket, readiness, idempotent: false, recovered_from: baseTicketId };
    }
    throw new Error("Evaluation Model Ticket recovery attempt limit reached");
  }

  private provider(value: unknown): ModelProviderSpec {
    const provider = text(value, "provider"); const spec = this.providers.find((item) => item.provider === provider);
    if (!spec) throw new Error(`Unknown model provider: ${provider}`);
    return spec;
  }

  private readiness(profile: JsonObject): JsonObject {
    const spec = this.provider(profile.provider); const credential = credentialStatus(spec, this.env);
    if (profile.network_execution_enabled !== true) return { status: "needs_enablement", next_action: "explicitly_enable_network_execution", ...credential };
    if (!credential.configured) return { status: "needs_credential", next_action: `set_${credential.api_key_env}`, ...credential };
    return { status: "ready_for_adapter", next_action: "adapter_may_execute_ticket", ...credential };
  }

  private target(args: JsonObject, purpose: string): JsonObject {
    if (purpose === "evaluation") {
      const dispatch = this.store.get("campaign_runner_dispatch", text(args.campaign_dispatch_id, "campaign_dispatch_id"));
      if (dispatch.status !== "issued") throw new Error("Campaign Runner dispatch is not issuable");
      return { kind: "campaign_runner_dispatch", id: dispatch.id, version: dispatch.version, campaign_id: dispatch.runner_id, slot_id: dispatch.slot_id };
    }
    if (purpose === "knowledge_scenario_classification") {
      const claim = this.store.get("knowledge_claim", text(args.knowledge_claim_id, "knowledge_claim_id"));
      const scope = scopeFromKey(String(claim.scope ?? "global"));
      const source = typeof claim.source_id === "string" ? this.store.find("knowledge_source", claim.source_id) : null;
      if (typeof claim.scope !== "string" || !KNOWLEDGE_CLASSIFIABLE_STATUSES.has(String(claim.status)) || typeof claim.scenario_key === "string" || scope.kind !== "project" && scope.kind !== "global"
        || !source || source.status !== "active" || source.trust === "untrusted") {
        throw new Error("Knowledge scenario ticket requires an unclassified project or global Claim from an active trusted Source");
      }
      const projectRoot = scope.kind === "project"
        ? typeof args.project_root === "string" ? args.project_root : projectRootForKnowledgeSource(source)
        : null;
      const knowledgeDirectory = knowledgeDirectoryForScope(this.store, scope.kind === "global" ? "global" : `project:${scope.id}`,
        projectRoot ? { project_root: projectRoot } : {});
      const ticketProjectRoot = scope.kind === "project" ? projectRoot ?? resolve(knowledgeDirectory, "..", "..") : null;
      const catalog = listKnowledgeScenarios(knowledgeDirectory, scope.id, scope.kind);
      return { kind: "knowledge_scenario_classification", id: claim.id, version: claim.version,
        content_digest: claim.content_digest, scope: claim.scope, catalog_version: catalog.catalog_version,
        ...(ticketProjectRoot ? { project_root: ticketProjectRoot } : {}) };
    }
    if (args.experience_scenario_classification_request_id !== undefined) {
      const requestId = text(args.experience_scenario_classification_request_id, "experience_scenario_classification_request_id");
      const scope = text(args.experience_scenario_classification_scope, "experience_scenario_classification_scope");
      const reference = this.store.get("experience_scenario_classification_request_ref", requestId);
      if (!/^project:[A-Za-z0-9_-]{1,96}$/u.test(scope) || reference.scope !== scope || reference.status !== "awaiting_model") {
        throw new Error("Experience scenario classification ticket requires an awaiting project request");
      }
      return { kind: "experience_scenario_classification_request", id: requestId, version: reference.request_version, scope };
    }
    const request = this.store.get("workflow_evolution_request", text(args.workflow_evolution_request_id, "workflow_evolution_request_id"));
    if (request.lifecycle !== "awaiting_model") throw new Error("Workflow Evolution request is not awaiting a model proposal");
    return { kind: "workflow_evolution_request", id: request.id, version: request.version };
  }
}
