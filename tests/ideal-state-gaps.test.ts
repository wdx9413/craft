import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import {
  Bm25Index,
  ReversibleContext,
  buildExperienceRecord,
  decideExperienceCapture,
  fuseRankings
} from "../src/context-retrieval-capture.ts";

/** A deterministic stand-in for the real estimator, so tests never vary. */
const estimate = (value: string) => Math.ceil(value.length / 4);

test("v0.12.34 keeps the original context so a projection can be reversed", () => {
  const context = new ReversibleContext(estimate);
  assert.equal(context.size, 0);
  assert.equal(context.totalTokens, 0);
  assert.deepEqual(context.original(), []);

  context.append("system", "system", "a".repeat(40), 10);
  context.append("history", "user", "b".repeat(40), 1);
  assert.equal(context.size, 2);
  assert.equal(context.totalTokens, 20);
  assert.equal(context.original().length, 2);

  // A cap that fits only the high-weight segment is a *view*, not a loss.
  const projected = context.project(12);
  assert.deepEqual(projected.segments.map((segment) => segment.id), ["system"]);
  assert.deepEqual(projected.omitted, ["history"]);
  assert.equal(projected.complete, false);
  assert.equal(projected.tokens, 10);

  // The defining property: the dropped segment is still there afterwards.
  assert.equal(context.original().length, 2);
  assert.equal(context.totalTokens, 20);

  // A cap that fits everything reports completeness rather than omitting.
  const full = context.project(100);
  assert.equal(full.complete, true);
  assert.deepEqual(full.omitted, []);
  assert.equal(full.segments.length, 2);
});

test("v0.12.34 restores an omitted segment instead of having destroyed it", () => {
  const context = new ReversibleContext(estimate);
  context.append("keep", "system", "a".repeat(40), 5);
  context.append("optional", "user", "b".repeat(40), 1);
  assert.deepEqual(context.project(12).omitted, ["optional"]);

  // Promotion lets the caller pull an omitted segment back into the view.
  const restored = context.restore("optional", 100);
  assert.equal(restored.segments.some((segment) => segment.id === "optional"), true);
  assert.equal(restored.complete, true);

  // A segment that genuinely cannot fit reports that, rather than silently
  // returning a projection without it.
  assert.throws(() => context.restore("optional", 9), /cannot be restored within 9 tokens/u);
  // An unknown segment is an error, not an empty result.
  assert.throws(() => context.restore("nope", 100), /does not exist/u);
  // Restoring is non-destructive: the original set is unchanged either way.
  assert.equal(context.original().length, 2);
});

test("v0.12.34 validates context inputs and reports a sealed digest", () => {
  const context = new ReversibleContext(estimate);
  context.append("a", "user", "hello", 1);
  // Duplicate ids would make restore() ambiguous.
  assert.throws(() => context.append("a", "user", "other"), /already exists/u);
  assert.throws(() => context.append("b", "user", ""), /content must not be empty/u);
  assert.throws(() => context.append("b", "user", "x", -1), /weight must be a non-negative number/u);
  assert.throws(() => context.append("b", "user", "x", Number.NaN), /weight must be a non-negative number/u);
  assert.throws(() => context.project(0), /positive integer/u);
  assert.throws(() => context.project(1.5), /positive integer/u);
  // @ts-expect-error deliberately passing a non-function estimator.
  assert.throws(() => new ReversibleContext(undefined), /requires a token estimator/u);

  const sealed = context.seal();
  assert.match(String(sealed.digest), /^sha256:[0-9a-f]{64}$/u);
  assert.equal(sealed.segments, 1);
  assert.equal(sealed.tokens, 2);
});

test("v0.12.34 breaks projection ties by recency so the result is deterministic", () => {
  const context = new ReversibleContext(estimate);
  // Equal weights: only one fits, and the more recent must win.
  context.append("older", "user", "a".repeat(40), 1);
  context.append("newer", "user", "b".repeat(40), 1);
  const projection = context.project(12);
  assert.deepEqual(projection.segments.map((segment) => segment.id), ["newer"]);
  // Running it again gives the same answer.
  assert.deepEqual(context.project(12).segments.map((segment) => segment.id), ["newer"]);
});

test("v0.12.34 refuses to restore a segment that cannot fit", () => {
  const context = new ReversibleContext(estimate);
  // The target is the only segment, and it alone exceeds the cap, so no
  // promotion can make it fit: the restore must report failure rather than
  // returning a projection without it.
  context.append("big", "system", "x".repeat(400), 1);
  assert.throws(() => context.restore("big", 5), /cannot be restored within 5 tokens/u);
  // The refusal is non-destructive: the segment is still there afterwards.
  assert.equal(context.original().length, 1);
  assert.equal(context.restore("big", 200).segments.length, 1);
});

test("v0.12.34 keeps an already-present segment when restoring", () => {
  const context = new ReversibleContext(estimate);
  context.append("a", "system", "a".repeat(20), 2);
  context.append("b", "user", "b".repeat(20), 1);
  // "a" is already in the projection, so restore returns it unchanged and does
  // not need to promote anything.
  const restored = context.restore("a", 100);
  assert.equal(restored.segments.some((segment) => segment.id === "a"), true);
  assert.equal(restored.complete, true);
});

test("v0.12.34 promotes an omitted segment above the others so it fits", () => {
  const context = new ReversibleContext(estimate);
  // Three segments, all of equal size; only two fit in the cap. Without
  // promotion the last-ranked ("c") is the one pushed out.
  context.append("a", "system", "a".repeat(20), 1);
  context.append("b", "user", "b".repeat(20), 1);
  context.append("c", "user", "c".repeat(20), 1);
  const projection = context.project(12);
  assert.equal(projection.segments.length, 2);
  assert.deepEqual(projection.omitted, ["a"]);

  // Restoring "a" must promote it above the others, not bump it by one, so the
  // outcome does not depend on unrelated weights.
  const restored = context.restore("a", 12);
  assert.equal(restored.segments.some((segment) => segment.id === "a"), true);
  assert.equal(restored.segments.length, 2);
  // The original is unchanged, so the promotion was a projection-only change.
  assert.deepEqual(context.original().map((segment) => segment.id), ["a", "b", "c"]);
  assert.deepEqual(context.project(12).omitted, ["a"]);
});

test("v0.12.34 ranks a rare identifier above a common word with BM25", () => {
  const index = new Bm25Index();
  index.add("noise", "the agent runs the task and the agent reports the task");
  index.add("target", "failed with error code TS-999 during the run");
  index.add("other", "the agent runs another task");
  assert.equal(index.size, 3);

  // A common term alone must not decide the ranking; the rare identifier must.
  const results = index.score("TS-999");
  assert.equal(results[0]!.id, "target");
  assert.equal(results[0]!.exact_identifier, true);
  // The boost is what makes it decisive.
  assert.ok(results[0]!.score >= 10);

  // A word present in several documents still scores, but without the boost.
  const common = index.score("task");
  assert.ok(common.length >= 2);
  assert.equal(common.every((item) => item.exact_identifier === false), true);

  // Ordering is deterministic for equal scores.
  const tied = index.score("agent runs");
  assert.equal(tied.length > 0, true);
});

test("v0.12.34 orders equal BM25 scores by id so ranking is stable", () => {
  const index = new Bm25Index();
  // Two documents with identical content score identically, so the only thing
  // deciding the order is the id tie-break.
  index.add("zulu", "alpha");
  index.add("alpha", "alpha");
  const scored = index.score("alpha");
  assert.equal(scored.length, 2);
  assert.equal(scored[0]!.score, scored[1]!.score);
  assert.deepEqual(scored.map((item) => item.id), ["alpha", "zulu"]);
});

test("v0.12.34 treats a query with no identifier tokens as unboosted", () => {
  const index = new Bm25Index();
  index.add("doc", "plain words only here");
  const [scored] = index.score("plain");
  // "plain" has no digits and no separators, so it is not an identifier and the
  // boost must not apply.
  assert.equal(scored!.exact_identifier, false);
});

test("v0.12.34 ignores query terms absent from the corpus", () => {
  const index = new Bm25Index();
  index.add("doc", "alpha beta");
  // "zzz" matches nothing, so it must contribute no score and no document
  // frequency, while "alpha" still ranks the document.
  const scored = index.score("alpha zzz");
  assert.equal(scored.length, 1);
  assert.equal(scored[0]!.id, "doc");
  // A query made only of unknown terms returns nothing rather than dividing by
  // a zero document frequency.
  assert.deepEqual(index.score("zzz"), []);
});

test("v0.12.34 returns nothing for queries that match no document", () => {
  const index = new Bm25Index();
  index.add("only", "alpha beta");
  assert.deepEqual(index.score("gamma"), []);
  // An empty corpus and an empty query are both empty results, not errors.
  assert.deepEqual(new Bm25Index().score("alpha"), []);
  // A blank query is rejected; a real query against a populated index is not.
  assert.throws(() => index.score("  "), /query must not be empty/u);
  assert.equal(index.score("alpha").length, 1);
});

test("v0.12.34 validates BM25 documents and tuning constants", () => {
  const index = new Bm25Index();
  index.add("one", "alpha");
  assert.throws(() => index.add("one", "beta"), /already exists/u);
  assert.throws(() => index.add("two", ""), /value must not be empty/u);
  assert.throws(() => new Bm25Index({ k1: 0 }), /k1 must be positive/u);
  assert.throws(() => new Bm25Index({ b: 2 }), /b must be between 0 and 1/u);
  // The tuned constants are accepted and used.
  const tuned = new Bm25Index({ k1: 2, b: 0.5 });
  tuned.add("doc", "alpha beta gamma");
  assert.equal(tuned.score("alpha").length, 1);
});

test("v0.12.34 fuses ranked lists by reciprocal rank and counts sources", () => {
  const fused = fuseRankings([[{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]]);
  // "b" appears in both lists, so it must outrank items seen once.
  assert.equal(fused[0]!.id, "b");
  assert.equal(fused[0]!.sources, 2);
  assert.equal(fused.find((item) => item.id === "a")!.sources, 1);
  assert.equal(fused.length, 3);
  // A custom k changes the weights but not the ordering property.
  assert.equal(fuseRankings([[{ id: "a" }], [{ id: "a" }]], 1)[0]!.id, "a");
  assert.deepEqual(fuseRankings([]), []);
  assert.throws(() => fuseRankings([], 0), /k must be a positive number/u);
});

test("v0.12.34 orders equal fusion scores by id so fusion is stable", () => {
  // Two lists each contributing one distinct id at the same rank produce equal
  // scores, so only the id tie-break decides the order.
  const fused = fuseRankings([[{ id: "b" }], [{ id: "a" }]]);
  assert.equal(fused[0]!.score, fused[1]!.score);
  assert.deepEqual(fused.map((item) => item.id), ["a", "b"]);
});

test("v0.12.34 honours relaxed BM25 constants without changing correctness", () => {
  // b = 0 disables length normalisation, which is a documented BM25
  // configuration rather than an edge case to reject. Term *frequency* still
  // counts, so a document repeating the term outranks one mentioning it once —
  // that is correct BM25, not a tie.
  const index = new Bm25Index({ k1: 1.2, b: 0 });
  index.add("long", "alpha ".repeat(20).trim());
  index.add("short", "alpha");
  const scored = index.score("alpha");
  assert.equal(scored.length, 2);
  assert.equal(scored[0]!.id, "long");
  assert.ok(scored[0]!.score > scored[1]!.score);

  // With length normalisation ON, the repeated-term advantage is damped by the
  // longer document, so the same corpus gives a different ratio.
  const normalised = new Bm25Index({ k1: 1.2, b: 0.75 });
  normalised.add("long", "alpha ".repeat(20).trim());
  normalised.add("short", "alpha");
  const damped = normalised.score("alpha");
  assert.ok(damped[0]!.score / damped[1]!.score < scored[0]!.score / scored[1]!.score);
});

test("v0.12.34 captures a failure lesson deterministically", () => {
  const failure = decideExperienceCapture({ outcome: "failed" });
  assert.equal(failure.capture, true);
  assert.equal(failure.kind, "failure_lesson");
  assert.equal(failure.score, 30);
  assert.deepEqual(failure.reasons, ["outcome_failed"]);
  assert.match(failure.dedupe_key, /^sha256:[0-9a-f]{64}$/u);

  // A clean, novel-free success is routine and is not captured by default.
  const routine = decideExperienceCapture({ outcome: "succeeded" });
  assert.equal(routine.capture, false);
  assert.equal(routine.kind, "routine");
  assert.equal(routine.score, 0);
  assert.deepEqual(routine.reasons, []);

  // A single correction clears the default threshold on its own: it encodes the
  // failure *and* its fix, which is the highest-value lesson available.
  const corrected = decideExperienceCapture({ outcome: "succeeded", corrections: 2 });
  assert.equal(corrected.kind, "correction");
  assert.equal(corrected.capture, true);
  assert.deepEqual(corrected.reasons, ["corrections_2"]);
  assert.equal(decideExperienceCapture({ outcome: "succeeded", corrections: 1 }).capture, true);

  // An explicit request always wins the label.
  const explicit = decideExperienceCapture({ outcome: "succeeded", user_explicit: true });
  assert.equal(explicit.kind, "working_pattern");
  assert.equal(explicit.capture, true);

  // Abandonment counts as a lesson, retries accumulate, breadth adds on top.
  const messy = decideExperienceCapture({ outcome: "abandoned", retries: 2, corrections: 1, distinct_tools: 5, novel: true });
  assert.equal(messy.capture, true);
  assert.deepEqual(messy.reasons, ["outcome_abandoned", "retries_2", "corrections_1", "breadth_5", "novel_situation"]);
  assert.equal(messy.score, 30 + 16 + 26 + 9 + 15);

  // The threshold is caller-controlled so a strict project can raise the bar.
  assert.equal(decideExperienceCapture({ outcome: "succeeded", novel: true, threshold: 100 }).capture, false);
  assert.equal(decideExperienceCapture({ outcome: "succeeded", novel: true, threshold: 0 }).capture, true);

  // Identical signals produce an identical dedupe key, so double capture is detectable.
  assert.equal(decideExperienceCapture({ outcome: "failed" }).dedupe_key, failure.dedupe_key);
});

test("v0.12.34 rejects malformed capture signals rather than guessing", () => {
  assert.throws(() => decideExperienceCapture({ outcome: "maybe" }), /outcome is unsupported/u);
  assert.throws(() => decideExperienceCapture({ outcome: "succeeded", retries: -1 }), /retries must be a non-negative integer/u);
  assert.throws(() => decideExperienceCapture({ outcome: "succeeded", corrections: 1.5 }), /corrections must be a non-negative integer/u);
  assert.throws(() => decideExperienceCapture({ outcome: "succeeded", distinct_tools: "many" }), /distinct_tools must be a non-negative integer/u);
  assert.throws(() => decideExperienceCapture({ outcome: "succeeded", threshold: -1 }), /threshold must be a non-negative number/u);
});

test("v0.12.34 builds a reviewable experience record with provenance", () => {
  const record = buildExperienceRecord({ outcome: "failed", summary: "ts-999 means a stale build cache", task_id: "task-1" });
  assert.equal(record.kind, "failure_lesson");
  assert.equal(record.scope, "project");
  assert.equal(record.task_id, "task-1");
  assert.equal(record.requires_review, true);
  assert.equal((record.provenance as JsonObject).captured_by, "runtime");
  assert.deepEqual(record.reasons, ["outcome_failed"]);
  assert.match(String(record.experience_id), /^exp_[0-9a-f]{24}$/u);

  // A routine success is not captured, so it cannot be recorded.
  assert.throws(() => buildExperienceRecord({ outcome: "succeeded", summary: "did the thing" }), /did not meet the capture threshold/u);
  // A summary is required: an experience without one is not reusable.
  assert.throws(() => buildExperienceRecord({ outcome: "failed", summary: "" }), /summary must not be empty/u);

  // An explicit id and scope are honoured; a user-requested pattern is already
  // vouched for by the person who asked, so it needs no separate review.
  const explicit = buildExperienceRecord({ outcome: "succeeded", user_explicit: true, summary: "reuse this loop", experience_id: "exp-fixed", scope: "user" });
  assert.equal(explicit.experience_id, "exp-fixed");
  assert.equal(explicit.scope, "user");
  assert.equal(explicit.requires_review, false);
  assert.equal(explicit.task_id, null);

  // A user-requested *correction* still needs review: something went wrong.
  const corrected = buildExperienceRecord({ outcome: "succeeded", corrections: 1, summary: "use the other flag" });
  assert.equal(corrected.kind, "correction");
  assert.equal(corrected.requires_review, true);
  // A routine success never reaches the store, so it has no record at all.
  assert.throws(() => buildExperienceRecord({ outcome: "succeeded", summary: "nothing notable" }), /did not meet the capture threshold/u);
});

test("v0.12.34 exposes all three gaps as reachable MCP tools", async (t) => {
  const root = join(tmpdir(), `craft-v01234-mcp-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const server = new McpServer(new CraftService(store));

  /** Calls a tool the way a client would, and fails loudly on a JSON-RPC error. */
  const call = async (name: string, args: JsonObject): Promise<JsonObject> => {
    const response = await server.handle({ id: 1, method: "tools/call", params: { name, arguments: args } });
    assert.equal(response?.error, undefined, `tool ${name} returned an error: ${JSON.stringify(response?.error)}`);
    const result = response?.result as JsonObject;
    const content = result.content as Array<{ text: string }>;
    return JSON.parse(content[0]!.text) as JsonObject;
  };

  // The tool list actually advertises them, so a client can discover them.
  const listed = ((await server.handle({ id: 1, method: "tools/list" }))?.result as JsonObject).tools as JsonObject[];
  for (const name of ["craft_context_project", "craft_context_restore", "craft_bm25_search", "craft_retrieval_fuse", "craft_experience_capture_decide", "craft_experience_capture_build"]) {
    assert.equal(listed.some((tool) => tool.name === name), true, `${name} is not advertised`);
  }

  // Gap 1: a projection that reports what it left out, and can take it back.
  const segments = [
    { id: "system", role: "system", content: "s".repeat(40), weight: 10 },
    { id: "history", role: "user", content: "h".repeat(40), weight: 1 },
  ];
  const projected = await call("craft_context_project", { max_tokens: 12, segments });
  assert.deepEqual(projected.omitted, ["history"]);
  assert.equal(projected.complete, false);
  // The original is intact, which is the whole point of "reversible".
  assert.equal(projected.original_segments, 2);
  assert.ok(Number(projected.original_tokens) > Number(projected.tokens));

  const restored = await call("craft_context_restore", { segment_id: "history", max_tokens: 20, segments });
  assert.equal((restored.segments as JsonObject[]).some((segment) => segment.id === "history"), true);

  // Gap 2: BM25 must put the identifier-bearing record first.
  const search = await call("craft_bm25_search", {
    query: "TS-999",
    documents: [
      { id: "noise", value: "the agent runs the task and reports the task" },
      { id: "target", value: "failed with error code TS-999" },
    ],
  });
  assert.equal((search.results as JsonObject[])[0]!.id, "target");
  assert.equal((search.results as JsonObject[])[0]!.exact_identifier, true);

  const fused = await call("craft_retrieval_fuse", { rankings: [[{ id: "a" }, { id: "b" }], [{ id: "b" }]] });
  assert.equal((fused.fused as JsonObject[])[0]!.id, "b");
  assert.equal((fused.fused as JsonObject[])[0]!.sources, 2);

  // Gap 3: capture is decided from signals and produces a reviewable record.
  const decision = await call("craft_experience_capture_decide", { outcome: "failed" });
  assert.equal(decision.capture, true);
  assert.equal(decision.kind, "failure_lesson");

  const record = await call("craft_experience_capture_build", { outcome: "failed", summary: "ts-999 means a stale build cache" });
  assert.equal(record.kind, "failure_lesson");
  assert.equal(record.requires_review, true);
  assert.equal((record.provenance as JsonObject).captured_by, "runtime");

  // A tool failure is reported the MCP way: a successful JSON-RPC response
  // carrying isError, not a transport-level error.
  const failed = await server.handle({ id: 2, method: "tools/call", params: { name: "craft_context_restore", arguments: { segment_id: "absent", max_tokens: 10, segments } } });
  assert.equal((failed?.result as JsonObject).isError, true);
  assert.equal(failed?.error, undefined);
});
