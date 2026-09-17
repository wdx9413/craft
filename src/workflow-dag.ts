import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "./store.ts";

const NODE_TYPES = new Set(["action", "condition", "parallel", "human_gate", "retry", "compensation", "subworkflow"]);
const EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive"]);
const LIFECYCLE = new Set(["draft", "candidate", "verified", "canary", "routable", "deprecated", "rolled_back"]);
const SECRET = /(?:api[_-]?key|authorization|cookie|password|passwd|secret|token)\s*[:=]\s*[^\s]{6,}/iu;
function id(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function text(v: unknown, name: string): string { if (typeof v !== "string" || !v.trim()) throw new Error(`${name} must not be empty`); return v.trim(); }
function digest(v: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(v)).digest("hex")}`; }
function payload(r: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...p } = r; return p; }

export type WorkflowNode = JsonObject & { id: string; type: string; depends_on: string[]; side_effect: string };
export class WorkflowDagKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  validate(args: JsonObject): JsonObject {
    const nodes = args.nodes; if (!Array.isArray(nodes) || !nodes.length) throw new Error("nodes must contain at least one node");
    const seen = new Set<string>(); const normalized: WorkflowNode[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const raw = nodes[i];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`nodes[${i}] must be an object`); const n = raw as JsonObject;
      const nodeId = text(n.id, `nodes[${i}].id`); if (seen.has(nodeId)) throw new Error(`duplicate node id: ${nodeId}`); seen.add(nodeId);
      const type = text(n.type, `nodes[${i}].type`); if (!NODE_TYPES.has(type)) throw new Error(`unsupported node type: ${type}`);
      const deps = n.depends_on === undefined ? [] : n.depends_on;
      if (!Array.isArray(deps) || deps.some((d) => typeof d !== "string")) throw new Error(`nodes[${i}].depends_on must be an array`);
      const sideEffect = text(n.side_effect ?? "read_only", `nodes[${i}].side_effect`); if (!EFFECTS.has(sideEffect)) throw new Error(`unsupported side_effect: ${sideEffect}`);
      if (deps.includes(nodeId)) throw new Error(`node ${nodeId} cannot depend on itself`);
      if (type === "retry" && (n.max_attempts === undefined || Number(n.max_attempts) < 1)) throw new Error(`retry node ${nodeId} requires max_attempts`);
      if (type === "subworkflow") text(n.workflow_id, `nodes[${i}].workflow_id`);
      normalized.push({ ...n, id: nodeId, type, depends_on: [...new Set(deps as string[])].sort(), side_effect: sideEffect });
    }
    for (const n of normalized) for (const dep of n.depends_on) if (!seen.has(dep)) throw new Error(`node ${n.id} has unknown dependency: ${dep}`);
    const byId = new Map(normalized.map((n) => [n.id, n])); const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (nodeId: string): void => {
      if (visiting.has(nodeId)) throw new Error(`workflow DAG contains a cycle at ${nodeId}`); if (visited.has(nodeId)) return; visiting.add(nodeId); for (const dep of byId.get(nodeId)!.depends_on) visit(dep); visiting.delete(nodeId); visited.add(nodeId); };
    for (const n of normalized) visit(n.id);
    return { nodes: normalized, inputs: args.inputs ?? {}, outputs: args.outputs ?? {}, checkpoint_policy: args.checkpoint_policy ?? { mode: "step" } };
  }

  save(args: JsonObject): JsonObject {
    const workflowId = String(args.workflow_id ?? id("workflow_dag")); const graph = this.validate(args); const lifecycle = String(args.lifecycle ?? "draft"); if (!LIFECYCLE.has(lifecycle)) throw new Error("workflow lifecycle is unsupported");
    if (SECRET.test(JSON.stringify(graph)) || SECRET.test(String(args.name)) || SECRET.test(String(args.description ?? ""))) throw new Error("Workflow definition must not contain credentials or secrets");
    const identity = { workflow_id: workflowId, name: text(args.name, "name"), description: String(args.description ?? ""), graph, graph_digest: digest(graph) }; const existing = this.store.find("workflow_dag", workflowId);
    if (existing) { if (existing.identity_digest !== digest(identity)) throw new Error("Workflow DAG idempotency conflict"); return { workflow: existing, idempotent: true }; }
    mkdirSync(join(this.store.paths.root, "workflows"), { recursive: true }); const filePath = join(this.store.paths.root, "workflows", `${workflowId}.workflow.json`); const document = { workflow_id: workflowId, name: identity.name, description: identity.description, ...graph, graph_digest: identity.graph_digest }; writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const workflow = this.store.create("workflow_dag", workflowId, { ...identity, file_path: filePath, file_digest: digest(document), identity_digest: digest(identity), lifecycle, automation_authority: false });
    return { workflow, idempotent: false };
  }
  transition(args: JsonObject): JsonObject {
    const workflow = this.store.get("workflow_dag", text(args.workflow_id, "workflow_id")); const current = String(workflow.lifecycle); const target = text(args.target, "target");
    const allowed: Record<string, string[]> = { draft: ["candidate"], candidate: ["verified"], verified: ["canary", "deprecated"], canary: ["routable", "rolled_back"], routable: ["deprecated", "rolled_back"], deprecated: [], rolled_back: [] };
    if (!LIFECYCLE.has(target) || !allowed[current]?.includes(target)) throw new Error(`Invalid Workflow DAG transition: ${current} -> ${target}`);
    if (["verified", "routable"].includes(target)) {
      const evaluation = this.store.get("evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
      if (evaluation.verdict !== "passed" || evaluation.split !== "held_out") throw new Error("Workflow verification requires a passed held-out evaluation");
    }
    if (target === "routable" && args.canary_receipt === undefined) throw new Error("Workflow routable transition requires canary_receipt");
    const reason = text(args.reason, "reason"); return { workflow: this.store.save("workflow_dag", String(workflow.id), { ...payload(workflow), lifecycle: target, transition_reason_digest: digest(reason), evaluation_run_id: args.evaluation_run_id ?? null, canary_receipt: args.canary_receipt ?? null, automation_authority: false }) };
  }

  checkpoint(args: JsonObject): JsonObject {
    const runId = text(args.run_id, "run_id"); const workflow = this.store.get("workflow_dag", text(args.workflow_id, "workflow_id")); const state = { completed: args.completed ?? [], pending: args.pending ?? [], active: args.active ?? [], state_digest: text(args.state_digest ?? digest({ completed: args.completed ?? [], pending: args.pending ?? [], active: args.active ?? [] }), "state_digest") };
    const checkpointId = String(args.checkpoint_id ?? id("workflow_checkpoint")); const cp = this.store.create("workflow_checkpoint", checkpointId, { run_id: runId, workflow_id: workflow.id, workflow_version: workflow.version, graph_digest: workflow.graph_digest, ...state, workspace_snapshot: args.workspace_snapshot ?? null, budget_fingerprint: args.budget_fingerprint ?? null, environment_fingerprint: args.environment_fingerprint ?? null, pending_decision: args.pending_decision ?? null, resume_action: String(args.resume_action ?? "resume") });
    return { checkpoint: cp };
  }

  resume(args: JsonObject): JsonObject {
    const cp = this.store.get("workflow_checkpoint", text(args.checkpoint_id, "checkpoint_id")); const workflow = this.store.get("workflow_dag", String(cp.workflow_id));
    const drift = (args.graph_digest !== undefined && args.graph_digest !== cp.graph_digest) || (args.state_digest !== undefined && args.state_digest !== cp.state_digest);
    return { checkpoint: cp, workflow, status: drift ? "needs_replan" : "ready", reason: drift ? "checkpoint fingerprint drift" : "exact graph and state match" };
  }
  cancel(args: JsonObject): JsonObject { const runId = text(args.run_id, "run_id"); return { run: this.store.save("workflow_dag_run", runId, { run_id: runId, status: "cancelled", reason_digest: digest(text(args.reason, "reason")) }) }; }
  replan(args: JsonObject): JsonObject { const cp = this.store.get("workflow_checkpoint", text(args.checkpoint_id, "checkpoint_id")); return { checkpoint: cp, status: "needs_replan", replan_required: true, reason: text(args.reason, "reason") }; }
  export(args: JsonObject): JsonObject { const workflow = this.store.get("workflow_dag", text(args.workflow_id, "workflow_id"), args.version === undefined ? undefined : Number(args.version)); const document = { workflow_id: workflow.id, name: workflow.name, description: workflow.description, ...(workflow.graph as JsonObject), graph_digest: workflow.graph_digest }; const fileDrift = workflow.file_path ? digest(JSON.parse(readFileSync(String(workflow.file_path), "utf8"))) !== workflow.file_digest : false; return { workflow_id: workflow.id, version: workflow.version, graph_digest: workflow.graph_digest, file_drift: fileDrift, document }; }
  import(args: JsonObject): JsonObject { const document = args.document; if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("document must be an object"); return this.save({ ...(document as JsonObject), workflow_id: args.workflow_id, name: (document as JsonObject).name }); }
}
