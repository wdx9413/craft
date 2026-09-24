import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import type { WorkflowDagKernel } from "./workflow-dag.ts";

export interface CompiledPlan {
  readonly plan_id: string;
  readonly graph_digest: string;
  readonly steps: readonly JsonObject[];
  readonly dependencies: readonly JsonObject[];
  readonly analysis: JsonObject;
  readonly executable_by: "verified_work_loop";
  readonly automation_authority: false;
}

function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function id(value: unknown): string { return value === undefined ? `plan_${randomUUID().replaceAll("-", "")}` : String(value); }

/** Lowers a validated Graph into a plan description; it never runs a Host. */
export class GraphCompilerKernel {
  readonly validator: WorkflowDagKernel;
  constructor(validator: WorkflowDagKernel) { this.validator = validator; }

  compile(args: JsonObject): JsonObject {
    const validated = this.validator.validate(args);
    const nodes = validated.nodes as JsonObject[]; const edges = validated.edges as JsonObject[];
    const retries = nodes.filter((node) => node.type === "retry").length + edges.filter((edge) => edge.kind === "retry").length;
    const compensations = nodes.filter((node) => node.type === "compensation").length + edges.filter((edge) => edge.kind === "compensation").length;
    const humanGates = nodes.filter((node) => node.type === "human_gate").length + edges.filter((edge) => edge.kind === "human_resume").length;
    const effects = [...new Set(nodes.map((node) => String(node.side_effect)))].sort();
    const plan: CompiledPlan = { plan_id: id(args.plan_id), graph_digest: digest(validated), steps: nodes.map((node) => ({ id: node.id, title: node.title ?? node.id, objective: node.objective ?? node.action ?? node.type, depends_on: node.depends_on, side_effect: node.side_effect, bounded_retry: node.type === "retry" ? Number(node.max_attempts) : null })), dependencies: edges,
      analysis: { node_count: nodes.length, edge_count: edges.length, retry_count: retries, compensation_count: compensations, human_gate_count: humanGates, effects, cycle_policy: "bounded_only" }, executable_by: "verified_work_loop", automation_authority: false };
    return { plan, validated_graph: validated, static_validation: "passed", host_dispatch: "not_performed" };
  }
}
