import ts from "typescript";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

type PendingEdge = { readonly from_block_id: string; readonly kind: string };
type LoopTarget = { readonly continue_to: string; readonly breaks: string[] };
type Fragment = { readonly entry?: string; readonly exits: PendingEdge[] };
type FlowBlock = JsonObject & { readonly id: string; readonly kind: string; readonly span: JsonObject };
type FlowEdge = JsonObject & { readonly from_block_id: string; readonly to_block_id: string; readonly kind: string };
const MAX_BLOCKS = 500;
const MAX_EDGES = 800;

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

function functionBody(node: ts.Node): ts.ConciseBody | undefined {
  if (isFunctionLike(node)) return node.body;
  if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
    const initializer = node.initializer;
    return initializer && isFunctionLike(initializer) ? initializer.body : undefined;
  }
  return undefined;
}

function locateBody(source: ts.SourceFile, symbolOffset: number): ts.ConciseBody | undefined {
  let found: ts.ConciseBody | undefined;
  const visit = (node: ts.Node): void => {
    const name = (node as ts.NamedDeclaration).name;
    if (name?.getStart(source) === symbolOffset) {
      const body = functionBody(node);
      if (body) { found = body; return; }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Build a source-free, statement-level CFG for one indexed TypeScript/JavaScript function. */
export function buildControlFlowGraph(content: string, path: string, symbolId: string, symbolOffset: number): JsonObject {
  if (!Number.isSafeInteger(symbolOffset) || symbolOffset < 0 || symbolOffset > content.length) throw new Error("Control-flow symbol offset is outside the source snapshot");
  if (content.length > 1_000_000) throw new Error("Control-flow source exceeds the 1 MiB budget");
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (!extension || !["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(extension)) throw new Error("Control-flow query requires a TypeScript or JavaScript source file");
  const scriptKind = extension === "tsx" ? ts.ScriptKind.TSX : extension === "jsx" ? ts.ScriptKind.JSX : extension === "js" || extension === "mjs" || extension === "cjs" ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind);
  const body = locateBody(source, symbolOffset);
  if (!body) throw new Error("Control-flow query requires an indexed function, method, or function-valued declaration");

  const blocks: FlowBlock[] = [];
  const edges: FlowEdge[] = [];
  const unsupported = new Set<string>();
  const returns: string[] = [];
  const throws: string[] = [];
  const sourcePosition = (offset: number): { line: number; column: number } => {
    const value = source.getLineAndCharacterOfPosition(offset);
    return { line: value.line + 1, column: value.character + 1 };
  };
  const addBlock = (kind: string, node?: ts.Node): FlowBlock => {
    if (blocks.length >= MAX_BLOCKS) throw new Error(`Control-flow graph exceeds ${MAX_BLOCKS} block budget`);
    const start = node ? node.getStart(source) : 0;
    const end = node ? node.getEnd() : 0;
    const id = `control_flow_block_${stableDigest([symbolId, blocks.length, kind, start, end]).slice(-16)}`;
    const startPosition = sourcePosition(start), endPosition = sourcePosition(end);
    const block: FlowBlock = { id, kind, span: { start_offset: start, end_offset: end, start_line: startPosition.line,
      start_column: startPosition.column, end_line: endPosition.line, end_column: endPosition.column },
      ...(node ? { syntax_kind: ts.SyntaxKind[node.kind] } : {}) };
    blocks.push(block);
    return block;
  };
  const addEdge = (from: string, to: string, kind: string, loopBack = false): void => {
    if (edges.length >= MAX_EDGES) throw new Error(`Control-flow graph exceeds ${MAX_EDGES} edge budget`);
    edges.push({ from_block_id: from, to_block_id: to, kind, ...(loopBack ? { loop_back: true } : {}) });
  };
  const connect = (pending: readonly PendingEdge[], to: string, loopBack = false): void => { for (const edge of pending) addEdge(edge.from_block_id, to, edge.kind, loopBack); };
  const atom = (node: ts.Node, kind = "statement"): Fragment => {
    const block = addBlock(kind, node);
    return { entry: block.id, exits: [{ from_block_id: block.id, kind: "normal" }] };
  };
  const compileSequence = (statements: readonly ts.Statement[], loop?: LoopTarget): Fragment => {
    let entry: string | undefined;
    let exits: PendingEdge[] = [];
    for (const statement of statements) {
      const next = compile(statement, loop);
      if (!next.entry) continue;
      if (!entry) entry = next.entry;
      connect(exits, next.entry);
      exits = next.exits;
    }
    return { ...(entry ? { entry } : {}), exits };
  };
  const compileLoop = (statement: ts.IterationStatement, isPostTest: boolean): Fragment => {
    const conditionNode = ts.isForStatement(statement) ? statement.condition ?? statement
      : (statement as ts.ForInStatement | ts.ForOfStatement | ts.DoStatement | ts.WhileStatement).expression;
    const condition = addBlock("loop_condition", conditionNode);
    const breaks: string[] = [];
    let loopEntry = condition.id;
    let bodyStatement: ts.Statement;
    let incrementor: ts.Expression | undefined;
    let hasCondition = true;
    if (ts.isWhileStatement(statement)) bodyStatement = statement.statement;
    else if (ts.isDoStatement(statement)) { bodyStatement = statement.statement; isPostTest = true; }
    else if (ts.isForStatement(statement)) {
      bodyStatement = statement.statement;
      incrementor = statement.incrementor;
      hasCondition = statement.condition !== undefined;
      if (statement.initializer) {
        const init = atom(statement.initializer, "loop_initializer");
        connect(init.exits, condition.id);
        loopEntry = init.entry!;
      }
    } else {
      bodyStatement = statement.statement;
    }
    const continueTo = incrementor ? addBlock("loop_increment", incrementor).id : condition.id;
    const body = compile(bodyStatement, { continue_to: continueTo, breaks });
    if (isPostTest && body.entry) loopEntry = body.entry;
    if (isPostTest) {
      connect(body.exits, condition.id, true);
      if (body.entry) addEdge(condition.id, body.entry, "true", true);
      else addEdge(condition.id, condition.id, "true", true);
    } else {
      if (body.entry) addEdge(condition.id, body.entry, "true");
      else addEdge(condition.id, condition.id, "true");
      if (incrementor) {
        connect(body.exits.map(edge => ({ ...edge, kind: edge.kind === "normal" ? "increment" : edge.kind })), continueTo);
      } else connect(body.exits, continueTo, true);
      if (incrementor) addEdge(continueTo, condition.id, "loop_back", true);
    }
    const exits: PendingEdge[] = hasCondition ? [{ from_block_id: condition.id, kind: "false" }] : [];
    for (const id of breaks) exits.push({ from_block_id: id, kind: "break" });
    return { entry: loopEntry, exits };
  };
  const compile = (statement: ts.Statement, loop?: LoopTarget): Fragment => {
    if (ts.isBlock(statement)) return compileSequence(statement.statements, loop);
    if (ts.isIfStatement(statement)) {
      const condition = addBlock("condition", statement.expression);
      const thenPart = compile(statement.thenStatement, loop);
      const elsePart = statement.elseStatement ? compile(statement.elseStatement, loop) : undefined;
      if (thenPart.entry) addEdge(condition.id, thenPart.entry, "true");
      const exits = thenPart.entry ? thenPart.exits : [{ from_block_id: condition.id, kind: "true" }];
      if (elsePart?.entry) addEdge(condition.id, elsePart.entry, "false");
      const falseExits = elsePart ? (elsePart.entry ? elsePart.exits : [{ from_block_id: condition.id, kind: "false" }]) : [{ from_block_id: condition.id, kind: "false" }];
      return { entry: condition.id, exits: [...exits, ...falseExits] };
    }
    if (ts.isWhileStatement(statement) || ts.isDoStatement(statement) || ts.isForStatement(statement)
      || ts.isForInStatement(statement) || ts.isForOfStatement(statement)) return compileLoop(statement as ts.IterationStatement, ts.isDoStatement(statement));
    if (ts.isReturnStatement(statement)) {
      const block = addBlock("return", statement); returns.push(block.id); return { entry: block.id, exits: [] };
    }
    if (ts.isThrowStatement(statement)) {
      const block = addBlock("throw", statement); throws.push(block.id); return { entry: block.id, exits: [] };
    }
    if (ts.isBreakStatement(statement)) {
      const block = addBlock("break", statement);
      if (statement.label || !loop) { unsupported.add("BreakStatement"); return { entry: block.id, exits: [{ from_block_id: block.id, kind: "normal" }] }; }
      loop.breaks.push(block.id); return { entry: block.id, exits: [] };
    }
    if (ts.isContinueStatement(statement)) {
      const block = addBlock("continue", statement);
      if (statement.label || !loop) { unsupported.add("ContinueStatement"); return { entry: block.id, exits: [{ from_block_id: block.id, kind: "normal" }] }; }
      addEdge(block.id, loop.continue_to, "continue"); return { entry: block.id, exits: [] };
    }
    if (ts.isSwitchStatement(statement) || ts.isTryStatement(statement) || ts.isLabeledStatement(statement)) unsupported.add(ts.SyntaxKind[statement.kind]);
    return atom(statement);
  };

  const inspectExpressionFlow = (node: ts.Node): void => {
    if (isFunctionLike(node)) return;
    if (ts.isConditionalExpression(node)) unsupported.add("ConditionalExpression");
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind))
      unsupported.add("ShortCircuitExpression");
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && node.questionDotToken)
      unsupported.add("OptionalChain");
    if (ts.isYieldExpression(node)) unsupported.add("YieldExpression");
    ts.forEachChild(node, inspectExpressionFlow);
  };

  const entry = addBlock("entry");
  const normalExit = addBlock("exit");
  const exceptionExit = addBlock("exception_exit");
  inspectExpressionFlow(body);
  let fragment: Fragment;
  if (ts.isBlock(body)) fragment = compileSequence(body.statements);
  else fragment = atom(body, "expression_body");
  if (fragment.entry) addEdge(entry.id, fragment.entry, "entry");
  else addEdge(entry.id, normalExit.id, "normal");
  connect(fragment.exits, normalExit.id);
  for (const id of returns) addEdge(id, normalExit.id, "return");
  for (const id of throws) addEdge(id, exceptionExit.id, "exception");
  const parseErrors = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length;
  if (parseErrors) unsupported.add("SyntaxErrors");
  return { symbol_id: symbolId, language: ["js", "jsx", "mjs", "cjs"].includes(extension) ? "javascript" : "typescript", granularity: "statement",
    blocks, edges, entry_block_id: entry.id, exit_block_id: normalExit.id, exception_exit_block_id: exceptionExit.id,
    status: unsupported.size ? "partial" : "complete", partial_reasons: [...unsupported].sort(), parse_error_count: parseErrors,
    source_content_included: false, control_flow_only: true, max_blocks: MAX_BLOCKS, max_edges: MAX_EDGES };
}
