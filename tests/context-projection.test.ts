import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compact, compactWithPromotion } from "../src/compaction.ts";
import { ContextProjectionKernel } from "../src/context-projection.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { McpServer } from "../src/mcp.ts";

/**
 * The durable projection, which exists because the tool promised something it could not do.
 *
 * `craft_context_project` said *"omitted segments are named and can be restored"*. Measured before
 * this kernel: `restore({segment_id})` with no segments threw `Context segment s2 does not exist`,
 * because `restore` demanded the original segments back — the one thing a caller that omitted them
 * no longer has. These tests go through a **second kernel instance on the same store**, because a
 * restore that only worked within one object's lifetime would not have fixed anything.
 */

const SEGMENTS = [
  { id: "s1", role: "user", content: "x".repeat(400), weight: 1 },
  { id: "s2", role: "assistant", content: "y".repeat(400), weight: 5 },
  { id: "s3", role: "user", content: "z".repeat(400), weight: 1 },
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-context-projection-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, kernel: new ContextProjectionKernel(store) };
}
async function close(f: { store: CraftStore; root: string }) {
  f.store.close();
  await rm(f.root, { recursive: true, force: true });
}

test("v0.12.43 restores an omitted segment across calls, without re-supplying it", async () => {
  const f = await fixture();
  try {
    const projected = f.kernel.project({ max_tokens: 120, segments: SEGMENTS, session_id: "session-1" });
    assert.equal(projected.session_id, "session-1");
    assert.deepEqual((projected.segments as JsonObject[]).map((segment) => segment.id), ["s2"]);
    // The weight-5 segment won the competition; the two weight-1 segments are named as omitted,
    // which is the promise the tool makes.
    assert.deepEqual(projected.omitted, ["s1", "s3"]);
    assert.equal(projected.original_segments, 3);
    assert.equal(projected.complete, false);

    // A *different* kernel over the *same* store, holding no memory of the first call. This is the
    // whole point: the caller knows the segment's id and nothing else.
    const later = new ContextProjectionKernel(f.store);
    const restored = later.restore({ segment_id: "s1", max_tokens: 400, session_id: "session-1" });
    assert.equal(restored.restored_from, "session");
    assert.equal(restored.already_present, false);
    assert.deepEqual((restored.segments as JsonObject[]).map((segment) => segment.id), ["s1", "s2", "s3"]);
    assert.equal(restored.complete, true);

    // And the session's projection record was updated, so a reader sees the new view.
    const stored = later.get({ session_id: "session-1" }).projection as JsonObject;
    assert.deepEqual(stored.omitted, []);
    assert.equal(stored.complete, true);
    assert.equal(stored.content_free, true);
  } finally { await close(f); }
});

test("v0.12.43 distinguishes the stored path from the argument path instead of pretending", async () => {
  const f = await fixture();
  try {
    // No session id: the stateless path the tool has always accepted. It still works, and it says
    // which path answered — a restore that quietly used the arguments would hide the fact that
    // nothing was recoverable.
    const stateless = f.kernel.restore({ segment_id: "s1", max_tokens: 400, segments: SEGMENTS });
    assert.equal(stateless.restored_from, "arguments");
    assert.equal(stateless.session_id, undefined);
    assert.deepEqual((stateless.segments as JsonObject[]).map((segment) => segment.id), ["s1", "s2", "s3"]);
    // Without segments and without a session there is nothing to restore from, and saying so is the
    // answer rather than an empty projection.
    assert.throws(() => f.kernel.restore({ segment_id: "s1" }), /does not exist/u);
    // A session that holds nothing is a caller error, not the stateless path: conflating them would
    // make a typo in a session id look like an undocumented argument form.
    assert.throws(() => f.kernel.restore({ segment_id: "s1", session_id: "never-written" }), /holds no segments/u);
    assert.equal(f.kernel.get({ session_id: "never-written" }).projection, null);
    assert.equal(f.kernel.get({ session_id: "never-written" }).segment_count, 0);
  } finally { await close(f); }
});

test("v0.12.43 replaces a session's segments rather than accumulating them", async () => {
  const f = await fixture();
  try {
    f.kernel.project({ max_tokens: 1_000, segments: SEGMENTS, session_id: "s" });
    // A second projection for the same session is the session's new content. The store has no
    // `delete`, which is why the segments are one versioned record per session: per-segment rows
    // would accumulate every segment the session ever held and stale ones could only be hidden.
    f.kernel.project({ max_tokens: 1_000, segments: [{ id: "only", role: "user", content: "new" }], session_id: "s" });
    assert.equal(f.kernel.get({ session_id: "s" }).segment_count, 1);
    const restored = f.kernel.restore({ segment_id: "only", max_tokens: 1_000, session_id: "s" });
    assert.deepEqual((restored.segments as JsonObject[]).map((segment) => segment.id), ["only"]);
    // The segments that are gone are gone: a stale id is not restorable.
    assert.throws(() => f.kernel.restore({ segment_id: "s1", max_tokens: 1_000, session_id: "s" }), /does not exist/u);
  } finally { await close(f); }
});

test("v0.12.43 reports a restore that cannot fit rather than silently dropping it", async () => {
  const f = await fixture();
  try {
    f.kernel.project({ max_tokens: 120, segments: SEGMENTS, session_id: "tight" });
    // s1 costs ~100 tokens and the budget is 120, so promoting it evicts s2 — and a restore that
    // returned a projection without the segment would be indistinguishable from one that worked.
    const restored = f.kernel.restore({ segment_id: "s1", max_tokens: 120, session_id: "tight" });
    assert.deepEqual((restored.segments as JsonObject[]).map((segment) => segment.id), ["s1"]);
    assert.equal(restored.already_present, false);
    // A budget that fits nothing at all reports failure.
    assert.throws(() => f.kernel.restore({ segment_id: "s1", max_tokens: 1, session_id: "tight" }), /cannot be restored within 1 tokens/u);
    // A missing max_tokens asks "put it back where it was" rather than using a different budget.
    const defaulted = f.kernel.restore({ segment_id: "s1", session_id: "tight" });
    assert.equal(defaulted.restored, "s1");
    assert.equal((defaulted.segments as JsonObject[]).some((segment) => segment.id === "s1"), true);
    // Restoring something already present changes nothing and says so.
    const again = f.kernel.restore({ segment_id: "s1", session_id: "tight" });
    assert.equal(again.already_present, true);
  } finally { await close(f); }
});

test("v0.12.43 reaches both paths through the MCP tools a Host actually calls", async () => {
  const f = await fixture();
  try {
    const { CraftService } = await import("../src/service.ts");
    const server = new McpServer(new CraftService(f.store), "full");
    const call = async (name: string, args: JsonObject) => {
      const response = await server.handle({ id: 1, method: "tools/call", params: { name, arguments: args } });
      const result = response!.result as { isError: boolean; structuredContent: JsonObject };
      assert.equal(result.isError, false, `${name} failed`);
      return result.structuredContent;
    };
    const projected = await call("craft_context_project", { max_tokens: 120, segments: SEGMENTS, session_id: "mcp" });
    assert.deepEqual(projected.omitted, ["s1", "s3"]);
    const restored = await call("craft_context_restore", { segment_id: "s3", max_tokens: 400, session_id: "mcp" });
    assert.equal(restored.restored_from, "session");
    assert.equal((restored.segments as JsonObject[]).length, 3);
    const read = await call("craft_context_projection_get", { session_id: "mcp" });
    assert.equal(read.segment_count, 3);
    // A failure is reported as an error rather than as an empty success.
    const failed = await server.handle({ id: 2, method: "tools/call", params: { name: "craft_context_restore", arguments: { segment_id: "absent", session_id: "mcp" } } });
    assert.equal((failed!.result as JsonObject).isError, true);
  } finally { await close(f); }
});

test("v0.12.43 makes one policy serve all three callers that used to have their own", () => {
  // Three inputs, one implementation. The transcript's contiguous reservation, the segment bag's
  // weight competition, and protection by subtraction are now three *inputs* rather than three
  // functions, so a divergence between them is a configuration rather than a rewrite.
  const segments = [
    { id: "a", content: "aaaa", weight: 1 },
    { id: "b", content: "bbbb", weight: 1 },
    { id: "c", content: "cccc", weight: 9 },
  ];
  // Weight competition, skipping what does not fit. Each `content` is one token, so a budget of 1
  // fits only the heaviest — and the tie between the two weight-1 segments is broken by recency.
  const competed = compact({ segments, max_tokens: 1, estimate: (value) => Math.ceil(value.length / 4) });
  assert.deepEqual(competed.kept, ["c"]);
  assert.deepEqual(competed.elided, ["a", "b"]);
  const tied = compact({ segments: segments.map((segment) => ({ ...segment, weight: 1 })), max_tokens: 1, estimate: (value) => Math.ceil(value.length / 4) });
  assert.deepEqual(tied.kept, ["c"], "the most recent of the tied segments wins");
  // Protection is subtraction: the protected segment is kept even though it is the lightest, and it
  // is reported as kept rather than only as protected — an earlier version got that wrong, and every
  // caller asking "was this kept?" got false for the one segment the guarantee was about.
  const protectedRun = compact({ segments, max_tokens: 1, protect: ["a"], estimate: (value) => Math.ceil(value.length / 4) });
  // Protection removes the segment from the budget, not from the result: `c` still competes for what
  // is left, and both are kept in input order.
  assert.deepEqual(protectedRun.kept, ["a", "c"]);
  assert.deepEqual(protectedRun.protected_ids, ["a"]);
  assert.equal(protectedRun.unbound.length, 0);
  // A protected id no segment matches is reported, so a misconfigured policy is visible.
  assert.deepEqual(compact({ segments, max_tokens: 10, protect: ["ghost"] }).unbound, ["ghost"]);
  // The contiguous recent suffix is the transcript's rule, and it stops rather than skipping so the
  // elided span stays one run the summariser can describe. Each segment is one token, so a budget of
  // 2 reserves the two most recent and leaves the oldest.
  const tail = compact({ segments, max_tokens: 2, tail_share: 1, estimate: (value) => Math.ceil(value.length / 4) });
  assert.deepEqual(tail.kept, ["b", "c"], "kept in input order, and the oldest is the one elided");
  assert.deepEqual(tail.elided, ["a"]);
  // The elided summary is deterministic without a summariser and content-free with one.
  assert.match(String(tail.summary), /retain only their digest for replay/u);
  assert.equal(compact({ segments, max_tokens: 100, summarize: () => "unused" }).summary, null);
  // Promotion is a separate guarantee: the wanted segment is raised above every other, so the only
  // remaining reason for it to be absent is that it fits nowhere.
  assert.deepEqual(compactWithPromotion({ segments, max_tokens: 1, estimate: (value) => Math.ceil(value.length / 4) }, "a").kept, ["a"]);
  assert.throws(() => compactWithPromotion({ segments, max_tokens: 1, estimate: (value) => Math.ceil(value.length / 4) }, "absent"), /does not exist/u);
});
