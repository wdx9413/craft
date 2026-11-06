import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { analyzeTypeScript } from "../capability/craft-codebase/typescript-analysis.ts";

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
