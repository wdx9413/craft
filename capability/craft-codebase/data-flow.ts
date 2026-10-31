import type ts from "typescript";
import { getTypeScript } from "./typescript-runtime.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { buildControlFlowGraph } from "./control-flow.ts";

type Span = { readonly start_offset: number; readonly end_offset: number };
type Def = { readonly id: string; readonly block: string; readonly span: Span; readonly order: number; readonly source: string };
type Use = { readonly id: string; readonly block: string; readonly span: Span; readonly order: number };
type Event = { readonly block: string; readonly order: number; readonly definition?: Def; readonly use?: Use };
type Variable = { readonly symbol: ts.Symbol; readonly name: string; readonly declaration: Span; readonly kind: string; readonly id: string };
type FunctionTarget = { readonly declaration: ts.Node; readonly functionLike: ts.FunctionLikeDeclaration; readonly body: ts.ConciseBody };
const MAX_SOURCE_CHARS = 1_000_000;
const MAX_EVENTS = 2_000;
const MAX_TOTAL_EVENTS = 4_000;
const MAX_VARIABLE_CANDIDATES = 32;
const MAX_FLOWS = 4_000;
const MAX_FIXED_POINT_STEPS = 50_000;

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return getTypeScript().isFunctionDeclaration(node) || getTypeScript().isMethodDeclaration(node) || getTypeScript().isConstructorDeclaration(node)
    || getTypeScript().isGetAccessorDeclaration(node) || getTypeScript().isSetAccessorDeclaration(node) || getTypeScript().isFunctionExpression(node) || getTypeScript().isArrowFunction(node);
}

function functionBody(node: ts.Node): ts.ConciseBody | undefined {
  if (isFunctionLike(node)) return node.body;
  if (getTypeScript().isVariableDeclaration(node) || getTypeScript().isPropertyDeclaration(node)) {
    const initializer = node.initializer;
    return initializer && isFunctionLike(initializer) ? initializer.body : undefined;
  }
  return undefined;
}

function locateFunction(source: ts.SourceFile, offset: number): FunctionTarget | undefined {
  let found: FunctionTarget | undefined;
  const visit = (node: ts.Node): void => {
    const name = (node as ts.NamedDeclaration).name;
    if (name?.getStart(source) === offset) {
      const body = functionBody(node);
      const initializer = (getTypeScript().isVariableDeclaration(node) || getTypeScript().isPropertyDeclaration(node)) ? node.initializer : undefined;
      const functionLike = isFunctionLike(node) ? node : initializer && isFunctionLike(initializer) ? initializer : undefined;
      if (body && functionLike) { found = { declaration: node, functionLike, body }; return; }
    }
    if (!found) getTypeScript().forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isTrackedDeclaration(node: ts.Node): node is ts.NamedDeclaration {
  return getTypeScript().isVariableDeclaration(node) || getTypeScript().isParameter(node) || getTypeScript().isBindingElement(node);
}

function declarationKind(node: ts.Declaration): string {
  return getTypeScript().isParameter(node) ? "parameter" : "variable";
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return kind >= getTypeScript().SyntaxKind.FirstAssignment && kind <= getTypeScript().SyntaxKind.LastAssignment;
}

function isCompoundAssignment(kind: ts.SyntaxKind): boolean {
  return isAssignment(kind) && kind !== getTypeScript().SyntaxKind.EqualsToken;
}

function isIncrement(kind: ts.SyntaxKind): boolean {
  return kind === getTypeScript().SyntaxKind.PlusPlusToken || kind === getTypeScript().SyntaxKind.MinusMinusToken;
}

function isNameOnly(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (isTrackedDeclaration(parent) && parent.name === node) return true;
  if ((getTypeScript().isPropertyAccessExpression(parent) || getTypeScript().isPropertyAccessChain(parent)) && parent.name === node) return true;
  if (getTypeScript().isPropertyAssignment(parent) && parent.name === node) return true;
  if (getTypeScript().isLabeledStatement(parent) && parent.label === node) return true;
  return false;
}

function assignmentTarget(node: ts.Identifier): ts.BinaryExpression | undefined {
  const parent = node.parent;
  return getTypeScript().isBinaryExpression(parent) && parent.left === node && isAssignment(parent.operatorToken.kind) ? parent : undefined;
}

function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) if (current === ancestor) return true;
  return false;
}

function markUnmodeledFlow(node: ts.Identifier, symbol: ts.Symbol, checker: ts.TypeChecker, functionBodyNode: ts.Node, unsupported: Set<string>): void {
  for (let parent = node.parent; parent && parent !== functionBodyNode; parent = parent.parent) {
    if (getTypeScript().isVariableDeclaration(parent) && parent.initializer && isWithin(node, parent.initializer) && getTypeScript().isIdentifier(parent.name)) {
      if (checker.getSymbolAtLocation(parent.name) !== symbol) unsupported.add("AliasFlowNotModeled");
    }
    if (getTypeScript().isBinaryExpression(parent) && isAssignment(parent.operatorToken.kind)) {
      if (isWithin(node, parent.left) && parent.left !== node) unsupported.add("FieldOrDestructuredWriteNotModeled");
      if (isWithin(node, parent.right) && getTypeScript().isIdentifier(parent.left) && checker.getSymbolAtLocation(parent.left) !== symbol)
        unsupported.add("AliasFlowNotModeled");
    }
  }
}

export function solveDataFlowFixedPoint(blocks: readonly JsonObject[], edges: readonly JsonObject[], definitionsByBlock: ReadonlyMap<string, readonly Def[]>,
  definitions: readonly Def[], maxSteps = MAX_FIXED_POINT_STEPS): { incoming: Map<string, Set<string>>; reachable: Set<string>; exceeded: boolean } {
  const blockIds = new Set(blocks.map(block => String(block.id)));
  const entry = String(blocks.find(block => block.kind === "entry")?.id ?? blocks[0]?.id ?? "");
  const successors = new Map(blocks.map(block => [String(block.id), [] as string[]]));
  for (const edge of edges) {
    const from = String(edge.from_block_id), to = String(edge.to_block_id);
    if (blockIds.has(from) && blockIds.has(to)) successors.get(from)!.push(to);
  }
  const reachable = new Set<string>();
  const pending = entry && blockIds.has(entry) ? [entry] : [];
  while (pending.length) {
    const current = pending.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    pending.push(...successors.get(current)!);
  }
  const predecessors = new Map(blocks.map(block => [String(block.id), [] as string[]]));
  for (const edge of edges) {
    const from = String(edge.from_block_id), to = String(edge.to_block_id);
    if (reachable.has(from) && reachable.has(to)) predecessors.get(to)?.push(from);
  }
  const incoming = new Map(blocks.map(block => [String(block.id), new Set<string>()]));
  const outgoing = new Map(blocks.map(block => [String(block.id), new Set<string>()]));
  let changed = true, steps = 0;
  while (changed && steps < maxSteps) {
    changed = false; steps++;
    for (const block of blocks) {
      const id = String(block.id), nextIn = new Set<string>();
      if (!reachable.has(id)) continue;
      for (const predecessor of predecessors.get(id)!) for (const definition of outgoing.get(predecessor)!) nextIn.add(definition);
      const blockDefinitions = definitionsByBlock.get(id) ?? [];
      const generated = blockDefinitions.at(-1);
      const killed = blockDefinitions.length ? new Set(definitions.map(definition => definition.id)) : new Set<string>();
      const nextOut = new Set([...nextIn].filter(definition => !killed.has(definition)));
      if (generated) nextOut.add(generated.id);
      if (!sameSet(incoming.get(id)!, nextIn) || !sameSet(outgoing.get(id)!, nextOut)) {
        incoming.set(id, nextIn); outgoing.set(id, nextOut); changed = true;
      }
    }
  }
  return { incoming, reachable, exceeded: changed };
}

export function createDataFlowCompilerHost(fileName: string, content: string, source: ts.SourceFile): ts.CompilerHost {
  const host = getTypeScript().createCompilerHost({ allowJs: true, checkJs: true, noLib: true, noResolve: true, target: getTypeScript().ScriptTarget.Latest });
  host.getCurrentDirectory = () => "/craft-checkpoint";
  host.getCanonicalFileName = value => value;
  host.fileExists = value => value === fileName;
  host.readFile = value => value === fileName ? content : undefined;
  host.getSourceFile = value => value === fileName ? source : undefined;
  return host;
}

/** Return may-reaching local definitions for one function and variable from an immutable source snapshot. */
export function buildDataFlowGraph(content: string, path: string, symbolId: string, symbolOffset: number, requestedName: string,
  queryOptions: { readonly fixed_point_step_limit?: number } = {}): JsonObject {
  if (!Number.isSafeInteger(symbolOffset) || symbolOffset < 0 || symbolOffset > content.length) throw new Error("Data-flow symbol offset is outside the source snapshot");
  if (content.length > MAX_SOURCE_CHARS) throw new Error("Data-flow source exceeds the 1 MiB budget");
  if (typeof requestedName !== "string" || !requestedName.trim() || requestedName.length > 256) throw new Error("Data-flow variable name is invalid");
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (!extension || !["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(extension)) throw new Error("Data-flow query requires a TypeScript or JavaScript source file");
  const scriptKind = extension === "tsx" ? getTypeScript().ScriptKind.TSX : extension === "jsx" ? getTypeScript().ScriptKind.JSX : ["js", "mjs", "cjs"].includes(extension) ? getTypeScript().ScriptKind.JS : getTypeScript().ScriptKind.TS;
  const fileName = `/craft-checkpoint/${path}`;
  const source = getTypeScript().createSourceFile(fileName, content, getTypeScript().ScriptTarget.Latest, true, scriptKind);
  const target = locateFunction(source, symbolOffset);
  if (!target) throw new Error("Data-flow query requires an indexed function, method, or function-valued declaration");
  const options: ts.CompilerOptions = { allowJs: true, checkJs: true, noLib: true, noResolve: true, target: getTypeScript().ScriptTarget.Latest };
  const host = createDataFlowCompilerHost(fileName, content, source);
  const program = getTypeScript().createProgram([fileName], options, host);
  const checker = program.getTypeChecker();
  const unsupported = new Set<string>();
  const variables = new Map<ts.Symbol, Variable>();
  let omittedEvents = 0;
  const walk = (node: ts.Node, includeRootFunction = false): void => {
    if (isFunctionLike(node) && node !== target.functionLike && !includeRootFunction) return;
    if (isTrackedDeclaration(node)) {
      if (node.name && getTypeScript().isIdentifier(node.name)) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol && node.name.text === requestedName) {
          if (variables.size < MAX_VARIABLE_CANDIDATES) variables.set(symbol, { symbol, name: node.name.text,
            declaration: { start_offset: node.name.getStart(source), end_offset: node.name.getEnd() }, kind: declarationKind(node),
            id: `data_flow_var_${stableDigest([symbolId, node.name.getStart(source), node.name.text]).slice(-20)}` });
          else unsupported.add("VariableCandidateBudgetExceeded");
        }
      } else if (node.name) unsupported.add("DestructuredVariable");
    }
    getTypeScript().forEachChild(node, child => walk(child));
  };
  if (getTypeScript().isBlock(target.body)) for (const statement of target.body.statements) walk(statement);
  else walk(target.body);
  for (const parameter of target.functionLike.parameters) walk(parameter, true);
  if (!variables.size) return { symbol_id: symbolId, variable: requestedName, status: "not_found", candidates: [], definitions: [], uses: [], flows: [], partial_reasons: [], source_content_included: false };

  const control = buildControlFlowGraph(content, path, symbolId, symbolOffset);
  if (control.status !== "complete") for (const reason of control.partial_reasons as string[]) unsupported.add(reason);
  const blocks = control.blocks as JsonObject[];
  const edges = control.edges as JsonObject[];
  const entryId = String(control.entry_block_id);
  const narrowestBlocks = [...blocks].sort((left, right) => {
    const leftSpan = left.span as JsonObject, rightSpan = right.span as JsonObject;
    return Number(leftSpan.end_offset) - Number(leftSpan.start_offset) - Number(rightSpan.end_offset) + Number(rightSpan.start_offset);
  });
  const findBlock = (offset: number, end = offset): string | undefined => {
    const block = narrowestBlocks.find(candidate => {
      const span = candidate.span as JsonObject;
      return Number(span.start_offset) <= offset && Number(span.end_offset) >= end;
    });
    return block?.id === undefined ? undefined : String(block.id);
  };
  const events = new Map<ts.Symbol, Event[]>();
  let totalEvents = 0;
  const addEvent = (symbol: ts.Symbol, event: Event): void => {
    const list = events.get(symbol) ?? [];
    if (list.length >= MAX_EVENTS || totalEvents >= MAX_TOTAL_EVENTS) { omittedEvents++; return; }
    list.push(event); events.set(symbol, list); totalEvents++;
  };
  const makeDefinition = (name: ts.Identifier, symbol: ts.Symbol, node: ts.Node, sourceKind: string): void => {
    const span = { start_offset: name.getStart(source), end_offset: name.getEnd() };
    const block = findBlock(node.getStart(source), node.getEnd());
    if (!block) { unsupported.add("UnmappedDefinition"); return; }
    const variable = variables.get(symbol)!;
    const definition: Def = { id: `data_flow_def_${stableDigest([variable.id, span.start_offset, sourceKind]).slice(-20)}`,
      block, span, order: node.getEnd(), source: sourceKind };
    addEvent(symbol, { block, order: definition.order, definition });
  };
  const addUse = (node: ts.Identifier, symbol: ts.Symbol): void => {
    const span = { start_offset: node.getStart(source), end_offset: node.getEnd() };
    const block = findBlock(span.start_offset, span.end_offset);
    if (!block) { unsupported.add("UnmappedUse"); return; }
    const variable = variables.get(symbol)!;
    const use: Use = { id: `data_flow_use_${stableDigest([variable.id, span.start_offset]).slice(-20)}`, block, span, order: span.start_offset };
    addEvent(symbol, { block, order: use.order, use });
  };
  for (const [symbol, variable] of variables) {
    if (variable.kind === "parameter") {
      const definition: Def = { id: `data_flow_def_${stableDigest([variable.id, "parameter"]).slice(-20)}`,
        block: entryId, span: variable.declaration, order: -1, source: "parameter" };
      addEvent(symbol, { block: entryId, order: -1, definition });
    }
  }
  const inspect = (node: ts.Node): void => {
    if (isFunctionLike(node) && node !== target.functionLike) return;
    if (getTypeScript().isBinaryExpression(node) && isAssignment(node.operatorToken.kind)
      && (getTypeScript().isObjectLiteralExpression(node.left) || getTypeScript().isArrayLiteralExpression(node.left))) {
      let writesRequestedName = false;
      const findWrite = (candidate: ts.Node): void => {
        if (getTypeScript().isIdentifier(candidate) && candidate.text === requestedName) writesRequestedName = true;
        getTypeScript().forEachChild(candidate, findWrite);
      };
      findWrite(node.left);
      if (writesRequestedName) unsupported.add("FieldOrDestructuredWriteNotModeled");
    }
    if (isTrackedDeclaration(node) && node.name && getTypeScript().isIdentifier(node.name)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol && variables.has(symbol)) {
        if (getTypeScript().isVariableDeclaration(node)) makeDefinition(node.name, symbol, node, "declaration");
        else if (getTypeScript().isBindingElement(node)) unsupported.add("DestructuredVariable");
      }
    }
    if (getTypeScript().isIdentifier(node) && !isNameOnly(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol && variables.has(symbol)) {
        const assignment = assignmentTarget(node);
        const parent = node.parent;
        const increment = (getTypeScript().isPrefixUnaryExpression(parent) || getTypeScript().isPostfixUnaryExpression(parent)) && parent.operand === node && isIncrement(parent.operator);
        if (assignment) {
          if (isCompoundAssignment(assignment.operatorToken.kind)) addUse(node, symbol);
          makeDefinition(node, symbol, assignment, "assignment");
        } else if (increment) {
          addUse(node, symbol);
          makeDefinition(node, symbol, parent, "increment");
        } else {
          markUnmodeledFlow(node, symbol, checker, target.body, unsupported);
          addUse(node, symbol);
        }
      }
    }
    getTypeScript().forEachChild(node, inspect);
  };
  if (getTypeScript().isBlock(target.body)) for (const statement of target.body.statements) inspect(statement);
  else inspect(target.body);
  for (const parameter of target.functionLike.parameters) inspect(parameter);
  if (omittedEvents) unsupported.add("EventBudgetExceeded");

  const definitions: JsonObject[] = [], uses: JsonObject[] = [], flows: JsonObject[] = [];
  for (const [symbol, variable] of variables) {
    const variableEvents = (events.get(symbol) ?? []).sort((left, right) => left.order - right.order);
    const defs = variableEvents.flatMap(event => event.definition ? [event.definition] : []);
    const defsByBlock = new Map<string, Def[]>();
    for (const event of variableEvents) if (event.definition) defsByBlock.set(event.block, [...(defsByBlock.get(event.block) ?? []), event.definition]);
    const fixedPoint = solveDataFlowFixedPoint(blocks, edges, defsByBlock, defs, queryOptions.fixed_point_step_limit ?? MAX_FIXED_POINT_STEPS);
    if (fixedPoint.exceeded) unsupported.add("FixedPointBudgetExceeded");
    for (const definition of defs) definitions.push({ id: definition.id, variable_id: variable.id, name: variable.name,
      source: definition.source, span: definition.span, reachable: fixedPoint.reachable.has(definition.block) });
    for (const block of blocks) {
      const id = String(block.id), state = new Set(fixedPoint.incoming.get(id));
      const local = variableEvents.filter(event => event.block === id);
      for (const event of local) {
        if (event.use) {
          const reachable = fixedPoint.reachable.has(id);
          uses.push({ id: event.use.id, variable_id: variable.id, name: variable.name, span: event.use.span, reachable });
          if (!reachable) continue;
          for (const definitionId of [...state].sort()) {
            if (flows.length >= MAX_FLOWS) { unsupported.add("FlowBudgetExceeded"); break; }
            flows.push({ from_definition_id: definitionId, to_use_id: event.use.id, variable_id: variable.id, kind: "may_reach" });
          }
        }
        if (event.definition) { for (const old of defs) state.delete(old.id); state.add(event.definition.id); }
      }
    }
  }
  const parseErrors = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length;
  if (parseErrors) unsupported.add("SyntaxErrors");
  const candidates = [...variables.values()].map(variable => ({ variable_id: variable.id, name: variable.name, kind: variable.kind, declaration_span: variable.declaration }));
  const status = unsupported.size ? "partial" : candidates.length > 1 ? "ambiguous" : "complete";
  return { symbol_id: symbolId, variable: requestedName, status, candidates, definitions: definitions.slice(0, MAX_FLOWS), uses: uses.slice(0, MAX_FLOWS),
    flows: flows.slice(0, MAX_FLOWS), partial_reasons: [...unsupported].sort(), parse_error_count: parseErrors,
    omitted_event_count: omittedEvents, source_content_included: false, interprocedural: false, max_events: MAX_EVENTS, max_flows: MAX_FLOWS };
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}
