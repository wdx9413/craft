import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { RepositoryFile } from "./repository-files.ts";

export type PythonFileUnit = JsonObject & {
  readonly path: string;
  readonly source_digest: string;
  readonly analyzer: string;
  readonly analyzer_version: string;
  readonly nodes: JsonObject[];
  readonly edges: JsonObject[];
  readonly class_methods: JsonObject[];
  readonly unresolved_calls: number;
  readonly unresolved_imports: number;
  readonly unresolved_relations: number;
  readonly incremental_safe: boolean;
  readonly budget_limited: boolean;
  readonly unit_digest: string;
};
export type PythonIncrementalPlan = { readonly mode: "full" | "reuse" | "incremental"; readonly affected_paths: string[]; readonly reused_paths: string[]; readonly reason: string };

export function pythonFileUnitDigest(unit: Omit<PythonFileUnit, "unit_digest"> | PythonFileUnit): string {
  return stableDigest({ path: unit.path, source_digest: unit.source_digest, analyzer: unit.analyzer, analyzer_version: unit.analyzer_version,
    nodes: unit.nodes, edges: unit.edges, class_methods: unit.class_methods, unresolved_calls: unit.unresolved_calls, unresolved_imports: unit.unresolved_imports,
    unresolved_relations: unit.unresolved_relations, incremental_safe: unit.incremental_safe, budget_limited: unit.budget_limited });
}

/** Plan reuse around explicit Python import edges; dynamic modules are always reparsed. */
export function planPythonIncremental(files: readonly RepositoryFile[], cached: readonly JsonObject[]): PythonIncrementalPlan {
  const current = new Map(files.map(file => [file.path, file]));
  const previous = new Map<string, PythonFileUnit>();
  for (const raw of cached) {
    if (typeof raw.path !== "string" || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges) || !Array.isArray(raw.class_methods) || typeof raw.source_digest !== "string"
      || typeof raw.analyzer !== "string" || typeof raw.analyzer_version !== "string" || !Number.isInteger(raw.unresolved_calls)
      || !Number.isInteger(raw.unresolved_imports) || !Number.isInteger(raw.unresolved_relations) || typeof raw.incremental_safe !== "boolean"
      || raw.budget_limited !== false || typeof raw.unit_digest !== "string" || raw.unit_digest !== pythonFileUnitDigest(raw as PythonFileUnit)
      || previous.has(raw.path)) return full([...current.keys()], "invalid_or_incompatible_file_cache");
    previous.set(raw.path, raw as PythonFileUnit);
  }
  if (previous.size !== current.size || [...current.keys()].some(path => !previous.has(path))) return full([...current.keys()], "source_file_set_changed");
  const versions = new Set([...previous.values()].map(unit => `${unit.analyzer}\0${unit.analyzer_version}`));
  if (versions.size > 1) return full([...current.keys()], "mixed_analyzer_versions");
  const changed = [...current].filter(([path, file]) => previous.get(path)!.source_digest !== file.digest).map(([path]) => path).sort();
  const dynamicPaths = [...previous.values()].filter(unit => !unit.incremental_safe).map(unit => unit.path).sort();
  if (!changed.length && !dynamicPaths.length) return { mode: "reuse", affected_paths: [], reused_paths: [...current.keys()].sort(), reason: "all_source_digests_match" };

  const nodePath = new Map<string, string>();
  for (const [path, unit] of previous) for (const node of unit.nodes) nodePath.set(String(node.id), path);
  const reverseImports = new Map<string, Set<string>>();
  for (const [owner, unit] of previous) for (const edge of unit.edges) if (edge.kind === "imports") {
    const target = nodePath.get(String(edge.to_node_id));
    if (target) { const importers = reverseImports.get(target) ?? new Set<string>(); importers.add(owner); reverseImports.set(target, importers); }
  }
  // Dynamic modules are reparsed on every checkpoint. Their unresolved behavior
  // stays explicitly partial, while safe modules outside the known import closure
  // can still reuse digest-verified units.
  const affected = new Set([...changed, ...dynamicPaths]), queue = [...affected];
  while (queue.length) for (const importer of reverseImports.get(queue.shift()!) ?? []) if (!affected.has(importer)) { affected.add(importer); queue.push(importer); }
  const reason = dynamicPaths.length ? changed.length ? "changed_and_dynamic_modules_and_reverse_import_closure" : "dynamic_modules_and_reverse_import_closure"
    : "changed_modules_and_reverse_import_closure";
  return { mode: "incremental", affected_paths: [...affected].sort(), reused_paths: [...current.keys()].filter(path => !affected.has(path)).sort(), reason };
}

function full(paths: readonly string[], reason: string): PythonIncrementalPlan {
  return { mode: "full", affected_paths: [...paths].sort(), reused_paths: [], reason };
}
