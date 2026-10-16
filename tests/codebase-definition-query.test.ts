import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { matchDefinitionEdges } from "../capability/craft-codebase/definition-query.ts";

const edge = (id: string, kind: string, target: string, start = 4, end = 10): JsonObject => ({ id, kind, to_node_id: target, source_span: { start_offset: start, end_offset: end } });

test("definition lookup matches half-open source spans and de-duplicates target symbols deterministically", () => {
  const result = matchDefinitionEdges([
    edge("reference-b", "references", "target-b"), edge("call-a", "calls", "target-a"),
    edge("reference-a", "references", "target-a"), edge("outside", "calls", "outside", 0, 4),
  ], 4, 20);
  assert.deepEqual((result.candidates as JsonObject[]).map(item => item.id), ["call-a", "reference-b"]);
  assert.equal(result.candidate_count, 2);
  assert.equal(result.omitted_count, 0);
  assert.equal(result.ambiguous, true);
});

test("definition lookup filters unsupported and malformed graph facts and applies bounded results", () => {
  const result = matchDefinitionEdges([
    edge("a", "references", "target-a"), edge("b", "type_definition", "target-b"), edge("c", "implements", "ignored"),
    { id: "missing-target", kind: "calls", source_span: { start_offset: 4, end_offset: 10 } },
    edge("empty", "calls", "empty", 4, 4), edge("negative", "calls", "negative", -1, 10), edge("after", "calls", "after", 8, 10),
  ], 5, 1);
  assert.deepEqual((result.candidates as JsonObject[]).map(item => item.id), ["a"]);
  assert.equal(result.candidate_count, 2);
  assert.equal(result.omitted_count, 1);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(matchDefinitionEdges([], 0, 1), { candidates: [], candidate_count: 0, omitted_count: 0, ambiguous: false });
  assert.throws(() => matchDefinitionEdges([], -1, 1), /offset/);
  assert.throws(() => matchDefinitionEdges([], 0, 0), /limit/);
});
