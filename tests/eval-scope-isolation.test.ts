import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The declared isolation level is `shared_local_store_scoped`, not per-trial
 * clean environments. That claim is only honest if the scopes used by the
 * store-backed cases are disjoint. This check reads the runner source so a new
 * case cannot silently reuse the Memory value scope and inflate that case.
 */
const source = readFileSync(new URL(import.meta.resolve("craft-eval/suite")), "utf8");
const pairedSource = readFileSync(new URL(import.meta.resolve("craft-eval/paired-value-runs")), "utf8");

const scopes = (block: string): string[] => {
  const start = source.indexOf(block);
  assert.ok(start >= 0, `missing case block: ${block}`);
  const nextMarker = /\n\/\/ -{10,}/u.exec(source.slice(start + block.length));
  const next = nextMarker ? start + block.length + nextMarker.index : -1;
  const section = source.slice(start, next >= 0 ? next : source.length);
  return [...section.matchAll(/scope_id:\s*"([^"]+)"/gu)].map((match) => match[1]!);
};

test("store-backed case blocks use disjoint workspace scopes", () => {
  const memoryScope = scopes('if (inScope("memory.scope_isolation"))');
  const valueScope = scopes('memoryAid: async () => {');
  assert.ok(memoryScope.length > 0, "the scope-isolation kernel case must declare a scope");
  assert.ok(valueScope.length > 0, "the Memory value case must declare a scope");
  const overlap = memoryScope.filter((scope) => valueScope.includes(scope));
  assert.deepEqual(overlap, [], "the Memory aid must not be visible to the scope-isolation kernel case");
  assert.ok(valueScope.every((scope) => scope.startsWith("eval-memory")),
    "the value aid keeps a dedicated eval-only namespace");
});

test("the Memory value case reads through the real search path, not a literal", () => {
  const start = source.indexOf("memoryAid: async () => {");
  const memorySection = source.slice(start, source.indexOf("for (const outcome", start));
  assert.match(memorySection, /service\.memorySearch\(/u, "the aid must come from the Memory kernel");
  assert.match(memorySection, /service\.memoryLedgerRemember\(/u, "the rule must be written as a governed record");
  // The runner never inlines the fact into the aided prompt; it uses whatever
  // the kernel returned, so a retrieval miss cannot fake a pass.
  assert.match(pairedSource, /memorySupplyAidedPrompt\(memory\.text\)/u,
    "the aided prompt is built from the retrieved text");
  // The declared scenario object starts with a default prompt, but the Memory
  // branch must replace it with the kernel result before any model turn.
  const memoryBranch = pairedSource.slice(pairedSource.indexOf('scenario.id === "context_supply.memory_hit_replaces_repetition"'));
  const branchBody = memoryBranch.slice(0, memoryBranch.indexOf("const paired = await observePair"));
  assert.match(branchBody, /memory\.text/u);
  assert.match(branchBody, /memorySupplyAidedPrompt\(memory\.text\)/u);
  assert.doesNotMatch(branchBody, /memorySupplyAidedPrompt\(MEMORY_SUPPLY_FACT\)/u);
});
