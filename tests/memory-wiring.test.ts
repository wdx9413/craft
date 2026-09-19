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
  hybridMemoryScores,
  memoryDecayWeight,
  memoryUsageEvidence,
  planLegacyPromotion,
  rankWithDecay,
  shouldProposeMemory
} from "../capability/craft-memory/memory-signals.ts";

test("v0.12.35 decays a memory by age with a half-life rather than a cutoff", () => {
  const fresh = memoryDecayWeight({ confirmed_at: "2026-01-01T00:00:00Z", now: "2026-01-01T00:00:00Z" });
  // A brand-new bounded memory is worth its full base weight.
  assert.equal(fresh, 0.85);

  // Exactly one half-life later the recency factor is 0.5.
  const halfLife = memoryDecayWeight({ confirmed_at: "2026-01-01T00:00:00Z", now: "2026-04-01T00:00:00Z" });
  assert.equal(halfLife, Number((0.5 * 0.85).toFixed(6)));

  // Verified sources decay more slowly than bounded ones at the same age.
  const verified = memoryDecayWeight({ confirmed_at: "2026-01-01T00:00:00Z", now: "2026-04-01T00:00:00Z", trust: "verified" });
  assert.equal(verified, Number((0.5).toFixed(6)));
  assert.ok(verified > halfLife);

  // Decay approaches zero but is floored, so an ancient memory stays rankable
  // instead of underflowing to exactly 0 — "old" must not mean "gone", or it
  // could never be surfaced in a receipt again.
  const ancient = memoryDecayWeight({ confirmed_at: "2000-01-01T00:00:00Z", now: "2026-01-01T00:00:00Z" });
  assert.equal(ancient, 0.01);
  assert.ok(ancient < fresh);
});

test("v0.12.35 raises a memory's weight with successful accesses, capped", () => {
  const base = { confirmed_at: "2026-01-01T00:00:00Z", now: "2026-01-01T00:00:00Z", trust: "verified" as const };
  const unused = memoryDecayWeight({ ...base, accesses: 0 });
  const used = memoryDecayWeight({ ...base, accesses: 3 });
  assert.ok(used > unused);
  assert.equal(unused, 1);

  // The bonus saturates, so an often-returned memory cannot dominate forever.
  const capped = memoryDecayWeight({ ...base, accesses: 10 });
  const beyond = memoryDecayWeight({ ...base, accesses: 50 });
  assert.equal(capped, beyond);
  assert.equal(capped, Number((1 + 10 * 0.15).toFixed(6)));
});

test("v0.12.35 clamps a future timestamp instead of inflating the weight", () => {
  // A clock skew must not let a memory outrank every legitimate one.
  const future = memoryDecayWeight({ confirmed_at: "2027-01-01T00:00:00Z", now: "2026-01-01T00:00:00Z" });
  const now = memoryDecayWeight({ confirmed_at: "2026-01-01T00:00:00Z", now: "2026-01-01T00:00:00Z" });
  assert.equal(future, now);
});

test("v0.12.35 rejects malformed decay inputs", () => {
  assert.throws(() => memoryDecayWeight({ confirmed_at: "not-a-date", now: "2026-01-01T00:00:00Z" }), /confirmed_at must be an ISO timestamp/u);
  assert.throws(() => memoryDecayWeight({ confirmed_at: "2026-01-01T00:00:00Z", now: "nope" }), /now must be an ISO timestamp/u);
  assert.throws(() => memoryDecayWeight({ confirmed_at: "2026-01-01T00:00:00Z", now: "2026-01-01T00:00:00Z", accesses: -1 }), /accesses must be a non-negative integer/u);
  assert.throws(() => memoryDecayWeight({ confirmed_at: "2026-01-01T00:00:00Z", now: "2026-01-01T00:00:00Z", trust: "unknown" }), /trust must be verified or bounded/u);
});

test("v0.12.35 reranks by base score times decay and breaks ties by id", () => {
  const ranked = rankWithDecay([
    { id: "stale", base_score: 3, decay: 0.1 },
    { id: "fresh", base_score: 2, decay: 1 },
  ]);
  // A slightly weaker but current memory must beat a stronger stale one.
  assert.equal(ranked[0]!.id, "fresh");
  assert.equal(ranked[0]!.score, 2);
  assert.equal(ranked[1]!.score, 0.3);

  // Equal products fall back to id so the order is stable.
  const tied = rankWithDecay([{ id: "b", base_score: 2, decay: 1 }, { id: "a", base_score: 2, decay: 1 }]);
  assert.deepEqual(tied.map((entry) => entry.id), ["a", "b"]);
  assert.deepEqual(rankWithDecay([]), []);
});

test("v0.12.35 proposes a candidate in review-by-exception mode without being asked", () => {
  // The point of A4: a correction alone is enough, with no durable_value signal.
  const corrected = shouldProposeMemory({ signals: [], succeeded: true, corrections: 1 });
  assert.equal(corrected.propose, true);
  assert.deepEqual(corrected.reasons, ["corrections_1"]);
  assert.equal(corrected.policy, "review_by_exception");

  // A clean success with nothing notable still proposes nothing.
  assert.equal(shouldProposeMemory({ signals: [], succeeded: true }).propose, false);

  // Strong signals propose on their own, and automatic keys are labelled.
  const strong = shouldProposeMemory({ signals: ["decision_made", "needs_execution"], succeeded: true });
  assert.equal(strong.propose, true);
  assert.deepEqual(strong.reasons, ["decision_made", "needs_execution_automatic"]);

  // Retries and novelty each carry a lesson.
  assert.equal(shouldProposeMemory({ signals: [], succeeded: false, retries: 2 }).propose, true);
  assert.equal(shouldProposeMemory({ signals: [], succeeded: true, novel: true }).propose, true);
  // Novelty does not override an existing reason list, and duplicates collapse.
  const deduped = shouldProposeMemory({ signals: ["durable_value", "durable_value"], succeeded: true, novel: true });
  assert.deepEqual(deduped.reasons, ["durable_value"]);
});

test("v0.12.35 preserves strict capture mode exactly", () => {
  // A project that wants full manual approval keeps the historical behaviour:
  // only an explicit durable_value signal proposes anything.
  assert.equal(shouldProposeMemory({ signals: ["durable_value"], succeeded: true, mode: "strict" }).propose, true);
  assert.equal(shouldProposeMemory({ signals: [], succeeded: true, corrections: 5, mode: "strict" }).propose, false);
  assert.equal(shouldProposeMemory({ signals: ["durable_value"], succeeded: true, mode: "strict" }).policy, "strict");
  assert.deepEqual(shouldProposeMemory({ signals: [], succeeded: true, mode: "strict" }).reasons, []);
  assert.throws(() => shouldProposeMemory({ signals: [], succeeded: true, mode: "anything" }), /capture mode is unsupported/u);
  assert.throws(() => shouldProposeMemory({ signals: [], succeeded: true, corrections: -1 }), /corrections must be a non-negative integer/u);
  assert.throws(() => shouldProposeMemory({ signals: [], succeeded: true, retries: 1.5 }), /retries must be a non-negative integer/u);
  // A malformed signal list is rejected rather than silently ignored.
  assert.throws(() => shouldProposeMemory({ signals: [42], succeeded: true }), /signal must not be empty/u);
  // Signals omitted entirely is treated as "no signals", not an error: a caller
  // that reports nothing simply gets no proposal.
  assert.equal(shouldProposeMemory({ succeeded: true }).propose, false);
  assert.equal(shouldProposeMemory({ succeeded: true, mode: "strict" }).propose, false);
});

test("v0.12.35 defaults a promoted legacy memory's kind when none is given", () => {
  // A legacy memory_item with no explicit kind becomes a fact; guessing anything
  // more specific would invent semantics the old record never carried.
  const defaulted = planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "m9", content: "the port is 8080" });
  assert.equal(defaulted.kind, "fact");
  assert.equal(defaulted.legacy_version, 1);
});

test("v0.12.35 promotes a legacy memory only as an approvable candidate", () => {
  const promotion = planLegacyPromotion({
    legacy_kind: "memory_item", legacy_id: "m1", legacy_version: 3, content: "prefers pnpm", scope: "user", kind: "preference",
  });
  assert.equal(promotion.kind, "preference");
  assert.equal(promotion.scope, "user");
  assert.equal(promotion.requires_approval, true);
  assert.equal(promotion.requires_source, true);
  // The migration is not performed here — that is the whole point.
  assert.equal(promotion.migration_performed, false);
  assert.equal(promotion.sensitivity, "internal");
  assert.match(String(promotion.promotion_id), /^promotion_[0-9a-f]{24}$/u);
  assert.match(String(promotion.content_digest), /^sha256:[0-9a-f]{64}$/u);

  // An episode is experience, not a fact, and raw experience is restricted.
  const episodic = planLegacyPromotion({ legacy_kind: "episodic_memory", legacy_id: "e1", content: "the build broke" });
  assert.equal(episodic.kind, "experience");
  assert.equal(episodic.sensitivity, "restricted");
  assert.equal(episodic.scope, "user");

  // Semantic memory promotes as a fact regardless of any supplied kind.
  const semantic = planLegacyPromotion({ legacy_kind: "semantic_memory", legacy_id: "s1", content: "the API is v2", kind: "experience" });
  assert.equal(semantic.kind, "fact");

  // The promotion id is stable for identical inputs, so replanning is idempotent.
  assert.equal(
    planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "m1", legacy_version: 3, content: "prefers pnpm", scope: "user", kind: "preference" }).promotion_id,
    promotion.promotion_id);
});

test("v0.12.35 rejects an unsupported legacy promotion", () => {
  assert.throws(() => planLegacyPromotion({ legacy_kind: "other", legacy_id: "x", content: "y" }), /Legacy Memory kind is unsupported/u);
  assert.throws(() => planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "x", content: "y", scope: "galaxy" }), /Legacy Memory scope is unsupported/u);
  assert.throws(() => planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "x", content: "y", kind: "guess" }), /Promoted Memory kind is unsupported/u);
  assert.throws(() => planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "x", content: "y", legacy_version: 0 }), /legacy_version must be a positive integer/u);
  assert.throws(() => planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "x", content: "" }), /content must not be empty/u);
});

test("v0.12.35 falls back to keyword-only scoring when no adapter is eligible", () => {
  const candidates = [
    { id: "a", similarity: 0.9, keyword_score: 0 },
    { id: "b", similarity: null, keyword_score: 2 },
  ];
  const keywordOnly = hybridMemoryScores(candidates, { vectorEligible: false });
  // Without an eligible adapter the similarity is ignored entirely, and a
  // candidate that only the vector matched is not returned at all.
  assert.deepEqual(keywordOnly, [{ id: "b", score: 2, retrieval_mode: "keyword" }]);
  assert.deepEqual(hybridMemoryScores([], { vectorEligible: false }), []);
  // Equal keyword scores fall back to id, so the keyword path is stable too.
  const keywordTied = hybridMemoryScores([
    { id: "z", similarity: null, keyword_score: 1 },
    { id: "a", similarity: null, keyword_score: 1 },
  ], { vectorEligible: false });
  assert.deepEqual(keywordTied.map((entry) => entry.id), ["a", "z"]);
});

test("v0.12.35 fuses vector and keyword rankings when the adapter is eligible", () => {
  const candidates = [
    { id: "both", similarity: 0.8, keyword_score: 3 },
    { id: "vector_only", similarity: 0.95, keyword_score: 0 },
    { id: "keyword_only", similarity: null, keyword_score: 5 },
  ];
  const fused = hybridMemoryScores(candidates, { vectorEligible: true });
  // A candidate found by both methods accumulates rank credit from each.
  assert.equal(fused[0]!.id, "both");
  assert.equal(fused.every((entry) => entry.retrieval_mode === "vector+keyword"), true);
  // Neither single-method candidate is discarded.
  assert.equal(fused.some((entry) => entry.id === "vector_only"), true);
  assert.equal(fused.some((entry) => entry.id === "keyword_only"), true);
  // Ordering is deterministic when scores tie.
  const tied = hybridMemoryScores([
    { id: "z", similarity: 0.5, keyword_score: 0 },
    { id: "a", similarity: 0.5, keyword_score: 0 },
  ], { vectorEligible: true, k: 60 });
  assert.deepEqual(tied.map((entry) => entry.id), ["a", "z"]);
  assert.throws(() => hybridMemoryScores([], { vectorEligible: true, k: 0 }), /Fusion k must be a positive number/u);
});

test("v0.12.35 counts a memory as used only when the turn succeeded", () => {
  const used = memoryUsageEvidence({ memory_ids: ["m1", "m2"], outcome: "succeeded", turn_id: "t1", receipt_id: "r1" });
  assert.equal(used.counted_as_use, true);
  assert.equal(used.receipt_id, "r1");
  assert.deepEqual(used.access_deltas, [{ memory_id: "m1", delta: 1 }, { memory_id: "m2", delta: 1 }]);
  assert.equal(used.content_free, true);
  assert.match(String(used.evidence_id), /^memory_usage_[0-9a-f]{24}$/u);

  // A failure must not count as a use: otherwise a memory present when things
  // went wrong would accrue weight.
  const failed = memoryUsageEvidence({ memory_ids: ["m1"], outcome: "failed", turn_id: "t2" });
  assert.equal(failed.counted_as_use, false);
  assert.deepEqual(failed.access_deltas, [{ memory_id: "m1", delta: 0 }]);
  assert.equal(failed.receipt_id, null);

  // Identical turns produce identical evidence, so double counting is detectable.
  assert.equal(
    memoryUsageEvidence({ memory_ids: ["m1", "m2"], outcome: "succeeded", turn_id: "t1", receipt_id: "r1" }).evidence_id,
    used.evidence_id);
});

test("v0.12.35 rejects malformed usage evidence", () => {
  assert.throws(() => memoryUsageEvidence({ memory_ids: [], outcome: "succeeded", turn_id: "t" }), /memory_ids must not be empty/u);
  assert.throws(() => memoryUsageEvidence({ memory_ids: ["m1", "m1"], outcome: "succeeded", turn_id: "t" }), /memory_ids must be unique/u);
  assert.throws(() => memoryUsageEvidence({ memory_ids: ["m1"], outcome: "maybe", turn_id: "t" }), /outcome is unsupported/u);
  assert.throws(() => memoryUsageEvidence({ memory_ids: ["m1"], outcome: "succeeded", turn_id: "" }), /turn_id must not be empty/u);
  // Omitting memory_ids entirely is rejected the same way an empty list is.
  assert.throws(() => memoryUsageEvidence({ outcome: "succeeded", turn_id: "t" }), /memory_ids must not be empty/u);
  // An abandoned turn is not a use either.
  assert.equal(memoryUsageEvidence({ memory_ids: ["m1"], outcome: "abandoned", turn_id: "t3" }).counted_as_use, false);
});

test("v0.12.35 makes the five new capabilities reachable through MCP", async (t) => {
  const root = join(tmpdir(), `craft-v01235-mcp-${process.pid}-${Date.now()}`);
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

  // The tool list actually advertises them, so a client can discover them.
  // Names end in the verb the tier classifier reads: `_get`/`_search` classify as
  // read and `_propose`/`_record` as candidate, which is what makes them
  // reachable from the internal loop instead of falling through to `governed`.
  const listed = ((await server.handle({ id: 1, method: "tools/list" }))?.result as JsonObject).tools as JsonObject[];
  for (const name of ["craft_memory_decay_get", "craft_memory_capture_propose", "craft_memory_promotion_preview", "craft_memory_hybrid_scores", "craft_memory_usage_record"]) {
    assert.equal(listed.some((tool) => tool.name === name), true, `${name} is not advertised`);
  }

  // The default trust is "bounded", so an untouched memory reports 0.85 rather
  // than a full 1.0.
  assert.equal((await call("craft_memory_decay_get", { confirmed_at: "2026-01-01T00:00:00Z", now: "2026-01-01T00:00:00Z" })).weight, 0.85);
  assert.equal((await call("craft_memory_capture_propose", { signals: [], succeeded: true, corrections: 1 })).propose, true);
  assert.equal((await call("craft_memory_promotion_preview", { legacy_kind: "semantic_memory", legacy_id: "s1", content: "api is v2" })).kind, "fact");
  assert.equal((await call("craft_memory_hybrid_scores", { candidates: [{ id: "a", similarity: null, keyword_score: 1 }] })).results !== undefined, true);
  assert.equal((await call("craft_memory_usage_record", { memory_ids: ["m1"], outcome: "succeeded", turn_id: "t1" })).counted_as_use, true);
});
