import type { JsonObject } from "../../infrastructure/store.ts";

/** Translate the legacy Workbench step form, without inventing executable authority. */
export function workbenchWorkflowInput(args: JsonObject): JsonObject {
  const steps = Array.isArray(args.steps) ? args.steps as JsonObject[] : [];
  const nodes = Array.isArray(args.nodes) ? args.nodes : steps.map((step, index) => ({ id: String(step.id ?? `step-${index + 1}`), type: String(step.type ?? "action"), side_effect: String(step.side_effect ?? "read_only"), ...(step.action === undefined ? {} : { action: step.action }), depends_on: Array.isArray(step.depends_on) ? step.depends_on : [] }));
  return { ...args, nodes: nodes.length ? nodes : [{ id: "studio-placeholder", type: "action", side_effect: "read_only", action: "noop", depends_on: [] }] };
}
