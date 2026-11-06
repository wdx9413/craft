import type { JsonObject } from "../infrastructure/store.ts";
import { stableDigest } from "../digest.ts";
import { object, text } from "../validation.ts";
export type Item = JsonObject & { id: string; node_path: string; entry_paths: string[]; input_keys: Record<string, string>; output_keys: Record<string, string>; depends_on: string[]; acceptance_digest: string };
export type Node = JsonObject & { path: string; input_keys: Record<string, string>; precondition_evidence: JsonObject[] };
function refs(value: unknown): Record<string, string> { return Object.fromEntries(Object.entries(object(value, "bindings")).map(([k,v]) => [k,text(v,"binding")])); }
export function lowerInvocationPlan(plan: JsonObject, inputKeys: Record<string,string>, rootPath = "root", includeExit = true): { nodes: Node[]; items: Item[] } {
  const nodes: Node[] = [], items: Item[] = [];
      let previous: string[] = [];
      const lower = (node: JsonObject, path: string, inputKeys: Record<string, string>, ancestors: string[], exports: Record<string, string>): void => {
        const entryPaths = [...ancestors, path];
        nodes.push({ ...node, path, input_keys: inputKeys } as Node);
        const available: Record<string, string> = Object.assign(Object.create(null), inputKeys);
        const append = (id: string, kind: string, inputs: Record<string, string>, outputs: Record<string, string>, instruction: unknown, effect: unknown, acceptance: unknown): void => {
          const identity = { id, node_path: path, entry_paths: entryPaths, kind, input_keys: inputs, output_keys: outputs, instruction, effect, acceptance_ref: acceptance };
          items.push({ ...identity, depends_on: previous, acceptance_digest: stableDigest(identity) }); previous = [id];
        };
        const groups = node.parallel_groups as string[][];
        const pendingGroups = new Map<string[], { before: string[]; completed: string[] }>();
        for (const step of node.steps as JsonObject[]) {
          const stepPath = `${path}/${String(step.id)}`;
          const group = groups.find(ids => ids.includes(String(step.id)));
          if (group) {
            if (!pendingGroups.has(group)) pendingGroups.set(group, { before: previous, completed: [] });
            previous = pendingGroups.get(group)!.before;
          }
          if (step.type === "procedure_call") {
            const childInputs = Object.fromEntries(Object.entries(refs(step.input_bindings)).map(([name, key]) => [name, available[key]!]));
            const childExports = Object.fromEntries(Object.entries(refs(step.output_bindings)).map(([name, key]) => [`${path}:output:${name}`, key]));
            lower(step.child_plan as JsonObject, stepPath, childInputs, entryPaths, childExports);
          } else {
            append(stepPath, "step", Object.fromEntries((step.requires as string[]).map(key => [key, available[key]!])),
              Object.fromEntries((step.provides as string[]).map(key => [key, `${path}:output:${key}`])), step, step.side_effect, step.acceptance_ref ?? `step:${stepPath}`);
          }
          if (group) {
            const state = pendingGroups.get(group)!; state.completed.push(stepPath);
            previous = state.completed.length === group.length ? [...state.completed] : state.before;
          }
          for (const output of step.provides as string[]) available[output] = `${path}:output:${output}`;
        }
        if (path === rootPath && !includeExit) return;
        const exit = node.exit as JsonObject;
        const outputs = Object.fromEntries((exit.required_outputs as string[]).map(key => [key, available[key]!]));
        append(`${path}/$exit`, "exit", outputs, exports, exit, "read_only", exit.acceptance_ref);
      };
      lower(plan, rootPath, inputKeys, [], {});
      return { nodes, items };
}
