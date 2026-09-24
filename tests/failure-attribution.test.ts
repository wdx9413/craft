import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_INTERNAL_AUTHORIZATION, authorizedTools, classifyTool } from "../core/internal-tool-authorization.ts";
import { McpServer, TOOLS } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { FAILURE_CLASSES, attributeFailure, summarizeAttributions } from "../core/failure-attribution.ts";

test("v0.12.38 names each failure class from its distinguishing signal", () => {
  // One signal per class, asserted in pipeline order.
  const cases: Array<[JsonObject, string]> = [
    [{ evidence_already_in_input: true }, "echo_gap"],
    [{ source_contained_answer: false }, "coverage_gap"],
    [{ superseded_by_newer: true }, "revision_gap"],
    [{ wrong_scope_applied: true }, "scope_gap"],
    [{ wrong_time_applied: true }, "temporal_gap"],
    [{ relevant_retrieved: false }, "retrieval_gap"],
    [{ answer_in_context: false }, "retrieval_gap"],
    [{ fact_extracted: false }, "grounding_gap"],
    [{ answer_wrong_with_full_context: true }, "synthesis_gap"],
  ];
  for (const [input, expected] of cases) {
    const result = attributeFailure(input);
    assert.equal(result.failure_class, expected, `${JSON.stringify(input)} -> ${String(result.failure_class)}`);
    assert.equal(result.attributed, true);
    assert.equal(typeof result.remedy, "string");
    assert.notEqual(String(result.remedy).length, 0);
  }
  // Every class except the fallback is reachable, so the taxonomy is not
  // decorative.
  const reachable = new Set(cases.map(([, expected]) => expected));
  for (const name of FAILURE_CLASSES) {
    if (name === "unattributed") continue;
    assert.equal(reachable.has(name), true, `${name} has no covering signal`);
  }
});

test("v0.12.38 refuses to name a cause it cannot support", () => {
  // The central rule: a plausible cause is worse than an admitted gap, because
  // a wrong cause produces a confident, useless, permanently repeated lesson.
  const empty = attributeFailure({});
  assert.equal(empty.failure_class, "unattributed");
  assert.equal(empty.attributed, false);
  assert.deepEqual(empty.observed_signals, []);
  assert.equal(empty.observed_count, 0);

  // `false` is an observation, not an absence: telling them apart is the
  // difference between "it was not the case" and "we never looked".
  assert.equal(attributeFailure({ wrong_scope_applied: false, wrong_time_applied: false }).failure_class, "unattributed");
  assert.equal(attributeFailure({ wrong_scope_applied: false }).observed_count, 1);
});

test("v0.12.38 attributes by pipeline position, not by which signal arrived", () => {
  // A fact absent from the source cannot also have been mis-scoped. Naming the
  // downstream cause would send the fix to the wrong layer.
  const multi = attributeFailure({
    source_contained_answer: false, relevant_retrieved: false, wrong_scope_applied: true,
    wrong_time_applied: true, fact_extracted: false, answer_wrong_with_full_context: true,
  });
  assert.equal(multi.failure_class, "coverage_gap");

  // Circular evidence outranks everything: with the evidence already in the input,
  // no downstream conclusion is trustworthy, so it is named first.
  assert.equal(attributeFailure({ evidence_already_in_input: true, source_contained_answer: false }).failure_class, "echo_gap");
  assert.equal(attributeFailure({ evidence_already_in_input: true, wrong_scope_applied: true, relevant_retrieved: false }).failure_class, "echo_gap");

  // Revision outranks scope: recalling the right fact and ignoring that it was
  // superseded is a revision failure, not a search failure.
  assert.equal(attributeFailure({ superseded_by_newer: true, wrong_scope_applied: true }).failure_class, "revision_gap");
  // Scope outranks retrieval.
  assert.equal(attributeFailure({ wrong_scope_applied: true, relevant_retrieved: false }).failure_class, "scope_gap");
  // Retrieval outranks extraction.
  assert.equal(attributeFailure({ relevant_retrieved: false, fact_extracted: false }).failure_class, "retrieval_gap");
  // Extraction outranks synthesis.
  assert.equal(attributeFailure({ fact_extracted: false, answer_wrong_with_full_context: true }).failure_class, "grounding_gap");
  // A fully observed success path attributes nothing, correctly.
  assert.equal(attributeFailure({
    source_contained_answer: true, relevant_retrieved: true, answer_in_context: true,
    fact_extracted: true, superseded_by_newer: false, wrong_scope_applied: false,
    wrong_time_applied: false, answer_wrong_with_full_context: false,
  }).failure_class, "unattributed");
});

test("v0.12.38 counts how much of the picture was actually observed", () => {
  const partial = attributeFailure({ source_contained_answer: false });
  assert.equal(partial.observed_count, 1);
  // Nine signals now, including the contamination check.
  assert.equal(partial.total_signals, 9);
  assert.deepEqual(partial.observed_signals, ["source_contained_answer"]);

  const full = attributeFailure({
    evidence_already_in_input: false,
    source_contained_answer: true, relevant_retrieved: false, answer_in_context: true,
    fact_extracted: true, superseded_by_newer: false, wrong_scope_applied: false,
    wrong_time_applied: false, answer_wrong_with_full_context: false,
  });
  assert.equal(full.observed_count, 9);
  // Signals are sorted, so the record is stable across runs.
  const signals = full.observed_signals as string[];
  assert.deepEqual(signals, [...signals].sort());
});

test("v0.12.38 catches a memory claim that was really the current turn", () => {
  // The contamination that makes a system look like it remembers when it is only
  // repeating what it was just told. The answer itself is fine, which is exactly
  // why the claim needs its own class: nothing else in this taxonomy fires.
  const echoed = attributeFailure({ evidence_already_in_input: true });
  assert.equal(echoed.failure_class, "echo_gap");
  assert.equal(echoed.attributed, true);
  assert.match(String(echoed.remedy), /echoing, not recall/u);

  // Observing that the evidence was independent is a real observation, and it must
  // not be confused with having never checked.
  const independent = attributeFailure({ evidence_already_in_input: false });
  assert.equal(independent.failure_class, "unattributed");
  assert.equal(independent.observed_count, 1);

  assert.throws(() => attributeFailure({ evidence_already_in_input: "yes" }), /evidence_already_in_input must be a boolean/u);
});

test("v0.12.38 rejects a malformed observation rather than coercing it", () => {
  // Truthy strings must not silently become `true`: that would turn a caller's
  // bug into a confident diagnosis.
  assert.throws(() => attributeFailure({ source_contained_answer: "yes" }), /source_contained_answer must be a boolean/u);
  assert.throws(() => attributeFailure({ relevant_retrieved: 1 }), /relevant_retrieved must be a boolean/u);
  assert.throws(() => attributeFailure({ answer_wrong_with_full_context: "true" }), /answer_wrong_with_full_context must be a boolean/u);
});

test("v0.12.38 ranks where the system is actually weakest", () => {
  const summary = summarizeAttributions({ failures: [
    { relevant_retrieved: false },
    { answer_in_context: false },
    { relevant_retrieved: false },
    { source_contained_answer: false },
    {},
  ] });
  assert.equal(summary.total, 5);
  assert.equal(summary.attributed, 4);
  assert.equal(summary.unattributed_count, 1);
  // Counted, then ordered by class name so the ranking is stable.
  assert.deepEqual(summary.ranking, [
    { failure_class: "retrieval_gap", count: 3 },
    { failure_class: "coverage_gap", count: 1 },
    { failure_class: "unattributed", count: 1 },
  ]);
  // The primary is the top *named* class: "unattributed" is never a fix target.
  assert.equal(summary.primary, "retrieval_gap");
  assert.deepEqual(summary.classes, FAILURE_CLASSES);
});

test("v0.12.38 reports an all-unattributed run as having no primary", () => {
  // Silence must not be reported as a finding.
  const summary = summarizeAttributions({ failures: [{}, { unknown_thing: undefined }] });
  assert.equal(summary.primary, null);
  assert.equal(summary.attributed, 0);
  assert.equal(summary.unattributed_count, 2);
  assert.deepEqual(summary.ranking, [{ failure_class: "unattributed", count: 2 }]);
});

test("v0.12.38 rejects an unusable attribution run", () => {
  assert.throws(() => summarizeAttributions({ failures: [] }), /must be a non-empty array/u);
  assert.throws(() => summarizeAttributions({ failures: "nope" }), /must be a non-empty array/u);
  assert.throws(() => summarizeAttributions({ failures: ["nope"] }), /failures\[0\] must be an object/u);
  assert.throws(() => summarizeAttributions({ failures: [[]] }), /failures\[0\] must be an object/u);
});

test("v0.12.38 is reachable from the loop and from MCP", async (t) => {
  const mounted = new Set(DEFAULT_INTERNAL_AUTHORIZATION);
  // `_get` is the suffix the classifier reads as `read`; a bare `_attribute`
  // matches no verb and would fall through to `governed`, leaving the loop
  // unable to diagnose its own failures.
  assert.equal(classifyTool("craft_failure_attribution_get"), "read");
  assert.equal(classifyTool("craft_failure_attribution_summary_get"), "read");
  for (const name of ["craft_failure_attribution_get", "craft_failure_attribution_summary_get"]) {
    assert.equal(mounted.has(classifyTool(name)), true, `${name} is not in a mounted tier`);
    assert.equal(authorizedTools(TOOLS, DEFAULT_INTERNAL_AUTHORIZATION).some((tool) => tool.name === name), true, `${name} missing from the projection`);
  }

  const root = join(tmpdir(), `craft-v01238-mcp-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const server = new McpServer(new CraftService(store));

  const call = async (name: string, args: JsonObject): Promise<JsonObject> => {
    const response = await server.handle({ id: 1, method: "tools/call", params: { name, arguments: args } });
    assert.equal(response?.error, undefined, `tool ${name} errored: ${JSON.stringify(response?.error)}`);
    const content = (response?.result as JsonObject).content as Array<{ text: string }>;
    return JSON.parse(content[0]!.text) as JsonObject;
  };

  const listed = ((await server.handle({ id: 1, method: "tools/list" }))?.result as JsonObject).tools as JsonObject[];
  for (const name of ["craft_failure_attribution_get", "craft_failure_attribution_summary_get"]) {
    assert.equal(listed.some((tool) => tool.name === name), true, `${name} is not advertised`);
  }

  assert.equal((await call("craft_failure_attribution_get", { relevant_retrieved: false })).failure_class, "retrieval_gap");
  const summary = await call("craft_failure_attribution_summary_get", { failures: [{ wrong_scope_applied: true }, { wrong_scope_applied: true }, {}] });
  assert.equal(summary.primary, "scope_gap");
  assert.equal(summary.unattributed_count, 1);
});
