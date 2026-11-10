import type { CraftStore, JsonObject } from "../infrastructure/store.ts";
import { payload, stableDigest } from "../digest.ts";
import { object, text } from "../validation.ts";
import { lowerInvocationPlan, type Item, type Node } from "./procedure-work-items.ts";

type Segment = { nodes: Node[]; items: Item[]; output_keys: Record<string, string>; input_keys: string[] };
function segment(plan: JsonObject, node: JsonObject, bindings: Record<string, string>, round: number): Segment {
  const required = node.requires as string[];
  if (required.some(key => !bindings[key])) throw new Error(`Graph node ${node.id} has missing or invalidated inputs`);
  const path = `root/g${round}`;
  const prepared = lowerInvocationPlan({ ...plan, graph: undefined, steps: [node], precondition_evidence: [], parallel_groups: [] }, Object.fromEntries(required.map(key => [key, bindings[key]!])), path, false);
  for (const item of prepared.items) item.entry_paths.unshift("root");
  const outputKeys = Object.fromEntries((node.provides as string[]).map(key => [key, `${path}:output:${key}`]));
  return { ...prepared, output_keys: outputKeys, input_keys: required.map(key => bindings[key]!) };
}
function rootPlan(plan: JsonObject, bindings: Record<string, string>): Node {
  return { ...plan, path: "root", input_keys: bindings, precondition_evidence: plan.precondition_evidence as JsonObject[] };
}
function marker(plan: JsonObject, bindings: Record<string, string>): Item {
  const exit = plan.exit as JsonObject;
  const inputKeys = Object.fromEntries((exit.required_outputs as string[]).map(key => [key, bindings[key] ?? `unavailable:${key}`]));
  const value = { id: "root/$exit", node_path: "root", entry_paths: ["root"], kind: "exit", input_keys: inputKeys, output_keys: {}, depends_on: [], instruction: exit, effect: "read_only", acceptance_ref: exit.acceptance_ref };
  return { ...value, acceptance_digest: stableDigest(value) };
}
export function graphInitial(plan: JsonObject, inputs: Record<string, string>): { nodes: Node[]; items: Item[]; graph_state: JsonObject } {
  const graph = plan.graph as JsonObject, entry = graph.entry as JsonObject;
  const bindings = Object.fromEntries(Object.keys(inputs).map(key => [key, `root:input:${key}`]));
  const node = (graph.nodes as JsonObject[]).find(node => node.id === entry.node_id)!;
  if (node.id === (graph.exit as JsonObject).node_id) throw new Error("Graph entry must precede its delivery exit");
  const initial = segment(plan, node, bindings, 0);
  return { nodes: [rootPlan(plan, bindings), ...initial.nodes], items: [...initial.items, marker(plan, {})], graph_state: {
    active_node: node.id, round: 0, bindings, visits: { [String(node.id)]: 1 }, traversals: {}, transitions: 0,
    segments: [{ node_id: node.id, item_keys: initial.items.map(item => item.id), output_keys: initial.output_keys, input_keys: initial.input_keys }],
  } };
}

/** Expands graph decisions into the same durable ledger. It neither executes nor invents evidence. */
export class GraphInvocationProgress {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  transition(run: JsonObject, args: JsonObject, validateCurrent: () => void): JsonObject {
    if (!run.graph) throw new Error("Invocation has no runtime Graph");
    const graph = run.graph as JsonObject, state = object(run.graph_state, "graph_state"), scenario = graph.scenario as JsonObject;
    const id = `${run.id}:${text(args.transition_id, "transition_id")}`;
    const requestDigest = stableDigest({ ...args, expected_version: null });
    const previous = this.store.find("procedure_graph_transition", id);
    if (previous) { if (previous.request_digest !== requestDigest) throw new Error("Graph transition idempotency conflict"); return { invocation: run, transition: previous, idempotent: true, host_execution_authority: false }; }
    validateCurrent();
    if (state.active_node === null) throw new Error("Graph already reached its selected exit");
    const edge = (graph.edges as JsonObject[]).find(item => item.id === args.edge_id && item.from === state.active_node);
    if (!edge) throw new Error("Edge is outside the subscenario or current node");
    if (edge.kind === "compensation") throw new Error("External compensation requires an authorized Host adapter; handoff required");
    const loop = this.store.get("durable_action_loop", String(run.action_loop_id));
    if (loop.lifecycle !== "active") throw new Error("Graph loop requires replan");
    if (this.store.list("durable_action", 1, a => a.action_loop_id === loop.id && ["proposed", "dispatched"].includes(String(a.lifecycle))).length) throw new Error("Reconcile in-flight graph actions before transitioning");
    const segments = (state.segments as JsonObject[]).map(s => ({ ...s })), active = segments[segments.length - 1]!;
    const activeItems = (active.item_keys as string[]).map(key => this.store.get("durable_work_item", `${loop.id}:${key}`));
    const receipt = this.store.get("procedure_invocation_receipt", text(args.receipt_id, "receipt_id"));
    if (receipt.invocation_id !== run.id || !(active.item_keys as string[]).includes(String(receipt.item_key)) || receipt.id !== run.last_receipt_id) throw new Error("Graph decision requires the latest current-attempt receipt");
    const passed = activeItems.every(item => item.status === "verified");
    if (["success", "condition"].includes(String(edge.kind)) && !passed || ["failure", "retry"].includes(String(edge.kind)) && receipt.status !== "failed") throw new Error("Edge does not match verified node outcome");
    const snapshot = this.store.get("state_snapshot", text(args.snapshot_id, "snapshot_id"));
    if (snapshot.workspace_id !== run.workspace_id || snapshot.snapshot_digest !== loop.latest_snapshot_digest || snapshot.workspace_state_revision !== this.store.get("state_snapshot", String(loop.latest_snapshot_id)).workspace_state_revision) throw new Error("Graph decision snapshot drifted; replan required");
    const proof = this.store.get("evidence", text(args.evidence_id, "evidence_id")), meta = object(proof.metadata, "transition Evidence metadata");
    if (proof.confidence !== "confirmed" || proof.source_type !== (edge.kind === "human_resume" ? "human" : "program")
      || meta.scope !== run.scope || meta.invocation_id !== run.id || meta.receipt_id !== receipt.id || meta.graph_state_digest !== stableDigest(state)
      || meta.snapshot_digest !== snapshot.snapshot_digest || meta.workspace_state_revision !== snapshot.workspace_state_revision
      || !Number.isFinite(Date.parse(String(meta.expires_at))) || Date.parse(String(meta.expires_at)) <= Date.now()) throw new Error("Graph decision Evidence is stale or mismatched");
    if (stableDigest(meta.matched_edge_ids) !== stableDigest([edge.id]) || meta.result !== true
      || (["condition", "human_resume"].includes(String(edge.kind)) && meta.predicate_ref !== edge.predicate_ref)) throw new Error("Graph branch is unknown or ambiguous");
    const traversals = { ...object(state.traversals, "traversals") }, visits = { ...object(state.visits, "visits") };
    if (Number(state.transitions) >= Number(scenario.max_transitions) || Number(traversals[String(edge.id)] ?? 0) >= Number(edge.max_traversals)
      || Number(visits[String(edge.to)] ?? 0) >= Number(scenario.max_visits) || Number(run.dispatch_count) >= Number(run.max_dispatches)) throw new Error("Graph transition or visit budget exhausted; handoff required");
    const rework = edge.rework === true || edge.kind === "retry";
    if (visits[String(edge.to)] && !rework && segments.some(s => s.node_id === edge.to && !s.invalidated_by)) throw new Error("Revisiting a node requires an explicit rework edge");
    if (rework && meta.safe_to_retry !== true) throw new Error("Rework requires confirmed safe target state");
    const invalid = new Set<string>();
    for (const record of segments) {
      if (rework && (record.node_id === edge.to || (record.input_keys as string[]).some(key => invalid.has(key))) || record === active && !passed) {
        for (const key of Object.values(record.output_keys as JsonObject)) invalid.add(String(key));
        for (const key of record.item_keys as string[]) {
          const item = this.store.get("durable_work_item", `${loop.id}:${key}`);
          this.store.save("durable_work_item", String(item.id), { ...payload(item), status: "superseded", superseded_by_transition: id });
        }
        record.invalidated_by = id;
      }
    }
    const root = (run.nodes as Node[]).find(node => node.path === "root")!;
    // Rebuild names from accepted history after invalidation. A node may refine
    // an existing artifact name; deleting its output must reveal the prior
    // accepted version rather than discard that node's original input.
    const bindings = { ...root.input_keys } as Record<string, string>;
    for (const record of segments) if (!record.invalidated_by && (record.item_keys as string[]).every(key => this.store.get("durable_work_item", `${loop.id}:${key}`).status === "verified")) Object.assign(bindings, record.output_keys);
    const round = Number(state.round) + 1, target = (graph.nodes as JsonObject[]).find(node => node.id === edge.to)!;
    const ending = edge.to === (graph.exit as JsonObject).node_id;
    let newItems: Item[], newNodes: Node[] = [];
    if (ending) {
      if (((graph.exit as JsonObject).required_outputs as string[]).some(key => !bindings[key])) throw new Error("Graph exit has missing or invalidated outputs");
      const exit = marker(root, bindings); newItems = [exit];
      const held = this.store.get("durable_work_item", `${loop.id}:root/$exit`);
      this.store.save("durable_work_item", String(held.id), { ...payload(held), status: "pending", acceptance_digest: exit.acceptance_digest });
    } else {
      const next = segment(root, target, bindings, round); newItems = next.items; newNodes = next.nodes;
      if ((run.items as Item[]).length + newItems.length > 10_000) throw new Error("Graph work item history budget exhausted; handoff required");
      segments.push({ node_id: target.id, item_keys: next.items.map(item => item.id), output_keys: next.output_keys, input_keys: next.input_keys });
      for (const item of newItems) this.store.create("durable_work_item", `${loop.id}:${item.id}`, { action_loop_id: loop.id, item_key: item.id, depends_on: item.depends_on, acceptance_digest: item.acceptance_digest, effect: item.effect, status: "pending" });
    }
    traversals[String(edge.id)] = Number(traversals[String(edge.id)] ?? 0) + 1; visits[String(edge.to)] = Number(visits[String(edge.to)] ?? 0) + 1;
    const nextState = { ...state, active_node: ending ? null : edge.to, round, bindings, visits, traversals, transitions: Number(state.transitions) + 1, segments };
    const transition = this.store.create("procedure_graph_transition", id, { invocation_id: run.id, request_digest: requestDigest, edge_id: edge.id, from: edge.from, to: edge.to, rework, invalidated_artifact_keys: [...invalid], receipt_id: receipt.id, evidence_id: proof.id, previous_state_digest: stableDigest(state), state_digest: stableDigest(nextState), round });
    const updated = this.store.save("procedure_invocation", String(run.id), { ...payload(run), graph_state: nextState, lifecycle: "active", recovery_action: null,
      nodes: [...run.nodes as Node[], ...newNodes], items: [...(run.items as Item[]).filter(item => !newItems.some(next => next.id === item.id)), ...newItems] });
    return { invocation: updated, transition, idempotent: false, host_execution_authority: false };
  }
}
