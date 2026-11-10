import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { RepositoryFile } from "./repository-files.ts";

export const JAVA_ANALYZER_VERSION = "craft-java-javac-v1";

export type JavaFileUnit = JsonObject & {
  readonly path: string;
  readonly source_digest: string;
  readonly analyzer: "jdk-compiler-tree";
  readonly analyzer_version: typeof JAVA_ANALYZER_VERSION;
  readonly package_name: string;
  readonly nodes: JsonObject[];
  readonly edges: JsonObject[];
  readonly unresolved_calls: number;
  readonly unresolved_imports: number;
  readonly incremental_safe: boolean;
  readonly budget_limited: boolean;
  readonly unit_digest: string;
};

export type JavaIncrementalPlan = {
  readonly mode: "full" | "reuse" | "incremental";
  readonly affected_paths: string[];
  readonly reused_paths: string[];
  readonly reason: string;
};

export function javaFileUnitDigest(unit: Omit<JavaFileUnit, "unit_digest"> | JavaFileUnit): string {
  return stableDigest({ path: unit.path, source_digest: unit.source_digest, analyzer: unit.analyzer, analyzer_version: unit.analyzer_version,
    package_name: unit.package_name, nodes: unit.nodes, edges: unit.edges, unresolved_calls: unit.unresolved_calls,
    unresolved_imports: unit.unresolved_imports, incremental_safe: unit.incremental_safe, budget_limited: unit.budget_limited });
}

/** Reuse digest-matched safe Java units and reanalyze locally unsafe units on each checkpoint. */
export function planJavaIncremental(files: readonly RepositoryFile[], cached: readonly JsonObject[], analyzerVersion: string): JavaIncrementalPlan {
  const current = new Map(files.map(file => [file.path, file]));
  const previous = new Map<string, JavaFileUnit>();
  for (const raw of cached) {
    if (typeof raw.path !== "string" || typeof raw.source_digest !== "string" || raw.analyzer !== "jdk-compiler-tree"
      || raw.analyzer_version !== analyzerVersion || typeof raw.package_name !== "string" || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)
      || !Number.isInteger(raw.unresolved_calls) || !Number.isInteger(raw.unresolved_imports) || typeof raw.incremental_safe !== "boolean"
      || raw.budget_limited !== false || typeof raw.unit_digest !== "string" || raw.unit_digest !== javaFileUnitDigest(raw as JavaFileUnit)
      || previous.has(raw.path)) return full([...current.keys()], "invalid_or_incompatible_file_cache");
    previous.set(raw.path, raw as JavaFileUnit);
  }
  if (!previous.size) return full([...current.keys()], "no_reusable_file_units");
  if (previous.size !== current.size || [...current.keys()].some(path => !previous.has(path))) return full([...current.keys()], "source_file_set_changed");
  const changed = [...current].filter(([path, file]) => previous.get(path)!.source_digest !== file.digest).map(([path]) => path).sort();
  const unsafePaths = [...previous.values()].filter(unit => !unit.incremental_safe).map(unit => unit.path).sort();
  if (!changed.length && !unsafePaths.length) return { mode: "reuse", affected_paths: [], reused_paths: [...current.keys()].sort(), reason: "all_source_digests_match" };

  const nodePath = new Map<string, string>();
  const packagePaths = new Map<string, Set<string>>();
  for (const [path, unit] of previous) {
    for (const node of unit.nodes) nodePath.set(String(node.id), path);
    const samePackage = packagePaths.get(unit.package_name) ?? new Set<string>();
    samePackage.add(path); packagePaths.set(unit.package_name, samePackage);
  }
  const reverseDependencies = new Map<string, Set<string>>();
  for (const [owner, unit] of previous) for (const edge of unit.edges) {
    if (!["imports", "calls", "references", "implements", "extends", "type_definition"].includes(String(edge.kind))) continue;
    const targetPath = nodePath.get(String(edge.to_node_id));
    if (targetPath && targetPath !== owner) {
      const dependents = reverseDependencies.get(targetPath) ?? new Set<string>();
      dependents.add(owner); reverseDependencies.set(targetPath, dependents);
    }
  }
  const affected = new Set([...changed, ...unsafePaths]), queue = [...changed, ...unsafePaths];
  const addAffected = (path: string): void => { if (!affected.has(path)) { affected.add(path); queue.push(path); } };
  while (queue.length) {
    const path = queue.shift()!;
    for (const samePackagePath of packagePaths.get(previous.get(path)!.package_name)!) addAffected(samePackagePath);
    for (const dependent of reverseDependencies.get(path) ?? []) addAffected(dependent);
  }
  const reason = unsafePaths.length
    ? changed.length ? "changed_unsafe_files_and_reverse_dependency_closure" : "unsafe_files_and_reverse_dependency_closure"
    : "changed_files_and_reverse_dependency_closure";
  if (affected.size === current.size) return full([...current.keys()], "all_java_units_require_reanalysis");
  return { mode: "incremental", affected_paths: [...affected].sort(), reused_paths: [...current.keys()].filter(path => !affected.has(path)).sort(), reason };
}

function full(paths: readonly string[], reason: string): JavaIncrementalPlan {
  return { mode: "full", affected_paths: [...paths].sort(), reused_paths: [], reason };
}
