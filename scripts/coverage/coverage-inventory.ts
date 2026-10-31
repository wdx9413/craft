import ts from "typescript";

/** An explicit type-only registration stops being valid as soon as JavaScript is emitted. */
function typeOnlyModule(path: string, source: string): boolean {
  if (!path.endsWith(".ts")) return false;
  const output = ts.transpileModule(source, { fileName: path, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, moduleDetection: ts.ModuleDetectionKind.Force, verbatimModuleSyntax: true, removeComments: true } });
  if (output.diagnostics!.some(item => item.category === ts.DiagnosticCategory.Error)) return false;
  const code = output.outputText.replace(/\s+/gu, "");
  return code === "export{};";
}

/** Coverage denominator, independent of whether any selected test group is green. */
export interface CoverageGroup { name: string; include: readonly string[]; }
export function coverageInventory(files: readonly string[], groups: readonly CoverageGroup[], baseline: readonly string[] = [], typeOnlySources: Readonly<Record<string, string>> = {}) {
  const production = [...new Set(files.filter(path => /^(core|capability|common|adapters|bin)\//u.test(path)
    && /\.(ts|js|mjs|cjs)$/u.test(path) && !path.endsWith(".d.ts")
    && !path.split("/").some(part => ["node_modules", "dist", "target"].includes(part))))].sort();
  const type_only: string[] = [], invalid_type_only: string[] = [];
  for (const [path, source] of Object.entries(typeOnlySources).sort()) {
    if (production.includes(path) && typeOnlyModule(path, source)) type_only.push(path);
    else invalid_type_only.push(path);
  }
  const runtime = production.filter(path => !type_only.includes(path));
  const includes = groups.flatMap(group => [...group.include]);
  const registered = new Set(runtime.filter(path => includes.some(pattern => {
    if (!pattern.includes("*")) return path === pattern;
    const expression = pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[^/]*");
    return new RegExp(`^${expression}$`, "u").test(path);
  })));
  const managed = runtime.filter(path => registered.has(path));
  const missing = runtime.filter(path => !registered.has(path));
  const known = new Set(baseline);
  const new_missing = missing.filter(path => !known.has(path));
  const baseline_missing = missing.filter(path => known.has(path));
  return { status: invalid_type_only.length ? "invalid" : missing.length ? "incomplete" : "complete", production, managed, missing, type_only, invalid_type_only,
    new_missing, baseline_missing,
    coverage_proven: false, typecheck_required: true, native_coverage: "separate_required" };
}
