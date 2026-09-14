import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const OUTCOMES = new Set(["passed", "failed", "inconclusive"]);
const AXES = new Set(["context", "tools", "generation", "orchestration", "memory", "output"]);
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); const result = value.trim(); if (SECRET.test(result)) throw new Error(`${name} must not contain credentials or secrets`); return result; }
function strings(value: unknown, name: string, minimum = 0): string[] { if (!Array.isArray(value)) throw new Error(`${name} must be an array`); const result = value.map((item) => text(item, name)); if (result.length < minimum || new Set(result).size !== result.length) throw new Error(`${name} must contain ${minimum ? `at least ${minimum} unique values` : "unique values"}`); return result.sort(); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as JsonObject).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }

/**
 * Turns multiple *sanitized* execution observations into a bounded proposal
 * request. It deliberately does not create, promote, or execute a Workflow:
 * CraftService binds a returned proposal to the existing Workflow/Gate model.
 */
export class WorkflowEvolutionKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  observe(args: JsonObject): JsonObject {
    if (args.sanitized !== true || args.content_stored === true) throw new Error("Workflow Evolution observations must be sanitized and content-free");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids", 1); for (const evidenceId of evidenceIds) this.assertEvidence(evidenceId);
    const outcome = text(args.outcome, "outcome"); if (!OUTCOMES.has(outcome)) throw new Error("Workflow Evolution outcome is unsupported");
    const source = { kind: text(args.source_kind, "source_kind"), id: text(args.source_id, "source_id"), digest: text(args.source_digest, "source_digest") };
    const identity = { scenario_key: text(args.scenario_key, "scenario_key"), source, outcome, failure_type: args.failure_type === undefined ? null : text(args.failure_type, "failure_type"), evidence_ids: evidenceIds, sanitized: true, content_stored: false };
    const observationId = String(args.observation_id ?? `workflow_evolution_observation_${digest(identity).slice(-20)}`); const existing = this.store.find("workflow_evolution_observation", observationId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Workflow Evolution observation idempotency conflict"); return { observation: existing, idempotent: true }; }
    const observation = this.store.create("workflow_evolution_observation", observationId, { ...identity, identity_digest: identityDigest, lifecycle: "accepted" });
    this.store.appendEvent(`workflow-evolution:${identity.scenario_key}`, "workflow_evolution.observed", { observation_id: observation.id, outcome });
    return { observation, idempotent: false };
  }

  propose(args: JsonObject): JsonObject {
    const scenarioKey = text(args.scenario_key, "scenario_key"); const selectedIds = args.observation_ids === undefined ? null : strings(args.observation_ids, "observation_ids", 2);
    const observations = (selectedIds === null ? this.store.list("workflow_evolution_observation", 10_000, (item) => item.scenario_key === scenarioKey && item.lifecycle === "accepted") : selectedIds.map((id) => this.store.get("workflow_evolution_observation", id)))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    if (observations.length < 2) throw new Error("Workflow Evolution requires at least two observations");
    if (observations.some((item) => item.scenario_key !== scenarioKey || item.lifecycle !== "accepted")) throw new Error("Workflow Evolution observations do not match the scenario");
    if (new Set(observations.map((item) => `${(item.source as JsonObject).kind}:${(item.source as JsonObject).id}:${(item.source as JsonObject).digest}`)).size < 2) throw new Error("Workflow Evolution requires independent source records");
    const axes = strings(args.design_axes, "design_axes", 1); if (axes.length > 2 || axes.some((axis) => !AXES.has(axis))) throw new Error("Workflow Evolution may change at most two supported design axes");
    const identity = { scenario_key: scenarioKey, observation_refs: observations.map((item) => ({ id: item.id, version: item.version, source: item.source, outcome: item.outcome, evidence_ids: item.evidence_ids })), hypothesis: text(args.hypothesis, "hypothesis"), design_axes: axes, output_contract_ref: text(args.output_contract_ref, "output_contract_ref"), lifecycle: "awaiting_model", content_stored: false };
    const requestId = String(args.request_id ?? `workflow_evolution_request_${digest(identity).slice(-20)}`); const existing = this.store.find("workflow_evolution_request", requestId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Workflow Evolution request idempotency conflict"); return { request: existing, idempotent: true }; }
    const request = this.store.create("workflow_evolution_request", requestId, { ...identity, identity_digest: identityDigest });
    this.store.appendEvent(`workflow-evolution:${scenarioKey}`, "workflow_evolution.proposed", { request_id: request.id, observation_count: observations.length });
    return { request, idempotent: false, next_action: "issue_a_model_ticket_or_submit_a_host_distilled_workflow_draft" };
  }

  submit(args: JsonObject): JsonObject {
    const request = this.store.get("workflow_evolution_request", text(args.request_id, "request_id"));
    const explicitProposalId = args.proposal_id === undefined ? null : text(args.proposal_id, "proposal_id");
    const prior = explicitProposalId === null ? null : this.store.find("workflow_evolution_proposal", explicitProposalId);
    if (prior) {
      if (prior.request_id !== request.id) throw new Error("Workflow Evolution proposal idempotency conflict");
      return { proposal: prior, request, idempotent: true };
    }
    const ticketId = args.model_ticket_id === undefined ? null : text(args.model_ticket_id, "model_ticket_id");
    if (ticketId) {
      const ticket = this.store.get("evaluation_model_ticket", ticketId);
      if (ticket.purpose !== "workflow_evolution") throw new Error("Model Ticket is not a Workflow Evolution ticket");
      const target = ticket.target as JsonObject;
      if (target.id !== request.id || Number(target.version) !== Number(request.version)) throw new Error("Model Ticket does not belong to this Workflow Evolution request");
    }
    const replacement = args.replaces_workflow_id === undefined ? null : this.store.get("workflow", text(args.replaces_workflow_id, "replaces_workflow_id"));
    const identity = { request_id: request.id, request_version: request.version, model_ticket_id: ticketId, workflow_id: text(args.workflow_id, "workflow_id"), name: text(args.name, "name"), description: text(args.description, "description"), inputs: strings(args.inputs ?? [], "inputs"), steps: args.steps, replaces_workflow: replacement === null ? null : { id: replacement.id, version: replacement.version }, lifecycle: "draft" };
    if (!Array.isArray(identity.steps) || !identity.steps.length) throw new Error("steps must be a non-empty array");
    const proposalId = String(args.proposal_id ?? `workflow_evolution_proposal_${digest(identity).slice(-20)}`); const identityDigest = digest(identity);
    if (request.lifecycle !== "awaiting_model") throw new Error("Workflow Evolution request is no longer awaiting a proposal");
    const proposal = this.store.create("workflow_evolution_proposal", proposalId, { ...identity, identity_digest: identityDigest, publication_allowed: false });
    const savedRequest = this.store.save("workflow_evolution_request", String(request.id), { ...payload(request), lifecycle: "draft_submitted", proposal_id: proposal.id, proposal_version: proposal.version });
    this.store.appendEvent(`workflow-evolution:${request.scenario_key}`, "workflow_evolution.draft_submitted", { request_id: request.id, proposal_id: proposal.id });
    return { proposal, request: savedRequest, idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { proposal: this.store.get("workflow_evolution_proposal", text(args.proposal_id, "proposal_id")), request: args.request_id === undefined ? null : this.store.get("workflow_evolution_request", text(args.request_id, "request_id")) }; }
  observations(args: JsonObject = {}): JsonObject { const scenario = args.scenario_key === undefined ? null : text(args.scenario_key, "scenario_key"); return { observations: this.store.list("workflow_evolution_observation", Number(args.limit ?? 100), (item) => scenario === null || item.scenario_key === scenario) }; }
  private assertEvidence(id: string): void { const evidence = this.store.get("evidence", id); if (!new Set(["confirmed", "bounded"]).has(String(evidence.confidence))) throw new Error("Workflow Evolution Evidence must be confirmed or bounded"); }
}
