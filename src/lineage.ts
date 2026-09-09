import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const ENTITY_KINDS = new Set(["work_object", "artifact", "evidence", "memory_item", "trial", "outcome",
  "workflow", "capability", "speculative_candidate", "external_effect"]);
const ACTORS = new Set(["program", "model", "human", "workflow", "agent", "external_system"]);
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim();
}
function integer(value: unknown, name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}`); return result;
}
function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as JsonObject;
}
function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`); return value;
}
function locator(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  const result = text(value, name); if (result.length > 512) throw new Error(`${name} is too long`); return result;
}
function key(ref: JsonObject): string { return `${ref.kind}:${ref.id}:v${ref.version}:${ref.locator ?? ""}`; }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export class LineageKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  private reference(value: unknown, name: string, workspaceId: string, taskId: string | null): JsonObject {
    const input = object(value, name); const kind = text(input.kind, `${name}.kind`);
    if (!ENTITY_KINDS.has(kind)) throw new Error(`${name}.kind is unsupported`);
    const id = text(input.id, `${name}.id`); const version = integer(input.version, `${name}.version`, 0);
    const record = this.store.get(kind, id, version);
    if (kind === "work_object" && record.workspace_id !== workspaceId) throw new Error(`${name} work object belongs to another workspace`);
    if (taskId && record.task_id && record.task_id !== taskId) throw new Error(`${name} belongs to another task`);
    return { kind, id, version, locator: locator(input.locator, `${name}.locator`) };
  }

  record(args: JsonObject): JsonObject {
    const workspace = this.store.get("workspace", text(args.workspace_id, "workspace_id"));
    const task = args.task_id === undefined ? null : this.store.get("task", text(args.task_id, "task_id"));
    const output = this.reference(args.output, "output", String(workspace.id), task ? String(task.id) : null);
    const inputs = array(args.sources, "sources").map((item, index) => this.reference(item, `sources[${index}]`, String(workspace.id), task ? String(task.id) : null));
    if (!inputs.length || new Set(inputs.map(key)).size !== inputs.length) throw new Error("inputs must contain unique source references");
    if (inputs.some((input) => key(input) === key(output))) throw new Error("Lineage output cannot directly depend on itself");
    const evidenceIds = array(args.evidence_ids, "evidence_ids").map((item) => text(item, "evidence_id"));
    if (!evidenceIds.length || new Set(evidenceIds).size !== evidenceIds.length) throw new Error("evidence_ids must contain unique Evidence");
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const actorType = text(args.actor_type, "actor_type"); if (!ACTORS.has(actorType)) throw new Error("actor_type is unsupported");
    const transform = args.transform === undefined ? null : this.reference(args.transform, "transform", String(workspace.id), task ? String(task.id) : null);
    const outputKey = key(output); const existingOutput = this.store.list("lineage_edge", 10_000,
      (edge) => edge.workspace_id === workspace.id && edge.output_key === outputKey)[0];
    const identity = { workspace_id: workspace.id, task_id: task?.id ?? null, output, inputs, transform,
      actor_type: actorType, evidence_ids: evidenceIds, summary: text(args.summary, "summary") };
    if (existingOutput) {
      if (existingOutput.statement_digest !== digest(identity)) throw new Error("Lineage output already has a different derivation");
      return { lineage: existingOutput, idempotent: true };
    }
    const adjacency = this.store.list("lineage_edge", 10_000, (edge) => edge.workspace_id === workspace.id);
    const pending = [outputKey]; const reachable = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!; if (reachable.has(current)) continue; reachable.add(current);
      for (const edge of adjacency) if ((edge.input_keys as string[]).includes(current)) pending.push(String(edge.output_key));
    }
    if (inputs.some((input) => reachable.has(key(input)))) throw new Error("Lineage references would form a cycle");
    const lineageId = String(args.lineage_id ?? `lineage_${digest(identity)}`);
    const lineage = this.store.create("lineage_edge", lineageId, { ...identity, output_key: outputKey,
      input_keys: inputs.map(key), statement_digest: digest(identity), immutable: true });
    return { lineage, idempotent: false };
  }

  trace(args: JsonObject): JsonObject {
    const workspace = this.store.get("workspace", text(args.workspace_id, "workspace_id"));
    const direction = String(args.direction ?? "upstream"); if (!new Set(["upstream", "downstream"]).has(direction)) throw new Error("Lineage direction is unsupported");
    const start = this.reference(args.entity, "entity", String(workspace.id), null); const startKey = key(start);
    const maxDepth = integer(args.max_depth, "max_depth", 8, 1, 20); const edges = this.store.list("lineage_edge", 10_000,
      (edge) => edge.workspace_id === workspace.id); const selected: JsonObject[] = []; const seenEdges = new Set<string>();
    let frontier = new Set([startKey]); const nodes = new Set(frontier);
    for (let depth = 0; depth < maxDepth && frontier.size; depth += 1) {
      const next = new Set<string>();
      for (const edge of edges) {
        const matches = direction === "upstream" ? frontier.has(String(edge.output_key))
          : (edge.input_keys as string[]).some((input) => frontier.has(input));
        if (!matches || seenEdges.has(String(edge.id))) continue;
        seenEdges.add(String(edge.id)); selected.push(edge);
        const targets = direction === "upstream" ? edge.input_keys as string[] : [String(edge.output_key)];
        for (const target of targets) if (!nodes.has(target)) { nodes.add(target); next.add(target); }
      }
      frontier = next;
    }
    return { workspace_id: workspace.id, direction, start, node_keys: [...nodes].sort(), edges: selected, truncated: frontier.size > 0 };
  }

  verify(args: JsonObject): JsonObject {
    const lineage = this.store.get("lineage_edge", text(args.lineage_id, "lineage_id")); const issues: JsonObject[] = [];
    const references = [["output", lineage.output], ...((lineage.inputs as JsonObject[]).map((item) => ["input", item]))] as [string, JsonObject][];
    if (lineage.transform) references.push(["transform", lineage.transform as JsonObject]);
    for (const [role, ref] of references) {
      const exact = this.store.find(String(ref.kind), String(ref.id), Number(ref.version)); const latest = this.store.find(String(ref.kind), String(ref.id));
      if (!exact) issues.push({ role, key: key(ref), issue: "missing_exact_version" });
      else if (latest && Number(latest.version) !== Number(ref.version)) issues.push({ role, key: key(ref), issue: "newer_version_exists", latest_version: latest.version });
    }
    for (const evidenceId of lineage.evidence_ids as string[]) if (!this.store.find("evidence", evidenceId)) issues.push({ role: "evidence", id: evidenceId, issue: "missing" });
    return { lineage, valid: issues.length === 0, issues };
  }
}
