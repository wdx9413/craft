import ts from "typescript";
import { posix } from "node:path";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

type Source = { path: string; content: string; digest: string; language: string };
const parsed = new Map<string, ts.SourceFile>();

/** Checkpoint-only compiler IO, shared by binding and containment verification. */
export function createCheckpointCompilerHost(files: readonly Source[]): ts.CompilerHost & { sources: Map<string, Source>; reused: number } {
  if (files.length > 2000 || files.reduce((size, file) => size + file.content.length, 0) > 20_000_000) throw new Error("TypeScript checkpoint exceeds analysis budget");
  const sources = new Map(files.map(file => [`/${file.path}`, file]));
  const host: ts.CompilerHost & { sources: Map<string, Source>; reused: number } = {
    sources, reused: 0,
    getSourceFile(name, target) {
      const file = sources.get(name); if (!file) return undefined;
      const key = stableDigest([ts.version, name, file.digest]);
      const cached = parsed.get(key); if (cached) { host.reused++; return cached; }
      const source = ts.createSourceFile(name, file.content, target, true);
      parsed.set(key, source);
      while (parsed.size > 2000) parsed.delete(parsed.keys().next().value!);
      return source;
    },
    getDefaultLibFileName: () => "", writeFile: () => {}, getCurrentDirectory: () => "/",
    fileExists: name => sources.has(name), readFile: name => sources.get(name)?.content,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    directoryExists: name => [...sources.keys()].some(path => path.startsWith(name.endsWith("/") ? name : `${name}/`)),
  };
  return host;
}

/** Compiler binds names in an in-memory checkpoint; it never reads outside that checkpoint. */
export function analyzeTypeScript(files: readonly Source[]): JsonObject {
  const host = createCheckpointCompilerHost(files), sources = host.sources;
  const options: ts.CompilerOptions = { allowJs: true, checkJs: true, noLib: true, noResolve: false, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const program = ts.createProgram([...sources.keys()], options, host), checker = program.getTypeChecker();
  const nodes: JsonObject[] = [], edges: JsonObject[] = [], declarations = new Map<ts.Node, string>(), fileNodes = new Map<string, string>();
  const id = (value: unknown) => `ts_${stableDigest(value).slice(-24)}`;
  const span = (node: ts.Node) => ({ start_offset: node.getStart(), end_offset: node.getEnd() });
  for (const source of program.getSourceFiles()) {
    const file = sources.get(source.fileName)!;
    const fileId = id([file.path, "file"]); fileNodes.set(source.fileName, fileId);
    nodes.push({ id: fileId, kind: "file", path: file.path, name: file.path, source_digest: file.digest, language: file.language, span: { start_offset: 0, end_offset: 0 } });
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)
        || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isVariableDeclaration(node) || ts.isParameter(node)) {
        if (node.name) {
          const nodeId = id([file.path, node.name.getStart(), node.name.getText()]); declarations.set(node, nodeId);
          nodes.push({ id: nodeId, kind: "symbol", path: file.path, name: node.name.getText(), source_digest: file.digest, language: file.language, span: span(node.name) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  let unresolved = 0;
  for (const source of program.getSourceFiles()) {
    const add = (kind: string, from: string, to: string, at: ts.Node): void => {
      edges.push({ kind, from_node_id: from, to_node_id: to, source_span: span(at) });
    };
    const visit = (node: ts.Node, owner: string): void => {
      const current = declarations.get(node) ?? owner;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = ts.resolveModuleName(node.moduleSpecifier.text, source.fileName, options, host).resolvedModule;
        const target = resolved && fileNodes.get(posix.normalize(resolved.resolvedFileName));
        if (target) add("imports", fileNodes.get(source.fileName)!, target, node.moduleSpecifier); else unresolved++;
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const expressionType = checker.getTypeAtLocation(node.expression);
        const callable = ts.isNewExpression(node) ? expressionType.getConstructSignatures() : expressionType.getCallSignatures();
        const targets = callable.length ? [signature?.declaration, ...(symbol?.declarations ?? [])].filter((value): value is ts.Declaration => value !== undefined) : [];
        let target = targets.map(value => declarations.get(value)).find(Boolean);
        if (!target && signature?.declaration?.parent) target = declarations.get(signature.declaration.parent);
        if (target) add("calls", current, target, node.expression); else unresolved++;
      }
      ts.forEachChild(node, child => visit(child, current));
    };
    visit(source, fileNodes.get(source.fileName)!);
  }
  if (nodes.length > 10_000 || edges.length > 20_000) throw new Error("TypeScript graph exceeds import budget");
  return { format: "craft-static-analysis-v1", analyzer: "typescript-checker", analyzer_version: ts.version, nodes, edges,
    diagnostics: { unresolved_relations: unresolved, parsed_file_count: files.length - host.reused, reused_file_count: host.reused, external_resolution: false } };
}
