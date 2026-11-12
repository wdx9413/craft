import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { analyzeTypeScript } from '@craft/capability-codebase/typescript-analysis';

const file = (path: string, content: string) =>
  ({ path, content, digest: createHash("sha256").update(content).digest("hex"), language: "typescript" });

test("unresolved relations separate external references from internal gaps", () => {
  const source = [
    'import { readFileSync } from "node:fs";',
    'import { missing } from "./missing";',
    'readFileSync("x");',
    "const pending: Promise<void> = undefined as unknown as Promise<void>;",
    "class Example implements MissingShape {}",
    'fetch("https://example.invalid");',
    "(() => 1)();",
    "notDefined();",
  ].join("\n");
  const diagnostics = analyzeTypeScript([file("main.ts", source)]).diagnostics as JsonObject;

  // A checkpoint analysis has no standard library and cannot follow packages:
  // `node:fs`, `Promise` and `fetch` are external, not broken internal edges.
  // `node:fs` (import + call), `Promise` and `fetch` are external.
  assert(diagnostics.external_references as number >= 4, JSON.stringify(diagnostics));
  // An immediately-invoked arrow has no declaration to point at, so it is not a
  // relation gap either.
  assert(diagnostics.inline_invocations as number >= 1, JSON.stringify(diagnostics));
  // A relative import that does not exist is an internal gap.
  assert.equal(diagnostics.unresolved_imports, 1);
  // An unknown heritage clause and an unknown local call are internal gaps.
  assert.equal(diagnostics.unresolved_heritage, 1);
  assert.equal(diagnostics.unresolved_calls, 1);

  const summed = (diagnostics.unresolved_type_references as number) + (diagnostics.unresolved_heritage as number)
    + (diagnostics.unresolved_imports as number) + (diagnostics.unresolved_calls as number);
  assert.equal(diagnostics.unresolved_relations, summed, "unresolved_relations must equal the internal breakdown");
});

test("qualified builtin type names are external references", () => {
  const diagnostics = analyzeTypeScript([file("env.ts", "let env: NodeJS.ProcessEnv;")]).diagnostics as JsonObject;
  assert(diagnostics.external_references as number >= 1, JSON.stringify(diagnostics));
  assert.equal(diagnostics.unresolved_type_references, 0);
});

test("generic parameters and runtime-computed callees are not internal gaps", () => {
  const source = [
    "export function first<T>(items: T[]): T { return items[0]; }",
    "const table: Record<string, () => void> = {};",
    "table['run']!();",
    "(undefined as unknown as (() => void) ?? (() => 1))();",
  ].join("\n");
  const diagnostics = analyzeTypeScript([file("generic.ts", source)]).diagnostics as JsonObject;
  assert(diagnostics.local_type_parameters as number >= 1, JSON.stringify(diagnostics));
  assert(diagnostics.computed_invocations as number >= 1, JSON.stringify(diagnostics));
  // `T` is bound locally and a computed callee has no declaration to point at:
  // neither may be reported as a broken internal relation.
  assert.equal(diagnostics.unresolved_type_references, 0);
});

test("a non-null asserted method call resolves to the same target as the plain call", () => {
  const api = file("api.ts", "export interface Api { launch(): void }\nexport declare const svc: Api;\n");
  const caller = file("caller.ts", 'import { svc } from "./api";\nexport function go() { svc.launch!(); }\n');
  const analysis = analyzeTypeScript([api, caller]);
  const launch = (analysis.nodes as JsonObject[]).find((node) => node.name === "launch");
  const go = (analysis.nodes as JsonObject[]).find((node) => node.name === "go");
  assert(launch && go, JSON.stringify((analysis.nodes as JsonObject[]).map((node) => node.name)));
  assert((analysis.edges as JsonObject[]).some((edge) => edge.kind === "calls"
    && edge.from_node_id === go!.id && edge.to_node_id === launch!.id),
    "svc.launch!() must resolve like svc.launch()");
});

test("a destructured dynamic import resolves its call to the target module's declaration", () => {
  const moduleFile = file("kernel.ts", "export class Kernel { run(): void {} }\nexport function helper(): void {}\n");
  const caller = file("caller.ts", [
    'export async function go() {',
    '  const { Kernel, helper } = await import("./kernel.ts");',
    '  new Kernel().run();',
    '  helper();',
    '}',
  ].join("\n"));
  const analysis = analyzeTypeScript([moduleFile, caller]);
  const kernel = (analysis.nodes as JsonObject[]).find((node) => node.name === "Kernel");
  const helper = (analysis.nodes as JsonObject[]).find((node) => node.name === "helper");
  const go = (analysis.nodes as JsonObject[]).find((node) => node.name === "go");
  assert(kernel && helper && go, JSON.stringify((analysis.nodes as JsonObject[]).map((node) => node.name)));
  const calls = analysis.edges as JsonObject[];
  assert(calls.some((edge) => edge.kind === "calls" && edge.from_node_id === go!.id && edge.to_node_id === kernel!.id),
    "new Kernel() through a dynamic import must resolve");
  assert(calls.some((edge) => edge.kind === "calls" && edge.from_node_id === go!.id && edge.to_node_id === helper!.id),
    "helper() through a dynamic import must resolve");
});

test("an ambiguous name inside a dynamically imported module is refused, not guessed", () => {
  // Two declarations called `run` live in the imported module, so the dynamic
  // binding cannot be pinned to one of them without inventing an edge.
  const moduleFile = file("dup.ts", "export function run(): void {}\nexport class Holder { run(): void {} }\n");
  const caller = file("caller2.ts", 'export async function go() { const { run } = await import("./dup.ts"); run(); }\n');
  const analysis = analyzeTypeScript([moduleFile, caller]);
  const callerNode = (analysis.nodes as JsonObject[]).find((node) => node.name === "go")!;
  const edges = (analysis.edges as JsonObject[]).filter((edge) => edge.kind === "calls" && edge.from_node_id === callerNode.id);
  assert.equal(edges.length, 0, JSON.stringify(edges));
  const d = analysis.diagnostics as JsonObject;
  assert(d.unresolved_calls as number >= 1, "the ambiguous call stays an honest internal gap");
});
