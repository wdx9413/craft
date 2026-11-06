import ts from "typescript";
import { posix } from "node:path";

export type SourceMap = Readonly<Record<string, string>>;
export type LayerFinding = { kind: "upward" | "frontend" | "cycle" | "unresolved"; path: string[] };

function rank(path: string): number {
  // CLI is a stable public transport entry. Eval suite is a harness, not a kernel.
  if (path.startsWith("common/craft-common-store-local/")) return -3;
  if (path.startsWith("common/craft-common-base/")) return -2;
  if (path.startsWith("common/craft-common-log/")) return -1;
  if (path === "core/cli.ts") return 3;
  if (path.startsWith("capability/craft-eval/")) return 4;
  if (path.startsWith("core/infrastructure/")) return 0;
  if (path.startsWith("core/application/")) return 2;
  if (path.startsWith("core/interfaces/")) return 3;
  if (path.startsWith("core/") || path.startsWith("capability/")) return 1;
  return 4;
}

/** Resolve actual barrel destinations, not the directory of a compatibility entry. */
export function auditLayerGraph(sources: SourceMap, packageExports: Readonly<Record<string, string>> = {}): LayerFinding[] {
  const findings: LayerFinding[] = [];
  type Edge = { target: string; runtime: boolean; reexport: boolean; names?: string[]; exports?: Record<string, string> };
  const edges = new Map<string, Edge[]>();
  for (const [path, source] of Object.entries(sources)) {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const imports: Array<Omit<Edge, "target"> & { specifier: string }> = [];
    function visit(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const runtime = ts.isImportDeclaration(node)
          ? !node.importClause?.isTypeOnly && (!node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings) || node.importClause.name !== undefined || node.importClause.namedBindings.elements.some((item) => !item.isTypeOnly))
          : !node.isTypeOnly && (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.length === 0 || node.exportClause.elements.some((item) => !item.isTypeOnly));
        const names = !runtime && ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
          ? node.importClause.namedBindings.elements.map((item) => (item.propertyName ?? item.name).text)
          : undefined;
        const exports = ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)
          ? Object.fromEntries(node.exportClause.elements.map((item) => [item.name.text, (item.propertyName ?? item.name).text]))
          : undefined;
        imports.push({ specifier: node.moduleSpecifier.text, runtime, reexport: ts.isExportDeclaration(node), names, exports });
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) imports.push({ specifier: node.arguments[0].text, runtime: true, reexport: false });
        else findings.push({ kind: "unresolved", path: [path, "nonliteral dynamic import"] });
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    const resolved = imports.flatMap((item) => {
      const internal = item.specifier.startsWith(".");
      const craftPackage = item.specifier.startsWith("craft-common-") || item.specifier.startsWith("@craft/capability-");
      if (!internal && !craftPackage) return [];
      const joined = internal ? posix.normalize(posix.join(posix.dirname(path), item.specifier)) : packageExports[item.specifier];
      const target = joined && [joined, joined.replace(/\.js$/u, ".ts"), joined.replace(/\.js$/u, ".d.ts"), `${joined}.ts`, `${joined}/index.ts`].find((candidate) => candidate in sources);
      if (!target) findings.push({ kind: "unresolved", path: [path, item.specifier] });
      return target ? [{ target, runtime: item.runtime, reexport: item.reexport, names: item.names, exports: item.exports }] : [];
    });
    edges.set(path, resolved);
  }
  function destinations(path: string, seen = new Set<string>(), symbol?: string): string[] {
    if (seen.has(path)) return [path];
    const outgoing = edges.get(path)!;
    const file = ts.createSourceFile(path, sources[path], ts.ScriptTarget.Latest, true);
    const barrel = file.statements.length > 0 && file.statements.every((node) => ts.isExportDeclaration(node) || ts.isEmptyStatement(node));
    if (!barrel || !outgoing.length) return [path];
    const next = new Set(seen); next.add(path);
    const selected = symbol === undefined ? outgoing : outgoing.filter((edge) => edge.exports === undefined || symbol in edge.exports);
    if (!selected.length) return [path];
    return selected.flatMap((edge) => destinations(edge.target, next, symbol === undefined ? undefined : edge.exports?.[symbol] ?? symbol));
  }
  for (const [path, outgoing] of edges) {
    const file = ts.createSourceFile(path, sources[path], ts.ScriptTarget.Latest, true);
    const compatibility = file.statements.length > 0 && file.statements.every((node) => ts.isExportDeclaration(node) || ts.isEmptyStatement(node));
    for (const edge of outgoing) {
      const targets = edge.names === undefined ? destinations(edge.target) : edge.names.flatMap((name) => destinations(edge.target, new Set(), name));
      for (const target of targets) {
        if (path.startsWith("workbench/") && !target.startsWith("workbench/")) findings.push({ kind: "frontend", path: [path, target] });
        else if (!compatibility && rank(target) > rank(path)) findings.push({ kind: "upward", path: [path, edge.target, target] });
      }
    }
  }
  const complete = new Set<string>();
  function walk(path: string, stack: string[]): void {
    if (stack.includes(path)) { findings.push({ kind: "cycle", path: [...stack.slice(stack.indexOf(path)), path] }); return; }
    if (complete.has(path)) return;
    for (const edge of edges.get(path)!) if (edge.runtime) walk(edge.target, [...stack, path]);
    complete.add(path);
  }
  for (const path of edges.keys()) walk(path, []);
  return findings;
}
