import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { buildDataFlowGraph, createDataFlowCompilerHost, solveDataFlowFixedPoint } from "../capability/craft-codebase/data-flow.ts";
import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";

function analyze(content: string, name = "run", variable = "value"): JsonObject {
  const match = new RegExp(`function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=`).exec(content);
  assert(match, `expected declaration for ${name}`);
  const offset = content.indexOf(name, match.index);
  return buildDataFlowGraph(content, "src/flow.ts", `symbol_${name}`, offset, variable);
}

function asObjects(value: unknown): JsonObject[] { return value as JsonObject[]; }

test("data flow tracks straight-line reassignments without source text", () => {
  const result = analyze("function run(input: number) { let value = 0; value = input; consume(value); value = 2; return value; }");
  assert.equal(result.status, "complete");
  assert.equal(result.source_content_included, false);
  const definitions = asObjects(result.definitions);
  const uses = asObjects(result.uses);
  const flows = asObjects(result.flows);
  assert.equal(definitions.length, 3);
  assert.equal(uses.length, 2);
  const firstUse = uses[0]!;
  const lastUse = uses[1]!;
  assert.deepEqual(flows.filter(flow => flow.to_use_id === firstUse.id).map(flow => flow.from_definition_id), [definitions[1]!.id]);
  assert.deepEqual(flows.filter(flow => flow.to_use_id === lastUse.id).map(flow => flow.from_definition_id), [definitions[2]!.id]);
  assert(!JSON.stringify(result).includes("consume(value)"));
});

test("branch and loop merges retain every possible reaching definition", () => {
  const branch = analyze("function run(flag: boolean) { let value = 0; if (flag) { value = 1; } else { value = 2; } return value; }");
  const branchDefs = asObjects(branch.definitions);
  const branchUse = asObjects(branch.uses).at(-1)!;
  const branchSources = asObjects(branch.flows).filter(flow => flow.to_use_id === branchUse.id).map(flow => flow.from_definition_id);
  assert.equal(branch.status, "complete");
  assert.deepEqual(new Set(branchSources), new Set(branchDefs.slice(1).map(definition => definition.id)));

  const loop = analyze("function run(flag: boolean) { let value = 0; while (flag) { value = value + 1; } return value; }");
  const loopDefs = asObjects(loop.definitions);
  const loopUse = asObjects(loop.uses).at(-1)!;
  const loopSources = asObjects(loop.flows).filter(flow => flow.to_use_id === loopUse.id).map(flow => flow.from_definition_id);
  assert.equal(loop.status, "complete");
  assert.deepEqual(new Set(loopSources), new Set(loopDefs.filter(definition => definition.source !== "parameter").map(definition => definition.id)));
});

test("unreachable assignments after a terminal statement are excluded from may-reach flows", () => {
  const source = "function run() { let value = 1; return value; value = 2; return value; }";
  const result = analyze(source);
  const definitions = asObjects(result.definitions), uses = asObjects(result.uses), flows = asObjects(result.flows);
  assert.equal(result.status, "complete");
  assert.deepEqual(definitions.map(definition => definition.reachable), [true, false]);
  assert.deepEqual(uses.map(use => use.reachable), [true, false]);
  assert.deepEqual(flows.map(flow => [flow.from_definition_id, flow.to_use_id]), [[definitions[0]!.id, uses[0]!.id]]);
});

test("shadowed variables are reported as ambiguous and unsupported CFG syntax stays partial", () => {
  const shadowed = analyze("function run() { let value = 0; { let value = 2; consume(value); } return value; }");
  assert.equal(shadowed.status, "ambiguous");
  assert.equal(asObjects(shadowed.candidates).length, 2);
  const unsupported = analyze("function run() { const value = 1; try { consume(value); } catch {} return value; }");
  assert.equal(unsupported.status, "partial");
  assert((unsupported.partial_reasons as string[]).includes("TryStatement"));
});

test("parameters, compound assignments and increments preserve local definitions", () => {
  const parameter = analyze("function run(value: number) { consume(value); }");
  assert.equal(parameter.status, "complete");
  assert.equal(asObjects(parameter.candidates)[0]!.kind, "parameter");
  assert.equal(asObjects(parameter.definitions)[0]!.source, "parameter");
  assert.equal(asObjects(parameter.flows).length, 1);
  const compound = analyze("function run() { let value = 1; value += 2; ++value; value--; return value; }");
  assert.equal(compound.status, "complete");
  assert.equal(asObjects(compound.definitions).filter(definition => definition.source === "assignment").length, 1);
  assert.equal(asObjects(compound.definitions).filter(definition => definition.source === "increment").length, 2);
  assert.equal(asObjects(compound.uses).length, 4);
});

test("function-valued declarations, methods and nested closures use only the selected body", () => {
  const arrow = analyze("const run = (input: number) => { const value = input; return value; }");
  assert.equal(arrow.status, "complete");
  assert.equal(asObjects(arrow.uses).length, 1);
  const arrowParameter = analyze("const run = (input: number) => consume(input);", "run", "input");
  assert.equal(asObjects(arrowParameter.candidates)[0]!.kind, "parameter");
  assert.equal(asObjects(arrowParameter.flows).length, 1);
  const methodSource = "class Example { run() { let value = 1; const nested = () => value; return value; } }";
  const method = buildDataFlowGraph(methodSource, "src/flow.ts", "symbol_run", methodSource.indexOf("run"), "value");
  assert.equal(method.status, "complete");
  assert.equal(asObjects(method.uses).length, 1);
  const propertySource = "class Example { run = () => { let value = 1; return value; } }";
  assert.equal(buildDataFlowGraph(propertySource, "src/flow.ts", "symbol_run", propertySource.indexOf("run"), "value").status, "complete");
  const jsxSource = "function run() { const value = 1; return value; }";
  assert.equal(buildDataFlowGraph(jsxSource, "src/flow.jsx", "symbol_run", jsxSource.indexOf("run"), "value").status, "complete");
  assert.equal(buildDataFlowGraph(jsxSource, "src/flow.tsx", "symbol_run", jsxSource.indexOf("run"), "value").status, "complete");
  assert.equal(buildDataFlowGraph(jsxSource, "src/flow.mjs", "symbol_run", jsxSource.indexOf("run"), "value").status, "complete");
  assert.equal(buildDataFlowGraph(jsxSource, "src/flow.cjs", "symbol_run", jsxSource.indexOf("run"), "value").status, "complete");
});

test("destructuring and parse errors stay partial instead of claiming complete flow", () => {
  const destructured = analyze("function run(obj: { value: number }) { const { value } = obj; return value; }");
  assert.equal(destructured.status, "partial");
  assert((destructured.partial_reasons as string[]).includes("DestructuredVariable"));
  const unusedDestructured = analyze("function run(obj: { value: number }) { const { value } = obj; }");
  assert.equal(unusedDestructured.status, "partial");
  const malformed = analyze("function run() { const value = ; return value; }");
  assert.equal(malformed.status, "partial");
  assert((malformed.partial_reasons as string[]).includes("SyntaxErrors"));
});

test("event and flow limits report partial results", () => {
  const manyUses = `function run() { let value = 1; consume(${Array.from({ length: 2_100 }, () => "value").join(",")}); }`;
  const events = analyze(manyUses);
  assert.equal(events.status, "partial");
  assert((events.partial_reasons as string[]).includes("EventBudgetExceeded"));
  const assignments = Array.from({ length: 100 }, (_, index) => `if (flag${index}) value = ${index + 1};`).join(" ");
  const repeatedUses = Array.from({ length: 50 }, () => "consume(value);").join(" ");
  const flows = analyze(`function run() { let value = 0; ${assignments} ${repeatedUses} }`);
  assert.equal(flows.status, "partial");
  assert((flows.partial_reasons as string[]).includes("FlowBudgetExceeded"));
});

test("candidate budget, source-name filtering and CFG iteration budget remain explicit", () => {
  const scopes = Array.from({ length: 33 }, (_, index) => `{ let value = ${index}; consume(value); }`).join(" ");
  const candidates = analyze(`function run() { ${scopes} }`);
  assert.equal(candidates.status, "partial");
  assert((candidates.partial_reasons as string[]).includes("VariableCandidateBudgetExceeded"));
  const propAccess = analyze("function run(obj: { value?: number }) { let value = 1; return obj?.value ?? value; }");
  assert.equal(propAccess.status, "partial");
  const label = analyze("function run() { let value = 1; value: { consume(value); break value; } return value; }");
  assert.equal(label.status, "partial");
  const loopVariable = analyze("function run(values: number[]) { for (const value of values) consume(value); }");
  assert.equal(loopVariable.status, "partial");
  assert((loopVariable.partial_reasons as string[]).includes("UnmappedDefinition"));
  const loopTarget = analyze("function run(values: number[], value: number) { for (value of values) consume(value); }");
  assert.equal(loopTarget.status, "partial");
  assert((loopTarget.partial_reasons as string[]).includes("UnmappedUse"));
  const sameBlock = analyze("function run() { let value = 0; value = (value = 1); return value; }");
  assert.equal(sameBlock.status, "complete");
  const alias = analyze("function run() { let value = 1; const alias = value; consume(alias); }");
  assert((alias.partial_reasons as string[]).includes("AliasFlowNotModeled"));
  const aliasAssignment = analyze("function run() { let value = 1; let alias = 0; alias = value; consume(alias); }");
  assert((aliasAssignment.partial_reasons as string[]).includes("AliasFlowNotModeled"));
  const sameVariableAssignment = analyze("function run() { let value = 1; value = value; return value; }");
  assert.equal(sameVariableAssignment.status, "complete");
  const fieldWrite = analyze("function run() { const value = { field: 0 }; value.field = 1; return value; }");
  assert((fieldWrite.partial_reasons as string[]).includes("FieldOrDestructuredWriteNotModeled"));
  const destructureWrite = analyze("function run(source: { value: number }) { let value = 0; ({ value } = source); return value; }");
  assert((destructureWrite.partial_reasons as string[]).includes("FieldOrDestructuredWriteNotModeled"));
  const source = ts.createSourceFile("/craft-checkpoint/src/flow.ts", "function run() {}", ts.ScriptTarget.Latest, true);
  const host = createDataFlowCompilerHost("/craft-checkpoint/src/flow.ts", "function run() {}", source);
  assert.equal(host.fileExists("/craft-checkpoint/src/flow.ts"), true);
  assert.equal(host.fileExists("/outside.ts"), false);
  assert.equal(host.readFile("/craft-checkpoint/src/flow.ts"), "function run() {}");
  assert.equal(host.readFile("/outside.ts"), undefined);
  assert.equal(host.getSourceFile("/craft-checkpoint/src/flow.ts", ts.ScriptTarget.Latest), source);
  assert.equal(host.getSourceFile("/outside.ts", ts.ScriptTarget.Latest), undefined);
  const limited = solveDataFlowFixedPoint([{ id: "entry" }], [], new Map(), [], 0);
  assert.equal(limited.exceeded, true);
  const emptyGraph = solveDataFlowFixedPoint([], [], new Map(), []);
  assert.equal(emptyGraph.reachable.size, 0);
  assert.equal(emptyGraph.incoming.size, 0);
  assert.equal(emptyGraph.exceeded, false);
  const unknownPredecessor = solveDataFlowFixedPoint([{ id: "entry" }], [{ from_block_id: "outside", to_block_id: "entry" }], new Map(), []);
  assert.equal(unknownPredecessor.exceeded, false);
  const sourceText = "function run() { let value = 1; return value; }";
  const limitedGraph = buildDataFlowGraph(sourceText, "src/flow.ts", "run", sourceText.indexOf("run"), "value", { fixed_point_step_limit: 0 });
  assert((limitedGraph.partial_reasons as string[]).includes("FixedPointBudgetExceeded"));
  const key = analyze("function run() { let value = 1; const object = { value: 2 }; return object.value + value; }");
  assert.equal(asObjects(key.uses).length, 1);
  const unsupportedFunction = "class run {}";
  assert.throws(() => buildDataFlowGraph(unsupportedFunction, "src/flow.ts", "run", unsupportedFunction.indexOf("run"), "value"), /requires an indexed function/u);
});

test("data flow rejects invalid targets and bounds source size", () => {
  assert.throws(() => buildDataFlowGraph("function run() {}", "src/flow.ts", "run", -1, "value"), /outside the source/u);
  assert.throws(() => buildDataFlowGraph("x".repeat(1_000_001), "src/flow.ts", "run", 0, "value"), /1 MiB budget/u);
  assert.throws(() => buildDataFlowGraph("function run() {}", "src/flow.ts", "run", 0, " "), /variable name is invalid/u);
  assert.throws(() => buildDataFlowGraph("function run() {}", "src/flow.txt", "run", 0, "value"), /requires a TypeScript/u);
  assert.throws(() => buildDataFlowGraph("const run = 1;", "src/flow.ts", "run", 6, "value"), /requires an indexed function/u);
  assert.equal(analyze("function run() { return 1; }").status, "not_found");
});
