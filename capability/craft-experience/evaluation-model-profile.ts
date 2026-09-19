import { randomUUID } from "node:crypto";
import { canonicalJson, stableDigest } from "../../src/digest.ts";
import { credentialStatus, selectModel, type ModelProviderSpec, type ModelTier } from "../../src/model-gateway.ts";
import { CraftStore, type JsonObject } from "../../src/infrastructure/store.ts";

const PURPOSES = new Set(["evaluation", "workflow_evolution"]);
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

  constructor(store: CraftStore, providers: readonly ModelProviderSpec[], env: NodeJS.ProcessEnv = process.env) {
    this.store = store; this.providers = providers; this.env = env;
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
      api_key_env: spec.api_key_env, temperature, max_output_tokens: integer(args.max_output_tokens, "max_output_tokens", 4_096, 1, 1_000_000),
      max_attempts: integer(args.max_attempts, "max_attempts", 1, 1, 20), purposes: strings(args.purposes, "purposes", ["evaluation", "workflow_evolution"]),
      network_execution_enabled: bool(args.network_execution_enabled, "network_execution_enabled", false),
    };
    const profileId = String(args.profile_id ?? `evaluation_model_profile_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("evaluation_model_profile", profileId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Evaluation Model Profile idempotency conflict"); return { profile: existing, readiness: this.readiness(existing), idempotent: true }; }
    const profile = this.store.create("evaluation_model_profile", profileId, { ...identity, identity_digest: identityDigest, lifecycle: "active", secret_stored: false, execution_authority: "adapter_only" });
    return { profile, readiness: this.readiness(profile), idempotent: false };
  }

  get(args: JsonObject): JsonObject { const profile = this.store.get("evaluation_model_profile", text(args.profile_id, "profile_id"), args.version === undefined ? undefined : integer(args.version, "version", 1, 1, Number.MAX_SAFE_INTEGER)); return { profile, readiness: this.readiness(profile) }; }

  list(args: JsonObject = {}): JsonObject {
    const limit = integer(args.limit, "limit", 100, 1, 1_000);
    return { profiles: this.store.list("evaluation_model_profile", limit).map((profile) => ({ ...profile, readiness: this.readiness(profile) })) };
  }

  issue(args: JsonObject): JsonObject {
    const profile = this.store.get("evaluation_model_profile", text(args.profile_id, "profile_id"));
    if (profile.lifecycle !== "active") throw new Error("Evaluation Model Profile is not active");
    const purpose = text(args.purpose, "purpose"); if (!(profile.purposes as string[]).includes(purpose)) throw new Error("Evaluation Model Profile does not allow this purpose");
    const target = this.target(args, purpose); const inputRef = text(args.input_ref, "input_ref"); const outputContractRef = text(args.output_contract_ref, "output_contract_ref");
    const identity = { profile_id: profile.id, profile_version: profile.version, profile_digest: profile.identity_digest, purpose, target, input_ref: inputRef, output_contract_ref: outputContractRef, content_stored: false, execution_authority: "adapter_only" };
    const ticketId = String(args.ticket_id ?? `evaluation_model_ticket_${stableDigest(identity).slice(-20)}`); const existing = this.store.find("evaluation_model_ticket", ticketId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Evaluation Model Ticket idempotency conflict"); return { ticket: existing, readiness: this.readiness(profile), idempotent: true }; }
    const readiness = this.readiness(profile); const ticket = this.store.create("evaluation_model_ticket", ticketId, { ...identity, identity_digest: identityDigest, status: readiness.status, next_action: readiness.next_action });
    this.store.appendEvent(`evaluation-model:${profile.id}`, "evaluation_model.ticket_issued", { ticket_id: ticket.id, purpose, target_kind: target.kind, target_id: target.id });
    return { ticket, readiness, idempotent: false };
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
    const request = this.store.get("workflow_evolution_request", text(args.workflow_evolution_request_id, "workflow_evolution_request_id"));
    if (request.lifecycle !== "awaiting_model") throw new Error("Workflow Evolution request is not awaiting a model proposal");
    return { kind: "workflow_evolution_request", id: request.id, version: request.version };
  }
}