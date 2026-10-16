import ts from "typescript";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { RepositoryFile } from "./repository-files.ts";
import { typeScriptFileUnitDigest, type TypeScriptFileUnit } from "./typescript-analysis.ts";

export type TypeScriptIncrementalPlan = {
  readonly mode: "full" | "reuse" | "incremental";
  readonly affected_paths: string[];
  readonly reused_paths: string[];
  readonly reason: string;
};

/** Plan file-level TypeScript graph reuse; ambiguous module semantics fail back to a full bind. */
export function planTypeScriptIncremental(files: readonly RepositoryFile[], cached: readonly JsonObject[], analyzerVersion: string, previousPathSetDigest?: string): TypeScriptIncrementalPlan {
  const current = new Map(files.map(file => [file.path, file]));
  const currentPathSetDigest = stableDigest([...current.keys()].sort());
  if (previousPathSetDigest !== undefined && previousPathSetDigest !== currentPathSetDigest) return full([...current.keys()], "source_file_set_changed");
  const previous = new Map<string, TypeScriptFileUnit>();
  for (const raw of cached) {
    if (typeof raw.path !== "string" || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges) || raw.analyzer_version !== analyzerVersion
      || typeof raw.source_digest !== "string" || typeof raw.external_module !== "boolean" || !Number.isInteger(raw.unresolved_relations)
      || raw.budget_limited !== false || typeof raw.unit_digest !== "string" || raw.unit_digest !== typeScriptFileUnitDigest(raw as TypeScriptFileUnit) || previous.has(raw.path)) {
      return full([...current.keys()], "invalid_or_incompatible_file_cache");
    }
    previous.set(raw.path, raw as TypeScriptFileUnit);
  }
  if ([...previous.keys()].some(path => !current.has(path))) return full([...current.keys()], "source_file_set_changed");
  if (previousPathSetDigest === undefined && previous.size !== current.size) return full([...current.keys()], "source_file_set_changed");
  if (!previous.size) return full([...current.keys()], "no_reusable_file_units");
  if ([...previous.values()].some(unit => !unit.external_module)) return full([...current.keys()], "global_or_ambient_type_scope");
  const changed = [...current].filter(([path, file]) => {
    const unit = previous.get(path);
    return unit !== undefined && unit.source_digest !== file.digest;
  }).map(([path]) => path).sort();
  const uncached = [...current.keys()].filter(path => !previous.has(path)).sort();
  if (!changed.length && !uncached.length) return { mode: "reuse", affected_paths: [], reused_paths: [...current.keys()].sort(), reason: "all_source_digests_match" };

  if (changed.some(path => path.toLowerCase().endsWith(".d.ts"))) return full([...current.keys()], "global_or_ambient_type_scope");
  for (const path of changed) {
    const file = current.get(path)!;
    const source = ts.createSourceFile(path, file.content, ts.ScriptTarget.Latest, false);
    if (!ts.isExternalModule(source) || /\bdeclare\s+(?:global|module)\b/u.test(file.content)) return full([...current.keys()], "changed_module_scope_is_ambiguous");
  }

  const nodePath = new Map<string, string>();
  for (const [path, unit] of previous) for (const node of unit.nodes) nodePath.set(String(node.id), path);
  const reverseImports = new Map<string, Set<string>>();
  for (const [owner, unit] of previous) for (const edge of unit.edges) if (edge.kind === "imports") {
    const target = nodePath.get(String(edge.to_node_id));
    if (target) { const importers = reverseImports.get(target) ?? new Set<string>(); importers.add(owner); reverseImports.set(target, importers); }
  }
  const affected = new Set([...changed, ...uncached]), queue = [...changed, ...uncached];
  while (queue.length) for (const importer of reverseImports.get(queue.shift()!) ?? []) if (!affected.has(importer)) { affected.add(importer); queue.push(importer); }
  const affectedPaths = [...affected].sort();
  return { mode: "incremental", affected_paths: affectedPaths, reused_paths: [...current.keys()].filter(path => !affected.has(path)).sort(),
    reason: uncached.length ? "changed_and_uncached_modules_and_reverse_import_closure" : "changed_modules_and_reverse_import_closure" };
}

function full(paths: readonly string[], reason: string): TypeScriptIncrementalPlan {
  return { mode: "full", affected_paths: [...paths].sort(), reused_paths: [], reason };
}
