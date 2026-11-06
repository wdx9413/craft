import type ts from "typescript";
import { getTypeScript, getTypeScriptVersion } from "./typescript-runtime.ts";
import { posix } from "node:path";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

type Source = { path: string; content: string; digest: string; language: string };
export type TypeScriptFileUnit = JsonObject & {
  readonly path: string;
  readonly source_digest: string;
  readonly analyzer_version: string;
  readonly external_module: boolean;
  readonly nodes: JsonObject[];
  readonly edges: JsonObject[];
  readonly unresolved_relations: number;
  /** Standard-library / bare-package lookups the checkpoint could not load. */
  readonly external_references?: number;
  readonly unresolved_type_references?: number;
  readonly unresolved_heritage?: number;
  readonly unresolved_imports?: number;
  readonly unresolved_calls?: number;
  readonly budget_limited: boolean;
  readonly unit_digest: string;
};
export type TypeScriptAnalysisOptions = { readonly include_paths?: readonly string[]; readonly include_file_units?: boolean;
  /** Test seam: exercise bounded-graph behaviour without allocating a huge fixture. */
  readonly max_graph_nodes?: number };
// Include Craft's serialized graph schema so cached file units are rebuilt when
// emitted symbol facts change even if the TypeScript compiler itself is unchanged.
// v8: unresolved relations are split into internal gaps vs external references
// (standard library / bare packages). Cached v7 units counted both together and
// lack the breakdown, so they must be rebuilt.
export const TYPESCRIPT_ANALYZER_VERSION = `${getTypeScriptVersion()}:craft-ts-semantic-v8`;
export function typeScriptFileUnitDigest(unit: Omit<TypeScriptFileUnit, "unit_digest"> | TypeScriptFileUnit): string {
  return stableDigest({ path: unit.path, source_digest: unit.source_digest, analyzer_version: unit.analyzer_version,
    external_module: unit.external_module, nodes: unit.nodes, edges: unit.edges, unresolved_relations: unit.unresolved_relations,
    external_references: unit.external_references ?? 0, unresolved_type_references: unit.unresolved_type_references ?? 0,
    unresolved_heritage: unit.unresolved_heritage ?? 0, unresolved_imports: unit.unresolved_imports ?? 0,
    unresolved_calls: unit.unresolved_calls ?? 0, budget_limited: unit.budget_limited });
}
const parsed = new Map<string, ts.SourceFile>();
const programs = new Map<string, ts.Program>();
import { GRAPH_BUDGET } from "./graph-budget.ts";

const DEFAULT_MAX_GRAPH_NODES = GRAPH_BUDGET.maxNodes;
const MAX_GRAPH_EDGES = GRAPH_BUDGET.maxEdges;

/**
 * Names the compiler would resolve from a standard library that a checkpoint
 * analysis deliberately does not load (`noLib: true`). A failed lookup for one
 * of these is an external reference, not a missing internal relation: mixing
 * the two made `unresolved_relations` look like ~126k broken internal edges
 * when most were `Promise`/`Array`/`node:` imports.
 */
const BUILTIN_TYPE_GLOBALS: ReadonlySet<string> = new Set([
  "Promise", "PromiseLike", "Array", "ReadonlyArray", "Record", "Partial", "Required", "Pick", "Omit",
  "Exclude", "Extract", "NonNullable", "ReturnType", "Parameters", "ConstructorParameters", "InstanceType",
  "ThisType", "Awaited", "Uppercase", "Lowercase", "Capitalize", "Uncapitalize", "PropertyKey",
  "ThisParameterType", "OmitThisParameter", "NoInfer", "Date", "Error", "TypeError", "RangeError",
  "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError", "Map", "ReadonlyMap",
  "WeakMap", "Set", "ReadonlySet", "WeakSet", "WeakRef", "FinalizationRegistry", "JSON", "Math", "Object",
  "Function", "String", "Number", "Boolean", "BigInt", "Symbol", "RegExp", "ArrayBuffer", "SharedArrayBuffer",
  "DataView", "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array",
  "Int32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "URL", "URLSearchParams",
  "AbortController", "AbortSignal", "TextEncoder", "TextDecoder", "EventTarget", "Event", "Request",
  "Response", "Headers", "FormData", "Blob", "File", "Buffer", "NodeJS", "Console", "Timer", "Timeout",
  "Iterable", "IterableIterator", "Iterator", "AsyncIterable", "AsyncIterableIterator", "AsyncIterator",
  "Generator", "AsyncGenerator", "GeneratorFunction", "AsyncGeneratorFunction",
]);
const BUILTIN_CALLABLES: ReadonlySet<string> = new Set([
  "fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "queueMicrotask",
  "structuredClone", "atob", "btoa", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "require", "console", "process", "globalThis", "Buffer",
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Date", "RegExp", "Error", "TypeError",
  "RangeError", "Promise", "Map", "Set", "WeakMap", "WeakSet", "JSON", "Math", "Reflect", "Proxy",
  "AbortController", "AggregateError", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array",
  "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
  "BigInt64Array", "BigUint64Array", "URL", "URLSearchParams", "WebSocket", "EventSource", "Worker",
  "BroadcastChannel", "MessageChannel", "MessagePort", "TextEncoder", "TextDecoder", "addEventListener",
  "removeEventListener", "apply", "call", "bind", "super", "import",
]);
function isExternalModuleSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}
/** Root identifier of a (possibly qualified) type name: `NodeJS.ProcessEnv` -> `NodeJS`. */
function rootTypeName(name: ts.EntityName): string {
  let current = name;
  while (getTypeScript().isQualifiedName(current)) current = current.left;
  return current.getText();
}
let declarationKinds: Map<ts.SyntaxKind, string> | undefined;
function declarationKindMap(): Map<ts.SyntaxKind, string> {
  return declarationKinds ??= new Map<ts.SyntaxKind, string>([
  [getTypeScript().SyntaxKind.FunctionDeclaration, "function"], [getTypeScript().SyntaxKind.MethodDeclaration, "method"], [getTypeScript().SyntaxKind.MethodSignature, "method"],
  [getTypeScript().SyntaxKind.PropertyDeclaration, "property"], [getTypeScript().SyntaxKind.PropertySignature, "property"], [getTypeScript().SyntaxKind.ClassDeclaration, "class"],
  [getTypeScript().SyntaxKind.InterfaceDeclaration, "interface"], [getTypeScript().SyntaxKind.TypeAliasDeclaration, "type"], [getTypeScript().SyntaxKind.EnumDeclaration, "enum"],
  [getTypeScript().SyntaxKind.EnumMember, "enum_member"], [getTypeScript().SyntaxKind.VariableDeclaration, "variable"], [getTypeScript().SyntaxKind.Parameter, "parameter"],
]);
}
// Shared with the importer so the analyzer never emits an unimportable graph.
const MAX_ANALYSIS_CHARS = GRAPH_BUDGET.maxImportBytes;
// Per-file facts are cached independently of the bounded combined graph. Keep
// this cache bounded too, while allowing ordinary large repositories to reuse
// unchanged units when the final importable graph reaches its separate cap.
const MAX_FILE_UNIT_CHARS = 16_000_000;
const MAX_FILE_UNITS_TOTAL_CHARS = 128_000_000;
export function exceedsTypeScriptFileUnitBudget(fileChars: number, totalChars: number, itemChars: number): boolean {
  return fileChars + itemChars > MAX_FILE_UNIT_CHARS || totalChars + itemChars > MAX_FILE_UNITS_TOTAL_CHARS;
}

/** Checkpoint-only compiler IO, shared by binding and containment verification. */
export function createCheckpointCompilerHost(files: readonly Source[]): ts.CompilerHost & { sources: Map<string, Source>; reused: number } {
  if (files.length > 2000 || files.reduce((size, file) => size + file.content.length, 0) > 20_000_000) throw new Error("TypeScript checkpoint exceeds analysis budget");
  const sources = new Map(files.map(file => [`/${file.path}`, file]));
  const host: ts.CompilerHost & { sources: Map<string, Source>; reused: number } = {
    sources, reused: 0,
    getSourceFile(name, target) {
      const file = sources.get(name); if (!file) return undefined;
      const key = stableDigest([getTypeScript().version, name, file.digest]);
      const cached = parsed.get(key); if (cached) { host.reused++; return cached; }
      const source = getTypeScript().createSourceFile(name, file.content, target, true);
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
export function analyzeTypeScript(files: readonly Source[], analysisOptions: TypeScriptAnalysisOptions = {}): JsonObject {
  const host = createCheckpointCompilerHost(files), sources = host.sources;
  const options: ts.CompilerOptions = { allowJs: true, checkJs: true, noLib: true, noResolve: false, target: getTypeScript().ScriptTarget.Latest, module: getTypeScript().ModuleKind.NodeNext, moduleResolution: getTypeScript().ModuleResolutionKind.NodeNext };
  const rootNames = [...sources.keys()].sort();
  const programKey = stableDigest({ analyzer_version: getTypeScript().version, root_names: rootNames });
  const oldProgram = programs.get(programKey);
  const program = getTypeScript().createProgram(rootNames, options, host, oldProgram);
  programs.delete(programKey);
  programs.set(programKey, program);
  while (programs.size > 2) programs.delete(programs.keys().next().value!);
  const checker = program.getTypeChecker();
  const allFiles = new Map(files.map(file => [file.path, file]));
  const outputPaths = new Set(analysisOptions.include_paths ?? files.map(file => file.path));
  if ([...outputPaths].some(path => !allFiles.has(path))) throw new Error("TypeScript analysis include_paths must exist in the checkpoint");
  const nodes: JsonObject[] = [], edges: JsonObject[] = [], declarations = new Map<ts.Node, string>(), unitDeclarations = new Map<ts.Node, string>(), fileNodes = new Map<string, string>();
  const MAX_GRAPH_NODES = analysisOptions.max_graph_nodes ?? DEFAULT_MAX_GRAPH_NODES;
  const unitNodes = new Map<string, JsonObject[]>(), unitEdges = new Map<string, JsonObject[]>(), unitChars = new Map<string, number>();
  const unitBudgetLimited = new Set<string>();
  let unitTotalChars = 0;
  let serializedChars = Buffer.byteLength(JSON.stringify({ format: "craft-static-analysis-v1", analyzer: "typescript-checker", analyzer_version: TYPESCRIPT_ANALYZER_VERSION, nodes: [], edges: [], diagnostics: {} }), "utf8");
  let omittedNodes = 0, omittedEdges = 0;
  const id = (value: unknown) => `ts_${stableDigest(value).slice(-24)}`;
  const span = (node: ts.Node) => ({ start_offset: node.getStart(), end_offset: node.getEnd() });
  const appendUnitFact = (path: string, target: Map<string, JsonObject[]>, fact: JsonObject): void => {
    if (unitBudgetLimited.has(path)) return;
    const list = target.get(path)!;
    const encodedLength = Buffer.byteLength(JSON.stringify(fact), "utf8") + (list.length ? 1 : 0);
    const currentFileChars = unitChars.get(path)!;
    const nextFileChars = currentFileChars + encodedLength;
    if (exceedsTypeScriptFileUnitBudget(currentFileChars, unitTotalChars, encodedLength)) {
      unitBudgetLimited.add(path);
      return;
    }
    list.push(fact); target.set(path, list); unitChars.set(path, nextFileChars); unitTotalChars += encodedLength;
  };
  const declarationId = (node: ts.Node): string | undefined => {
    if (!(getTypeScript().isFunctionDeclaration(node) || getTypeScript().isMethodDeclaration(node) || getTypeScript().isMethodSignature(node) || getTypeScript().isPropertyDeclaration(node)
      || getTypeScript().isPropertySignature(node) || getTypeScript().isClassDeclaration(node) || getTypeScript().isInterfaceDeclaration(node) || getTypeScript().isTypeAliasDeclaration(node)
      || getTypeScript().isEnumDeclaration(node) || getTypeScript().isEnumMember(node) || getTypeScript().isVariableDeclaration(node) || getTypeScript().isParameter(node))) return undefined;
    const named = node as ts.NamedDeclaration;
    const path = sources.get(node.getSourceFile().fileName)?.path;
    // Selected output files must resolve only to declarations whose bounded
    // node was actually emitted. For reused files, derive the stable ID from
    // the declaration span without rebuilding their declaration map.
    if (!named.name || !path || outputPaths.has(path)) return undefined;
    return id([path, named.name.getStart(), named.name.getText()]);
  };
  const appendNode = (node: JsonObject, required: boolean): boolean => {
    const encodedLength = Buffer.byteLength(JSON.stringify(node), "utf8") + (nodes.length ? 1 : 0);
    if (nodes.length >= MAX_GRAPH_NODES || serializedChars + encodedLength > MAX_ANALYSIS_CHARS) {
      if (!required) omittedNodes++;
      return false;
    }
    nodes.push(node); serializedChars += encodedLength;
    return true;
  };
  const sourceFiles = program.getSourceFiles();
  // Reserve every required file node before symbols consume the graph budget.
  // Otherwise an early declaration-heavy file can use the node/character cap
  // and make a later, required file node turn a bounded graph into a hard error.
  for (const source of sourceFiles) {
    const file = sources.get(source.fileName)!;
    const fileId = id([file.path, "file"]); fileNodes.set(source.fileName, fileId);
    if (outputPaths.has(file.path)) {
      const fileNode = { id: fileId, kind: "file", path: file.path, name: file.path, source_digest: file.digest, language: file.language, external_module: getTypeScript().isExternalModule(source), span: { start_offset: 0, end_offset: 0 } };
      if (!appendNode(fileNode, true)) throw new Error("TypeScript file graph exceeds analysis budget");
      unitNodes.set(file.path, []); unitEdges.set(file.path, []); unitChars.set(file.path, 0);
      appendUnitFact(file.path, unitNodes, fileNode);
    }
  }
  for (const source of sourceFiles) {
    const file = sources.get(source.fileName)!;
    if (!outputPaths.has(file.path)) continue;
    const visit = (node: ts.Node): void => {
      if (getTypeScript().isFunctionDeclaration(node) || getTypeScript().isMethodDeclaration(node) || getTypeScript().isMethodSignature(node) || getTypeScript().isPropertyDeclaration(node)
        || getTypeScript().isPropertySignature(node) || getTypeScript().isClassDeclaration(node) || getTypeScript().isInterfaceDeclaration(node) || getTypeScript().isTypeAliasDeclaration(node)
        || getTypeScript().isEnumDeclaration(node) || getTypeScript().isEnumMember(node) || getTypeScript().isVariableDeclaration(node) || getTypeScript().isParameter(node)) {
        if (node.name) {
          const nodeId = id([file.path, node.name.getStart(), node.name.getText()]);
          const functionInitializer = getTypeScript().isVariableDeclaration(node) && node.initializer !== undefined
            && (getTypeScript().isArrowFunction(node.initializer) || getTypeScript().isFunctionExpression(node.initializer));
          const declaration = getTypeScript().isVariableDeclaration(node) && getTypeScript().isVariableDeclarationList(node.parent) ? node.parent.parent : node;
          const symbolNode = { id: nodeId, kind: "symbol", declaration_kind: declarationKindMap().get(node.kind)!, path: file.path,
            name: node.name.getText(), source_digest: file.digest, language: file.language, span: span(node.name), declaration_span: span(declaration) };
          if (functionInitializer) symbolNode.declaration_kind = "function";
          const emitted = appendNode(symbolNode, false);
          appendUnitFact(file.path, unitNodes, symbolNode);
          unitDeclarations.set(node, nodeId);
          if (functionInitializer) unitDeclarations.set(node.initializer!, nodeId);
          if (emitted) {
            declarations.set(node, nodeId);
            if (functionInitializer) declarations.set(node.initializer!, nodeId);
          }
        }
      }
      getTypeScript().forEachChild(node, visit);
    };
    visit(source);
  }
  const unresolvedByPath = new Map([...outputPaths].map(path => [path, 0]));
  const unresolved = (path: string): void => { unresolvedByPath.set(path, unresolvedByPath.get(path)! + 1); };
  // Internal gaps and external references are different facts. A checkpoint
  // analysis has no standard library and cannot follow `node:` packages, so
  // those lookups are recorded as `external_references` instead of inflating
  // `unresolved_relations` with things the analyzer was never able to see.
  let externalReferences = 0;
  // Inline invocations (`(() => ...)()`) have no symbol to resolve and are not a
  // relation gap: there is no separate declaration to point at.
  let inlineInvocations = 0;
  const isInlineCallee = (expression: ts.Expression): boolean => {
    let target: ts.Expression = expression;
    if (getTypeScript().isParenthesizedExpression(target)) target = target.expression;
    return getTypeScript().isArrowFunction(target) || getTypeScript().isFunctionExpression(target);
  };
  // Local names bound by an import from a bare package or `node:` module. A call
  // to one of these cannot be followed into the checkpoint, so it is external.
  const externalImportBindings = new Map<string, Set<string>>();
  const rememberExternalBinding = (path: string, name: string | undefined): void => {
    if (!name) return;
    const set = externalImportBindings.get(path) ?? new Set<string>();
    set.add(name);
    externalImportBindings.set(path, set);
  };
  const unresolvedKinds = { type_reference: 0, heritage: 0, import: 0, call: 0 };
  const externalByPath = new Map<string, number>();
  const unresolvedKindsByPath = new Map<string, { type_reference: number; heritage: number; import: number; call: number }>();
  const kindCountsFor = (path: string): { type_reference: number; heritage: number; import: number; call: number } => {
    let counts = unresolvedKindsByPath.get(path);
    if (!counts) { counts = { type_reference: 0, heritage: 0, import: 0, call: 0 }; unresolvedKindsByPath.set(path, counts); }
    return counts;
  };
  const unresolvedAs = (path: string, kind: keyof typeof unresolvedKinds): void => {
    unresolvedKinds[kind] += 1;
    kindCountsFor(path)[kind] += 1;
    unresolved(path);
  };
  // A bounded sample of unresolved call names makes the gap actionable without
  // dumping 100k entries into a report.
  const unresolvedCallSamples = new Set<string>();
  const external = (path: string): void => {
    externalReferences += 1;
    externalByPath.set(path, (externalByPath.get(path) ?? 0) + 1);
  };
  const resolveDeclarationTargets = (items: readonly ts.Declaration[]): { graph: string[]; unit: string[] } => {
    const graph = new Set<string>(), unit = new Set<string>();
    for (const declaration of items) {
      const graphId = declarations.get(declaration) ?? declarationId(declaration);
      const unitId = unitDeclarations.get(declaration) ?? graphId;
      if (graphId) graph.add(graphId);
      if (unitId) unit.add(unitId);
    }
    return { graph: [...graph], unit: [...unit] };
  };
  // When the compiler cannot pin a symbol to a declaration (common with
  // `noLib` and interface-typed service objects), fall back to a name lookup
  // that only resolves when exactly one declaration in this checkpoint carries
  // the name. Ambiguity stays unresolved rather than inventing an edge.
  // A narrow fallback for calls the checker could not pin to a declaration:
  // resolve by name only when exactly one declaration in the whole checkpoint
  // carries it. `codebaseSymbolRead` qualifies; `read` does not. Ambiguity stays
  // unresolved rather than inventing an edge, and the fallback is only used for
  // call expressions (never for type names such as `NodeJS.ProcessEnv`).
  const uniqueDeclarationByName = new Map<string, string | null>();
  for (const [node, id] of declarations) {
    if (!getTypeScript().isIdentifier(node)) continue;
    const name = node.getText();
    const previous = uniqueDeclarationByName.get(name);
    if (previous === undefined) uniqueDeclarationByName.set(name, id);
    else if (previous !== id) uniqueDeclarationByName.set(name, null);
  }
  const fallbackByName = (atName: string): string | null => uniqueDeclarationByName.get(atName) ?? null;
  const resolveTargets = (at: ts.Node, allowNameFallback = false): { graph: string[]; unit: string[] } => {
    let symbol = checker.getSymbolAtLocation(at);
    if (symbol && symbol.flags & getTypeScript().SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const resolved = resolveDeclarationTargets(symbol?.declarations ?? []);
    if (resolved.graph.length || resolved.unit.length) return resolved;
    if (allowNameFallback) {
      const fallback = fallbackByName(at.getText().split(".").pop() ?? at.getText());
      if (fallback) return { graph: [fallback], unit: [fallback] };
    }
    return resolved;
  };
  const callOwner = (node: ts.Node, fallback: string, owners: Map<ts.Node, string> = declarations): string => {
    let parent = node.parent;
    while (parent) {
      if (getTypeScript().isFunctionLike(parent)) {
        const owner = owners.get(parent);
        if (owner) return owner;
      }
      parent = parent.parent;
    }
    return fallback;
  };
  for (const source of program.getSourceFiles()) {
    const file = sources.get(source.fileName)!;
    if (!outputPaths.has(file.path)) continue;
    const addUnit = (kind: string, from: string, to: string, at: ts.Node): void => {
      appendUnitFact(file.path, unitEdges, { kind, from_node_id: from, to_node_id: to, source_span: span(at) });
    };
    const add = (kind: string, from: string, to: string, at: ts.Node): void => {
      const edge = { kind, from_node_id: from, to_node_id: to, source_span: span(at) };
      const encodedLength = Buffer.byteLength(JSON.stringify(edge), "utf8") + (edges.length ? 1 : 0);
      if (edges.length >= MAX_GRAPH_EDGES || serializedChars + encodedLength > MAX_ANALYSIS_CHARS) { omittedEdges++; return; }
      edges.push(edge); serializedChars += encodedLength;
    };
    const visit = (node: ts.Node, owner: string, unitOwner: string): void => {
      const current = declarations.get(node) ?? owner, unitCurrent = unitDeclarations.get(node) ?? unitOwner;
      if (getTypeScript().isIdentifier(node)) {
        const parent = node.parent;
        const declarationName = "name" in parent && parent.name === node && unitDeclarations.has(parent);
        if (!declarationName) {
          const targets = resolveTargets(node);
          for (const target of targets.graph) add("references", current, target, node);
          for (const target of targets.unit) addUnit("references", unitCurrent, target, node);
        }
      }
      if (getTypeScript().isTypeReferenceNode(node)) {
        const targets = resolveTargets(node.typeName);
        for (const target of targets.graph) add("type_definition", current, target, node.typeName);
        for (const target of targets.unit) addUnit("type_definition", unitCurrent, target, node.typeName);
        if (!targets.graph.length) {
          if (BUILTIN_TYPE_GLOBALS.has(rootTypeName(node.typeName))) external(file.path);
          else unresolvedAs(file.path, "type_reference");
        }
      }
      if (getTypeScript().isHeritageClause(node) && (node.token === getTypeScript().SyntaxKind.ImplementsKeyword || node.token === getTypeScript().SyntaxKind.ExtendsKeyword)) {
        const relation: "implements" | "extends" = node.token === getTypeScript().SyntaxKind.ImplementsKeyword ? "implements" : "extends";
        for (const heritage of node.types) {
          const targets = resolveTargets(heritage.expression);
          for (const target of targets.graph) add(relation, current, target, heritage.expression);
          for (const target of targets.unit) addUnit(relation, unitCurrent, target, heritage.expression);
          if (!targets.graph.length) {
            if (BUILTIN_TYPE_GLOBALS.has(heritage.expression.getText())) external(file.path);
            else unresolvedAs(file.path, "heritage");
          }
        }
      }
      if ((getTypeScript().isImportDeclaration(node) || getTypeScript().isExportDeclaration(node)) && node.moduleSpecifier && getTypeScript().isStringLiteral(node.moduleSpecifier)) {
        const resolved = getTypeScript().resolveModuleName(node.moduleSpecifier.text, source.fileName, options, host).resolvedModule;
        const target = resolved && fileNodes.get(posix.normalize(resolved.resolvedFileName));
        if (target) {
          add("imports", fileNodes.get(source.fileName)!, target, node.moduleSpecifier);
          addUnit("imports", fileNodes.get(source.fileName)!, target, node.moduleSpecifier);
        } else if (isExternalModuleSpecifier(node.moduleSpecifier.text)) {
          external(file.path);
          const clause = getTypeScript().isImportDeclaration(node) ? node.importClause : undefined;
          rememberExternalBinding(file.path, clause?.name?.text);
          const bindings = clause?.namedBindings;
          if (bindings) {
            if (getTypeScript().isNamespaceImport(bindings)) rememberExternalBinding(file.path, bindings.name.text);
            else for (const element of bindings.elements) rememberExternalBinding(file.path, element.name.text);
          }
        }
        else unresolvedAs(file.path, "import");
      }
      if (getTypeScript().isCallExpression(node) || getTypeScript().isNewExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        let symbol = checker.getSymbolAtLocation(getTypeScript().isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression);
        if (symbol && symbol.flags & getTypeScript().SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        // A symbol declaration is evidence even when the expression type has no
        // call signature. With `noLib` a great many expressions degrade to
        // `any`, so gating on `getCallSignatures().length` discarded resolvable
        // internal calls and they were miscounted as unresolved relations.
        const candidates = [signature?.declaration, ...(symbol?.declarations ?? [])]
          .filter((value): value is ts.Declaration => value !== undefined);
        const targets = candidates.length
          ? resolveDeclarationTargets(candidates)
          : resolveTargets(node.expression, true);
        let target = targets.graph.find(Boolean);
        if (!target && signature?.declaration?.parent) target = declarations.get(signature.declaration.parent) ?? declarationId(signature.declaration.parent);
        if (target) add("calls", callOwner(node, current), target, node.expression);
        else if (isInlineCallee(node.expression)) inlineInvocations += 1;
        else if (BUILTIN_CALLABLES.has(getTypeScript().isPropertyAccessExpression(node.expression)
          ? node.expression.name.getText() : node.expression.getText())) external(file.path);
        else if (externalImportBindings.get(file.path)?.has(getTypeScript().isPropertyAccessExpression(node.expression)
          ? node.expression.expression.getText() : node.expression.getText())) external(file.path);
        else if (candidates.length > 0 && candidates.every((declaration) => !sources.has(declaration.getSourceFile().fileName)))
          // Every declaration the checker found lives outside the checkpoint
          // (a standard-library or package `.d.ts`). That is an external
          // reference, not a broken internal call.
          external(file.path);
        else if (getTypeScript().isPropertyAccessExpression(node.expression)
          // A method call on an `any` receiver cannot be resolved because the
          // receiver's type was never loaded (noLib drops Map/Set/JSON/Promise
          // and `node:` values). A concrete receiver with a missing method is a
          // real internal gap, so only the `any` case is external.
          && (checker.getTypeAtLocation(node.expression.expression).flags & getTypeScript().TypeFlags.Any) !== 0) external(file.path);
        else if (getTypeScript().isPropertyAccessExpression(node.expression)
          // Array/string/Map methods live on intrinsic or standard-library
          // types whose declarations are outside the checkpoint.
          && (() => {
            const receiver = checker.getTypeAtLocation(node.expression.expression);
            const symbol = receiver.getSymbol();
            const declared = symbol?.declarations ?? [];
            return !symbol || declared.length === 0 || declared.every((declaration) => !sources.has(declaration.getSourceFile().fileName));
          })()) external(file.path);
        else {
          if (unresolvedCallSamples.size < 20) {
            unresolvedCallSamples.add(getTypeScript().isPropertyAccessExpression(node.expression)
              ? node.expression.name.getText() : node.expression.getText().slice(0, 60));
          }
          unresolvedAs(file.path, "call");
        }
        const unitTarget = targets.unit.find(Boolean) ?? (signature?.declaration?.parent
          ? unitDeclarations.get(signature.declaration.parent) ?? declarations.get(signature.declaration.parent)
            ?? target : target);
        if (unitTarget) addUnit("calls", callOwner(node, unitCurrent, unitDeclarations), unitTarget, node.expression);
      }
      getTypeScript().forEachChild(node, child => visit(child, current, unitCurrent));
    };
    visit(source, fileNodes.get(source.fileName)!, fileNodes.get(source.fileName)!);
  }
  const budgetLimited = omittedNodes > 0 || omittedEdges > 0;
  const unresolvedCount = [...unresolvedByPath.values()].reduce((sum, count) => sum + count, 0);
  const result: JsonObject = { format: "craft-static-analysis-v1", analyzer: "typescript-checker", analyzer_version: TYPESCRIPT_ANALYZER_VERSION, nodes, edges,
    diagnostics: { unresolved_relations: unresolvedCount,
      unresolved_type_references: unresolvedKinds.type_reference, unresolved_heritage: unresolvedKinds.heritage,
      unresolved_imports: unresolvedKinds.import, unresolved_calls: unresolvedKinds.call,
      unresolved_call_samples: [...unresolvedCallSamples].sort(),
      // Standard-library and bare-package lookups the checkpoint never loaded.
      // They are counted here, not as unresolved internal relations.
      external_references: externalReferences,
      inline_invocations: inlineInvocations,
      omitted_nodes: omittedNodes, omitted_edges: omittedEdges, budget_limited: budgetLimited,
      parsed_file_count: files.length - host.reused, reused_file_count: host.reused, compiler_program_reused: Boolean(oldProgram), selected_file_count: outputPaths.size, external_resolution: false } };
  if (analysisOptions.include_file_units === true) {
    result.file_units = [...outputPaths].sort().map(path => {
      const unit = { path, source_digest: allFiles.get(path)!.digest, analyzer_version: TYPESCRIPT_ANALYZER_VERSION,
        external_module: getTypeScript().isExternalModule(sourceFiles.find(source => sources.get(source.fileName)?.path === path)!),
        nodes: unitNodes.get(path)!, edges: unitEdges.get(path)!, unresolved_relations: unresolvedByPath.get(path)!,
        external_references: externalByPath.get(path) ?? 0,
        unresolved_type_references: kindCountsFor(path).type_reference, unresolved_heritage: kindCountsFor(path).heritage,
        unresolved_imports: kindCountsFor(path).import, unresolved_calls: kindCountsFor(path).call,
        budget_limited: unitBudgetLimited.has(path) };
      return { ...unit, unit_digest: typeScriptFileUnitDigest(unit) } satisfies TypeScriptFileUnit;
    });
  }
  return result;
}
