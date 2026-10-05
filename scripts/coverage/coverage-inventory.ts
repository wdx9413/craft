/** Coverage denominator, independent of whether any selected test group is green. */
export interface CoverageGroup { name: string; include: readonly string[]; }
export function coverageInventory(files: readonly string[], groups: readonly CoverageGroup[], baseline: readonly string[] = []) {
  const production = [...new Set(files.filter(path => /^(core|capability|common|adapters|bin|workbench)\//u.test(path)
    && /\.(ts|js|mjs|cjs)$/u.test(path) && !path.endsWith(".d.ts")
    && !path.split("/").some(part => ["node_modules", "dist", "target"].includes(part))))].sort();
  const includes = groups.flatMap(group => [...group.include]);
  const registered = new Set(production.filter(path => includes.some(pattern => {
    if (!pattern.includes("*")) return path === pattern;
    const expression = pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[^/]*");
    return new RegExp(`^${expression}$`, "u").test(path);
  })));
  const managed = production.filter(path => registered.has(path));
  const missing = production.filter(path => !registered.has(path));
  const known = new Set(baseline);
  const new_missing = missing.filter(path => !known.has(path));
  const baseline_missing = missing.filter(path => known.has(path));
  return { status: missing.length ? "incomplete" : "complete", production, managed, missing,
    new_missing, baseline_missing,
    coverage_proven: false, native_coverage: "separate_required" };
}
