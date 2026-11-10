import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { object, text } from "../../common/craft-common-base/src/validation.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";

type Record = JsonObject;
function rows(value: unknown, name: string): Record[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error(`${name} requires 1..100 entries`);
  const result = value.map(item => object(item, name));
  const ids = result.map(item => text(item.id, `${name}.id`));
  if (new Set(ids).size !== ids.length || ids.some(id => !/^[a-zA-Z0-9_-]+$/u.test(id))) throw new Error(`${name} ids must be unique identifiers`);
  return result;
}
function names(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some(x => typeof x !== "string" || !/^[a-zA-Z0-9_-]+$/u.test(x)) || new Set(value).size !== value.length) throw new Error(`${name} requires bounded unique identifiers`);
  return value as string[];
}
function bound(value: unknown, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${name} requires 1..${max}`);
  return Number(value);
}

/** Runtime contract above the existing graph format. Subscenarios constrain a shared graph. */
export function validateGraphControl(raw: unknown, rawNodes: unknown, rawEdges: unknown): JsonObject {
  const { content_digest: _digest, ...control } = object(raw, "graph_control"); text(control.scenario_id, "scenario_id"); text(control.title, "scenario title");
  const nodes = rows(rawNodes, "nodes"), edges = rows(rawEdges, "edges");
  const entries = rows(control.entries, "entries"), exits = rows(control.exits, "exits"), scenarios = rows(control.subscenarios, "subscenarios");
  const nodeIds = new Set(nodes.map(n => n.id));
  for (const node of nodes) {
    if (!["action", "condition", "human_gate", "subworkflow"].includes(String(node.type))) throw new Error("Runtime graph nodes must be action, condition, human_gate or subworkflow");
    if (!["read_only", "local_write"].includes(String(node.side_effect))) throw new Error("Graph effects require a supported Host adapter");
    names(node.requires, "node.requires"); names(node.provides, "node.provides"); text(node.acceptance_ref, "node.acceptance_ref");
    if (node.type === "subworkflow") {
      text(node.procedure_id, "node.procedure_id"); bound(node.procedure_version, "procedure_version", Number.MAX_SAFE_INTEGER);
      text(node.definition_digest, "definition_digest"); text(node.entry_id, "child entry"); text(node.exit_id, "child exit");
      object(node.input_bindings, "input_bindings"); object(node.output_bindings, "output_bindings");
    }
  }
  for (const entry of entries) { if (!nodeIds.has(entry.node_id)) throw new Error("Unknown entry node"); names(entry.required_inputs, "entry.required_inputs"); names(entry.preconditions, "entry.preconditions"); }
  for (const exit of exits) {
    const node = nodes.find(n => n.id === exit.node_id);
    if (!node) throw new Error("Unknown exit node"); names(exit.required_outputs, "exit.required_outputs"); text(exit.acceptance_ref, "exit.acceptance_ref");
    if (node.type !== "action" || node.side_effect !== "read_only" || (node.provides as string[]).length || stableDigest([...(node.requires as string[])].sort()) !== stableDigest([...(exit.required_outputs as string[])].sort()) || node.acceptance_ref !== exit.acceptance_ref) throw new Error("Exit node must be a read-only acceptance of declared outputs");
  }
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || !["success", "failure", "condition", "retry", "human_resume", "compensation"].includes(String(edge.kind))) throw new Error("Invalid graph edge");
    if (nodes.find(n => n.id === edge.from)!.type === "human_gate" && !["human_resume", "compensation"].includes(String(edge.kind))) throw new Error("Human gate requires an explicit human-resume edge");
    bound(edge.max_traversals, "edge.max_traversals", 100);
    if (["condition", "human_resume"].includes(String(edge.kind))) text(edge.predicate_ref, "edge.predicate_ref");
    if (edge.kind === "compensation") text(edge.compensation_ref, "edge.compensation_ref");
    if (edge.rework !== undefined && typeof edge.rework !== "boolean") throw new Error("edge.rework must be boolean");
  }
  for (const scenario of scenarios) {
    text(scenario.title, "subscenario.title");
    const entry = entries.find(x => x.id === scenario.entry_id), exit = exits.find(x => x.id === scenario.exit_id);
    const allowedNodes = names(scenario.allowed_nodes, "allowed_nodes"), allowedEdges = names(scenario.allowed_edges, "allowed_edges");
    if (!entry || !exit || !allowedNodes.includes(String(entry.node_id)) || !allowedNodes.includes(String(exit.node_id)) || allowedNodes.some(id => !nodeIds.has(id))) throw new Error("Subscenario entry/exit/nodes are invalid");
    const selected = allowedEdges.map(id => edges.find(e => e.id === id));
    if (selected.some(e => !e || !allowedNodes.includes(String(e.from)) || !allowedNodes.includes(String(e.to)))) throw new Error("Subscenario edges escape allowed nodes");
    const reachable = new Set([String(entry.node_id)]);
    for (let i = 0; i < nodes.length; i++) for (const edge of selected as Record[]) if (reachable.has(String(edge.from))) reachable.add(String(edge.to));
    if (!reachable.has(String(exit.node_id)) || allowedNodes.some(id => !reachable.has(id))) throw new Error("Subscenario contains unreachable nodes or exit");
    const effects = names(scenario.allowed_effects, "allowed_effects");
    if (allowedNodes.some(id => !effects.includes(String(nodes.find(n => n.id === id)!.side_effect)))) throw new Error("Subscenario effect denied");
    bound(scenario.max_transitions, "max_transitions", 500); bound(scenario.max_visits, "max_visits", 100);
    object(scenario.parameters ?? {}, "parameters");
  }
  return { ...control, entries, exits, subscenarios: scenarios, content_digest: stableDigest({ ...control, nodes, edges }) };
}

export function selectGraph(raw: JsonObject, selection: JsonObject): JsonObject {
  const control = validateGraphControl(raw.graph_control, raw.nodes, raw.edges);
  const scenario = (control.subscenarios as Record[]).find(x => x.id === selection.subscenario_id);
  if (!scenario || scenario.entry_id !== selection.entry_id || scenario.exit_id !== selection.exit_id) throw new Error("Select a declared subscenario with its exact entry and exit");
  const entry = (control.entries as Record[]).find(x => x.id === scenario.entry_id)!;
  const exit = (control.exits as Record[]).find(x => x.id === scenario.exit_id)!;
  return { control, scenario, entry, exit, nodes: (raw.nodes as Record[]).filter(n => (scenario.allowed_nodes as string[]).includes(String(n.id))), edges: (raw.edges as Record[]).filter(e => (scenario.allowed_edges as string[]).includes(String(e.id))) };
}
