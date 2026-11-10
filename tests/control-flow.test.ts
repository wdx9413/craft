import assert from "node:assert/strict";
import test from "node:test";
import { buildControlFlowGraph } from "../capability/craft-codebase/control-flow.ts";

function flow(source: string, name: string, path = "src/example.ts") {
  const offset = source.indexOf(name);
  assert.notEqual(offset, -1);
  return buildControlFlowGraph(source, path, `symbol_${name}`, offset);
}

test("control flow emits source-free branch and return edges for an indexed declaration", () => {
  const result = flow("export function choose(flag: boolean) { if (flag) { return 1; } else { return 0; } }", "choose");
  const blocks = result.blocks as Array<Record<string, unknown>>;
  const edges = result.edges as Array<Record<string, unknown>>;
  assert.equal(result.status, "complete");
  assert.equal(result.granularity, "statement");
  assert.equal(result.source_content_included, false);
  assert.equal(blocks.some(block => block.syntax_kind === "IfStatement"), false);
  assert.deepEqual(edges.filter(edge => edge.kind === "true" || edge.kind === "false").map(edge => edge.kind).sort(), ["false", "true"]);
  assert.equal(edges.filter(edge => edge.kind === "return").length, 2);
  assert.equal(blocks.filter(block => block.kind === "return").length, 2);
  assert.equal(blocks.every(block => typeof (block.span as Record<string, unknown>).start_line === "number"), true);
});

test("control flow handles while, for-in and break/continue loop exits", () => {
  const result = flow("function run(items: string[]) { while (items.length) { if (items.length < 2) continue; if (items.length === 4) break; } for (const item in items) { if (item) break; } return; }", "run");
  const edges = result.edges as Array<Record<string, unknown>>;
  assert.equal(result.status, "complete");
  assert(edges.some(edge => edge.loop_back === true));
  assert(edges.some(edge => edge.kind === "continue"));
  assert(edges.some(edge => edge.kind === "break"));
  assert(edges.some(edge => edge.kind === "false"));
});

test("control flow handles post-test loops, for increments, throws, and expression-bodied arrows", () => {
  const post = flow("function post(value: boolean) { do { value = !value; } while (value); }", "post");
  assert((post.edges as Array<Record<string, unknown>>).some(edge => edge.kind === "true"));
  const counted = flow("function count() { for (let i = 0; i < 3; i++) { if (i) continue; tick(i); } throw new Error('x'); }", "count");
  const countedEdges = counted.edges as Array<Record<string, unknown>>;
  assert(countedEdges.some(edge => edge.kind === "increment"));
  assert(countedEdges.some(edge => edge.kind === "false"));
  assert(countedEdges.some(edge => edge.kind === "increment" && (counted.blocks as Array<Record<string, unknown>>).some(block => block.id === edge.to_block_id && block.kind === "loop_increment")));
  assert(countedEdges.some(edge => edge.kind === "loop_back"));
  assert(countedEdges.some(edge => edge.kind === "exception"));
  assert((counted.blocks as Array<Record<string, unknown>>).some(block => block.kind === "exception_exit"));
  const branchToIncrement = flow("function branchToIncrement() { for (let i = 0; i < 2; i++) { if (i) continue; } }", "branchToIncrement");
  assert((branchToIncrement.edges as Array<Record<string, unknown>>).some(edge => edge.kind === "false"
    && (branchToIncrement.blocks as Array<Record<string, unknown>>).some(block => block.id === edge.to_block_id && block.kind === "loop_increment")));
  const arrow = flow("const double = (value: number) => value * 2;", "double");
  assert.equal(arrow.status, "complete");
  assert((arrow.blocks as Array<Record<string, unknown>>).some(block => block.kind === "expression_body"));
});

test("control flow handles empty bodies, for-of, infinite loops, methods and function-valued properties", () => {
  const nestedFunction = flow("function outer() { function inner() { return 1; } return inner(); }", "outer");
  assert.equal((nestedFunction.blocks as Array<Record<string, unknown>>).filter(block => block.kind === "return").length, 1);
  const emptySequence = flow("function emptySequence() { {} return; }", "emptySequence");
  assert((emptySequence.blocks as Array<Record<string, unknown>>).some(block => block.kind === "return"));
  const emptyElse = flow("function emptyElse(flag: boolean) { if (flag) {} else {} }", "emptyElse");
  assert.equal((emptyElse.edges as Array<Record<string, unknown>>).filter(edge => edge.kind === "true" || edge.kind === "false").length, 2);
  const empty = flow("function empty() {}", "empty");
  assert.equal((empty.edges as Array<Record<string, unknown>>).some(edge => edge.kind === "normal"), true);
  const postEmpty = flow("function postEmpty(flag: boolean) { do {} while (flag); }", "postEmpty");
  assert((postEmpty.edges as Array<Record<string, unknown>>).some(edge => edge.loop_back === true));
  const emptyLoop = flow("function infinite() { for (;;) {} }", "infinite");
  assert.equal((emptyLoop.edges as Array<Record<string, unknown>>).some(edge => edge.kind === "false"), false);
  const iterable = flow("function each(items: string[]) { for (const item of items) {} }", "each");
  assert.equal(iterable.status, "complete");
  const method = flow("class Runner { run() { return 1; } }", "run");
  assert.equal(method.status, "complete");
  const property = flow("class Runner { run = () => 1; }", "run");
  assert.equal(property.status, "complete");
  assert.throws(() => flow("class Runner { field = 1; }", "field"), /requires an indexed function/u);
});

test("control flow selects TypeScript and JavaScript parser modes from the checkpoint extension", () => {
  for (const path of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs"]) {
    const result = flow("export function run() { return 1; }", "run", path);
    assert.equal(result.status, "complete", path);
    assert.equal(result.language, /\.(?:js|jsx|mjs|cjs)$/u.test(path) ? "javascript" : "typescript", path);
  }
  assert.throws(() => flow("function run() {}", "run", "Makefile"), /TypeScript or JavaScript source file/u);
  assert.throws(() => flow("function run() {}", "run", ""), /TypeScript or JavaScript source file/u);
});

test("unsupported flow constructs are explicit partial results and malformed syntax is reported", () => {
  const result = flow("function route(x: number) { try { switch (x) { case 1: return 1; } } catch { return 0; } }", "route");
  assert.equal(result.status, "partial");
  assert.deepEqual(result.partial_reasons, ["TryStatement"]);
  const switchResult = flow("function choose(x: number) { switch (x) { case 1: return 1; default: return 0; } }", "choose");
  assert.deepEqual(switchResult.partial_reasons, ["SwitchStatement"]);
  const labeled = flow("function labeled() { label: { break label; } }", "labeled");
  assert.equal(labeled.status, "partial");
  const outsideLoop = flow("function noLoop() { break; continue; }", "noLoop");
  assert.equal(outsideLoop.status, "partial");
  const conditional = flow("function conditional(value: boolean) { return value ? 1 : 0; }", "conditional");
  assert.deepEqual(conditional.partial_reasons, ["ConditionalExpression"]);
  const shortCircuit = flow("function shortCircuit(left: boolean, right: boolean) { if (left && right) return 1; return 0; }", "shortCircuit");
  assert.deepEqual(shortCircuit.partial_reasons, ["ShortCircuitExpression"]);
  const optional = flow("function optional(value?: { run?: () => void }) { value?.run?.(); }", "optional");
  assert.deepEqual(optional.partial_reasons, ["OptionalChain"]);
  const generator = flow("function* generator() { yield 1; }", "generator");
  assert.deepEqual(generator.partial_reasons, ["YieldExpression"]);
  const malformed = flow("function broken() { if ( ) return 1; }", "broken");
  assert.equal(malformed.status, "partial");
  assert((malformed.partial_reasons as string[]).includes("SyntaxErrors"));
});

test("control flow rejects unknown symbols, unsafe offsets, oversized source and block overflow", () => {
  assert.throws(() => flow("const value = 1;", "value"), /requires an indexed function/u);
  assert.throws(() => buildControlFlowGraph("function a() {}", "a.ts", "a", -1), /outside the source snapshot/u);
  assert.throws(() => buildControlFlowGraph("x".repeat(1_000_001), "a.ts", "a", 0), /1 MiB budget/u);
  const statements = Array.from({ length: 500 }, () => "x();").join("\n");
  assert.throws(() => flow(`function large() { ${statements} }`, "large"), /block budget/u);
  const branches = Array.from({ length: 450 }, () => "if (ready) {}" ).join("\n");
  assert.throws(() => flow(`function manyEdges() { ${branches} }`, "manyEdges"), /edge budget/u);
  assert.throws(() => flow("class Example {}", "Example"), /requires an indexed function/u);
});
