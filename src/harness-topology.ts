import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const ROLES = new Set(["primary", "diagnostic_research", "independent_evaluator", "remote_readonly"]);

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${name} must contain at least one value`);
  const result = value.map((item) => text(item, name)); if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`); return result.sort();
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function confirmed(store: CraftStore, ids: string[]): void { for (const id of ids) if (store.get("evidence", id).confidence !== "confirmed") throw new Error("Harness topology requires confirmed Evidence"); }

/** A compact policy module: single-Agent is always the baseline; topology growth is evaluated, bounded and reversible. */
export class HarnessTopologyKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  define(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const roles = strings(args.roles, "roles");
    if (roles.some((role) => !ROLES.has(role)) || !roles.includes("primary")) throw new Error("Harness topology roles are unsupported or missing primary");
    const mode = text(args.mode, "mode"); if (!new Set(["baseline", "candidate"]).has(mode)) throw new Error("Harness topology mode is unsupported");
    if (mode === "baseline" && (roles.length !== 1 || roles[0] !== "primary")) throw new Error("Baseline harness must be single-Agent primary only");
    if (mode === "candidate" && roles.length > 3) throw new Error("Candidate harness may add at most two design axes");
    const maxAgents = args.max_agents === undefined ? roles.length : Number(args.max_agents);
    if (!Number.isInteger(maxAgents) || maxAgents < roles.length || maxAgents > 5) throw new Error("Harness topology max_agents must be between role count and 5");
    const identity = { task_id: task.id, roles, mode, max_agents: maxAgents, context_policy: "reference_only", effect_policy: "read_only_for_delegates" };
    const topologyId = text(args.topology_id, "topology_id"); const topologyDigest = digest(identity); const existing = this.store.find("harness_topology", topologyId);
    if (existing) { if (existing.topology_digest !== topologyDigest) throw new Error("Harness topology idempotency conflict"); return { topology: existing, idempotent: true }; }
    return { topology: this.store.create("harness_topology", topologyId, { ...identity, topology_digest: topologyDigest, lifecycle: mode === "baseline" ? "active" : "shadow_only" }), idempotent: false };
  }

  promote(args: JsonObject): JsonObject {
    const topology = this.store.get("harness_topology", text(args.topology_id, "topology_id"));
    if (topology.mode !== "candidate") throw new Error("Only candidate harness topology can be promoted");
    const evaluation = this.store.get("delivery_evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
    if (evaluation.status !== "eligible_for_signoff") throw new Error("Harness topology requires an eligible paired evaluation");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids"); confirmed(this.store, evidenceIds);
    if (topology.lifecycle === "routing_eligible") return { topology, idempotent: true };
    if (topology.lifecycle !== "shadow_only") throw new Error("Harness topology is not promotable");
    return { topology: this.store.save("harness_topology", String(topology.id), { ...payload(topology), lifecycle: "routing_eligible", evaluation_run_id: evaluation.id, evaluation_run_version: evaluation.version, evidence_ids: evidenceIds }), idempotent: false };
  }

  select(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const baseline = this.store.get("harness_topology", text(args.baseline_topology_id, "baseline_topology_id"));
    if (baseline.task_id !== task.id || baseline.mode !== "baseline" || baseline.lifecycle !== "active") throw new Error("Harness baseline is not active for this task");
    const candidates = this.store.list("harness_topology", 1000, (item) => item.task_id === task.id && item.mode === "candidate" && item.lifecycle === "routing_eligible").sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const chosen = candidates[0] ?? baseline; const identity = { task_id: task.id, baseline_topology_id: baseline.id, baseline_version: baseline.version, selected_topology_id: chosen.id, selected_version: chosen.version };
    const selectionId = String(args.selection_id ?? `harness_topology_selection_${digest(identity).slice(-16)}`); const existing = this.store.find("harness_topology_selection", selectionId); const selectionDigest = digest(identity);
    if (existing) { if (existing.selection_digest !== selectionDigest) throw new Error("Harness topology selection idempotency conflict"); return { selection: existing, topology: chosen, idempotent: true }; }
    return { selection: this.store.create("harness_topology_selection", selectionId, { ...identity, selection_digest: selectionDigest, reason: chosen.id === baseline.id ? "single_agent_baseline" : "evaluated_candidate" }), topology: chosen, idempotent: false };
  }

  suspend(args: JsonObject): JsonObject {
    const topology = this.store.get("harness_topology", text(args.topology_id, "topology_id")); if (topology.mode !== "candidate") throw new Error("Baseline harness topology cannot be suspended");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids"); confirmed(this.store, evidenceIds);
    if (topology.lifecycle === "suspended") return { topology, idempotent: true };
    return { topology: this.store.save("harness_topology", String(topology.id), { ...payload(topology), lifecycle: "suspended", suspension_reason: text(args.reason, "reason"), suspension_evidence_ids: evidenceIds }), idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { topology: this.store.get("harness_topology", text(args.topology_id, "topology_id")) }; }
}
