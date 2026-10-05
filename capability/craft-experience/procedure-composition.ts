import { selectGraph } from "./procedure-graph.ts";
/** Entry/exit contracts compile to Host plans; this module never executes steps. */
import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import { scopeAccess, scopeAllows, scopeEnvelope, scopeFromKey } from "../../common/craft-common-base/src/scope-policy.ts";
import { ProcedureDefinitionStore, procedureDefinitionRef } from "./procedure-definition.ts";

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  if (value !== value.trim()) throw new Error(`${name} must not have surrounding whitespace`);
  return value;
}
function list(value: unknown, name: string, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100) throw new Error(`${name} must contain ${minimum}..100 items`);
  return value;
}
function names(value: unknown, name: string, minimum = 0): string[] {
  const result = list(value, name, minimum).map(item => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} contains duplicates`);
  return result;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("procedure_version must be a positive integer");
  return Number(value);
}
function bindings(value: unknown, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value, name)).map(([key, item]) => [text(key, name), text(item, name)]));
}
function effect(value: unknown): string {
  const result = text(value, "side_effect");
  if (!["read_only", "local_write", "external_write", "destructive"].includes(result)) throw new Error("unsupported side_effect");
  return result;
}
function stepId(value: unknown): string {
  const id = text(value, "step.id");
  if (id.includes("/")) throw new Error("step.id must not contain path separators");
  if (id === "$exit") throw new Error("step.id $exit is reserved for exit acceptance");
  return id;
}
function unique(items: JsonObject[], name: string): void { names(items.map(item => item.id), name, 1); }

/** Validate every declared route before any candidate or proposal is written. */
export function validateProcedureComposition(kind: string, raw: unknown, rawSteps: unknown): JsonObject {
  if (kind !== "workflow") throw new Error("Procedure composition requires workflow; runtime branching belongs to Graph");
  const composition = object(raw, "composition");
  const steps = list(rawSteps, "steps", 1).map(value => {
    const step = object(value, "step");
    stepId(step.id); text(step.type, "step.type"); effect(step.side_effect);
    names(step.requires, "step.requires"); names(step.provides, "step.provides");
    if (step.type === "procedure_call") {
      text(step.procedure_id, "procedure_id"); version(step.procedure_version);
      if (!/^sha256:[a-f0-9]{64}$/u.test(text(step.definition_digest, "definition_digest"))) throw new Error("invalid definition_digest");
      text(step.entry_id, "entry_id"); text(step.exit_id, "exit_id");
      const inputs = bindings(step.input_bindings, "input_bindings"), outputs = bindings(step.output_bindings, "output_bindings");
      if (stableDigest([...new Set(Object.values(inputs))].sort()) !== stableDigest([...(step.requires as string[])].sort())
        || stableDigest(Object.keys(outputs).sort()) !== stableDigest([...(step.provides as string[])].sort())) throw new Error("Procedure Call bindings must match requires/provides");
    }
    return step;
  });
  unique(steps, "step ids");
  const exits = list(composition.exits, "exits", 1).map(value => {
    const exit = object(value, "exit"); text(exit.id, "exit.id"); text(exit.title, "exit.title");
    text(exit.acceptance_ref, "exit.acceptance_ref"); names(exit.required_outputs, "exit.required_outputs", 1);
    return exit;
  });
  unique(exits, "exit ids");
  const usedSteps = new Set<string>(), usedExits = new Set<string>();
  const entries = list(composition.entries, "entries", 1).map(value => {
    const entry = object(value, "entry"); text(entry.id, "entry.id"); text(entry.title, "entry.title");
    const inputs = names(entry.required_inputs, "entry.required_inputs"); names(entry.preconditions, "entry.preconditions");
    const routes = list(entry.routes, "entry.routes", 1).map(value => {
      const route = object(value, "route"); const exitId = text(route.exit_id, "route.exit_id");
      const exit = exits.find(item => item.id === exitId);
      if (!exit) throw new Error(`Unknown exit: ${exitId}`);
      usedExits.add(exitId);
      const groups = route.parallel_groups ?? [];
      if (!Array.isArray(groups)) throw new Error("parallel_groups must be an array");
      const grouped = new Set<string>();
      for (const rawGroup of groups) {
        const group = names(rawGroup, "parallel group", 2);
        if (group.length > 8) throw new Error("Parallel group exceeds 8 steps");
        const positions = group.map(id => (route.step_ids as string[]).indexOf(id)).sort((a, b) => a - b);
        if (positions[0]! < 0 || positions.some((at, index) => at !== positions[0]! + index)) throw new Error("Parallel group must be consecutive route steps");
        const members = group.map(id => steps.find(step => step.id === id)!);
        const outputs = new Set(members.flatMap(step => step.provides as string[]));
        for (const step of members) {
          if (grouped.has(String(step.id)) || step.type === "procedure_call" || step.side_effect !== "read_only"
            || (step.requires as string[]).some(input => outputs.has(input))) throw new Error("Parallel steps must be independent read-only instructions");
          grouped.add(String(step.id));
        }
      }
      const available = new Set(inputs);
      for (const id of names(route.step_ids, "route.step_ids", 1)) {
        const step = steps.find(item => item.id === id);
        if (!step) throw new Error(`Unknown step: ${id}`);
        usedSteps.add(id);
        for (const need of step.requires as string[]) if (!available.has(need)) throw new Error(`Route ${entry.id}/${exitId} is missing input ${need} before ${id}`);
        for (const output of step.provides as string[]) {
          if (available.has(output)) throw new Error(`Route output overwrites existing artifact: ${output}`);
          available.add(output);
        }
      }
      for (const output of exit.required_outputs as string[]) if (!available.has(output)) throw new Error(`Route cannot deliver exit output: ${output}`);
      return route;
    });
    names(routes.map(route => route.exit_id), "entry exit ids", 1);
    return entry;
  });
  unique(entries, "entry ids");
  if (usedSteps.size !== steps.length || usedExits.size !== exits.length) throw new Error("Composition contains unreachable steps or exits");
  return { entries, exits };
}

/** A bounded, read-only compiler over the existing checked Procedure store. */
export class ProcedurePlanner {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  plan(args: JsonObject, options: { deferPreconditions?: boolean } = {}): JsonObject {
    const scope = text(args.scope, "scope"), access = scopeAccess(args);
    const allowed = new Set(names(args.allowed_effects, "allowed_effects", 1).map(effect));
    const evidence = bindings(args.precondition_evidence ?? {}, "precondition_evidence");
    const inputRefs = bindings(args.input_refs, "input_refs");
    const definitions = new ProcedureDefinitionStore(this.store.paths);
    let count = 0;
    const compile = (selection: JsonObject, inputs: JsonObject, ancestors: string[], budgets: Set<string>[], path: string): JsonObject => {
      const id = text(selection.procedure_id, "procedure_id"), pinned = version(selection.procedure_version);
      if (ancestors.includes(id)) throw new Error("Recursive Procedure Call is forbidden");
      if (ancestors.length >= 8) throw new Error("Procedure Call depth exceeds 8");
      const procedure = this.store.get("experience_procedure", id);
      if (procedure.version !== pinned || procedure.routeable !== true || procedure.lifecycle !== "routeable") throw new Error(`Procedure unavailable, revoked, or version drifted: ${id}`);
      if (procedure.scope !== scope || !scopeAllows(scopeEnvelope(procedure.scope_envelope, scopeFromKey(scope)), access)) throw new Error(`Procedure scope or audience denied: ${id}`);
      if (!procedureDefinitionRef(procedure.definition_ref)) throw new Error("Procedure has no checked definition");
      const definition = definitions.read(procedure.definition_ref);
      if (selection.definition_digest !== undefined && selection.definition_digest !== procedure.definition_ref.digest) throw new Error("Procedure Call definition digest drifted");
      const spec = definition.definition;
      if (definition.kind === "graph") {
        const graph = selectGraph(spec, selection), scenario = graph.scenario as JsonObject, entry = graph.entry as JsonObject;
        const required = entry.required_inputs as string[];
        if (stableDigest(Object.keys(inputs).sort()) !== stableDigest([...required].sort())) throw new Error("Input references must exactly match Graph Entry");
        const declared = new Set(definition.allowed_effects.map(item => item === "read" ? "read_only" : effect(item)));
        const effects = scenario.allowed_effects as string[];
        if (effects.some(item => !declared.has(item) || budgets.some(b => !b.has(item)))) throw new Error("Graph subscenario effects exceed caller contract");
        const conditions = [...new Set([...definition.preconditions, ...entry.preconditions as string[]])];
        const preconditions = conditions.map(condition => {
          if (options.deferPreconditions) return { condition_ref: condition, deferred: true };
          const proof = this.store.get("evidence", text(evidence[condition], "Graph precondition Evidence"));
          const meta = object(proof.metadata, "Evidence metadata");
          if (!["bounded", "confirmed"].includes(String(proof.confidence)) || meta.scope !== scope || meta.condition_ref !== condition) throw new Error("Graph precondition Evidence mismatch");
          return { condition_ref: condition, evidence_id: proof.id, evidence_version: proof.version };
        });
        const graphNodes = (graph.nodes as JsonObject[]).map(raw => {
          if (++count > 100) throw new Error("Expanded Procedure exceeds 100 steps");
          const step = { ...raw, type: raw.type === "subworkflow" ? "procedure_call" : "instruction" };
          if (step.type !== "procedure_call") return step;
          const childInputs = Object.fromEntries(Object.entries(bindings(raw.input_bindings, "input_bindings")).map(([key, artifact]) => [key, { parent_artifact: artifact }]));
          if (stableDigest(Object.values(raw.input_bindings as JsonObject).sort()) !== stableDigest([...(raw.requires as string[])].sort()) || stableDigest(Object.keys(raw.output_bindings as JsonObject).sort()) !== stableDigest([...(raw.provides as string[])].sort())) throw new Error("Graph Call bindings must match requires/provides");
          const child = compile(raw, childInputs, [...ancestors, id], [...budgets, declared, new Set(["read_only", String(raw.side_effect)])], `${path}/${raw.id}`);
          if (child.graph) throw new Error("Graph calls currently require a Workflow subprocedure");
          if (Object.values(raw.output_bindings as JsonObject).some(key => !((child.exit as JsonObject).required_outputs as string[]).includes(String(key)))) throw new Error("Graph Call output is not public");
          return { ...step, child_plan: child };
        });
        return { procedure_id: id, procedure_version: pinned, scope, definition_digest: procedure.definition_ref.digest, failure_disposition: definition.failure_disposition,
          entry_id: entry.id, input_refs: inputs, precondition_evidence: preconditions, steps: [], parallel_groups: [], exit: graph.exit, graph: { ...graph, nodes: graphNodes }, acceptance_status: "not_evaluated" };
      }
      const composition = validateProcedureComposition(definition.kind, spec.composition, spec.steps);
      const entry = (composition.entries as JsonObject[]).find(item => item.id === selection.entry_id);
      if (!entry) throw new Error("Unknown Procedure Entry");
      const route = (entry.routes as JsonObject[]).find(item => item.exit_id === selection.exit_id);
      if (!route) throw new Error("Exit is not reachable from selected Entry");
      const exit = (composition.exits as JsonObject[]).find(item => item.id === selection.exit_id)!;
      const required = entry.required_inputs as string[];
      if (Object.keys(inputs).length !== required.length || required.some(key => !Object.hasOwn(inputs, key))) throw new Error(`Input references must exactly match Entry: ${entry.id}`);
      const preconditions = [...new Set([...definition.preconditions, ...entry.preconditions as string[]])];
      const evidenceRefs = preconditions.map(condition => {
        // Execution validates each call against its actual inputs and current snapshot.
        if (options.deferPreconditions) return { condition_ref: condition, deferred: true };
        if (!Object.hasOwn(evidence, condition)) throw new Error(`Missing precondition Evidence: ${condition}`);
        const item = this.store.get("evidence", evidence[condition]!);
        const metadata = object(item.metadata, "precondition Evidence metadata");
        if (!["confirmed", "bounded"].includes(String(item.confidence)) || metadata.scope !== scope || metadata.condition_ref !== condition) throw new Error(`Precondition Evidence is not bound to scope/condition: ${condition}`);
        return { condition_ref: condition, evidence_id: item.id, evidence_version: item.version };
      });
      const declared = new Set(definition.allowed_effects.map(item => item === "read" ? "read_only" : effect(item)));
      const nextBudgets = [...budgets, declared];
      const steps = (route.step_ids as string[]).map(stepId => {
        if (++count > 100) throw new Error("Expanded Procedure exceeds 100 steps");
        const step = (spec.steps as JsonObject[]).find(item => item.id === stepId)!;
        const sideEffect = effect(step.side_effect);
        if (nextBudgets.some(budget => !budget.has(sideEffect))) throw new Error(`Procedure effect denied: ${sideEffect}`);
        if (step.type !== "procedure_call") return { ...step, plan_step_id: `${path}/${stepId}` };
        const childInputs = Object.fromEntries(Object.entries(bindings(step.input_bindings, "input_bindings")).map(([key, artifact]) => [key, { parent_artifact: artifact }]));
        const child = compile(step, childInputs, [...ancestors, id], [...nextBudgets, new Set(["read_only", sideEffect])], `${path}/${stepId}`);
        if (child.graph) throw new Error("Workflow calls currently require a Workflow subprocedure");
        const outputs = (child.exit as JsonObject).required_outputs as string[];
        for (const output of Object.values(bindings(step.output_bindings, "output_bindings"))) if (!outputs.includes(output)) throw new Error(`Procedure Call references undeclared child output: ${output}`);
        return { ...step, plan_step_id: `${path}/${stepId}`, child_plan: child };
      });
      return { procedure_id: id, procedure_version: pinned, scope, failure_disposition: definition.failure_disposition, definition_digest: procedure.definition_ref.digest, entry_id: entry.id,
        input_refs: inputs, precondition_evidence: evidenceRefs, parallel_groups: route.parallel_groups ?? [], steps, exit, acceptance_status: "not_evaluated" };
    };
    const plan = compile(args, inputRefs, [], [allowed], "root");
    return { plan, plan_digest: stableDigest({ scope, plan }), expanded_step_count: count, execution_authorized: false, next_action: "Bind this plan to the Host Task/Policy; verify every child and selected exit acceptance contract after execution. Replan if any pinned Procedure changes." };
  }
}
