import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeContribution } from '@craft/capability-knowledge/contribution';
import { KnowledgeClaimGovernance } from '@craft/capability-knowledge/claim-governance';
import { MemoryContribution } from '@craft/capability-memory/contribution';
import { MemoryLedgerKernel } from '@craft/capability-memory/memory-ledger';
import { activeProcedure, preserveProcedureRelease } from '@craft/capability-experience/procedure-release';
import { temporalMemorySelect } from 'craft-common-base/memory-temporal-policy';
import type { ContextRequest } from "../core/capability-protocol.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { attachVerifiedPromotionFixture } from "./helpers/knowledge-promotion-proof.ts";

const request: ContextRequest = { query: "alpha", scope_kind: "project", scope_id: "demo", max_items: 10, max_chars: 20_000, now: "2026-09-27T10:00:00Z" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-lifecycle-staleness-"));
  const store = await new CraftStore(craftPaths(root)).open();
  store.create("scope_alias", "demo-path", { scope: { kind: "project", id: "demo" }, alias_kind: "path", alias: root, status: "active" });
  store.create("knowledge_source", "source", { scope: { kind: "global", id: "global" }, status: "active", trust: "verified", content_digest: "source-v1" });
  const reader = new KnowledgeContribution(store);
  const claim = (id: string, extra: JsonObject = {}) => {
    const { status = "reviewed", ...rest } = extra;
    const record = store.create("knowledge_claim", id, { status: status === "reviewed" ? "candidate" : status,
      scope: "project:demo", source_id: "source", content: "alpha fact", evidence_ids: [], content_digest: "fixture-content", ...rest });
    return status === "reviewed" && store.find("knowledge_source", String(record.source_id)) ? attachVerifiedPromotionFixture(store, record) : record;
  };
  return { root, store, reader, claim, async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("expired Knowledge stays out of strong Context and only returns as a decayed advisory", async () => {
  const f = await fixture();
  try {
    f.claim("old", { status: "expired", valid_until: "2026-01-01T00:00:00Z" });
    // Strict default: expired records are hard-excluded.
    assert.equal((await f.reader.contribute(request)).items.length, 0);
    // Opt-in: expired returns, flagged advisory, with a decayed freshness score.
    const advisory = (await f.reader.contribute({ ...request, include_stale: true })).items;
    assert.equal(advisory.length, 1);
    assert.equal(advisory[0]!.advisory, true);
    assert.equal(advisory[0]!.reason, "stale_advisory");
    assert.ok(Number(advisory[0]!.freshness_score) <= 0.5 && Number(advisory[0]!.freshness_score) >= 0.1);
    // Stale and disputed share a flat low band, not tied to time.
    f.claim("stale-one", { status: "stale" });
    const stale = (await f.reader.contribute({ ...request, include_stale: true })).items.find((item) => item.claim_id === "stale-one")!;
    assert.equal(stale.freshness_score, 0.3);
    // An expired record without a parseable valid_until still yields a bounded low score.
    f.claim("expired-no-date", { status: "expired" });
    const noDate = (await f.reader.contribute({ ...request, include_stale: true })).items.find((item) => item.claim_id === "expired-no-date")!;
    assert.equal(noDate.freshness_score, 0.3);
    // Advisory ranks below a reviewed peer for the same query.
    f.claim("fresh", { content: "alpha fact" });
    const mixed = (await f.reader.contribute({ ...request, include_stale: true })).items;
    assert.equal(mixed[0]!.claim_id, "fresh");
  } finally { await f.close(); }
});

test("include_stale never surfaces an expired exit that has no governed source", async () => {
  const f = await fixture();
  try {
    // An expired exit without a governed source is never surfaced, even as advisory.
    f.store.create("knowledge_claim", "unsourced", { status: "expired", scope: "project:demo", content: "alpha fact",
      evidence_ids: [], content_digest: "fixture-content" });
    assert.equal((await f.reader.contribute({ ...request, include_stale: true })).items.some((item) => item.claim_id === "unsourced"), false);
  } finally { await f.close(); }
});

test("a disputed claim is only shown as a conflicting pair with its counterpart", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_claim", "disputed-a", { status: "disputed", scope: "project:demo", source_id: "source",
      content: "alpha says left", evidence_ids: [], content_digest: "fixture-a" });
    f.store.create("knowledge_claim", "disputed-b", { status: "reviewed", scope: "project:demo", source_id: "source",
      content: "alpha says right", evidence_ids: [], content_digest: "fixture-b" });
    f.store.create("knowledge_relation", "contradiction-ab", { relation: "contradicts", confidence: "bounded",
      source: { kind: "knowledge_claim", id: "disputed-a", version: null },
      target: { kind: "knowledge_claim", id: "disputed-b", version: null },
      valid_from: "2026-01-01T00:00:00Z", valid_to: null });
    // Strict default: the disputed claim is still hard-excluded.
    assert.equal((await f.reader.contribute(request)).items.some((item) => item.claim_id === "disputed-a"), false);
    // Opt-in: it returns marked as a pair, carrying the counterpart's body.
    const advisory = (await f.reader.contribute({ ...request, include_stale: true })).items
      .find((item) => item.claim_id === "disputed-a")!;
    assert.equal(advisory.advisory, true);
    assert.equal(advisory.conflicting_pair, true);
    const peer = (advisory.conflict_with as JsonObject[])[0]!;
    assert.equal(peer.claim_id, "disputed-b");
    assert.equal(peer.advisory, true);
    assert.equal(peer.content, "alpha says right");
  } finally { await f.close(); }
});

test("reviving Knowledge reopens an exited claim as a candidate and preserves the exit for audit", async () => {
  const f = await fixture();
  try {
    const governance = new KnowledgeClaimGovernance(f.store);
    const make = (id: string, status: string) => f.store.create("knowledge_claim", id, { status, scope: "global:global",
      source_id: "source", content: "alpha fact", evidence_ids: [], content_digest: "fixture-content" });
    const expired = make("revive-me", "expired");
    const reopened = governance.knowledgeClaimReopen({ claim_id: expired.id, reviewer: "operator", reason: "source re-verified" });
    const saved = reopened.claim as JsonObject;
    assert.equal(saved.status, "candidate");
    assert.equal((saved.reopened_from as JsonObject).status, "expired");
    assert.equal(saved.revalidation_required, true);
    // A live reviewed claim is not reopenable; only exited lifecycle states are.
    const live = make("still-live", "reviewed");
    assert.throws(() => governance.knowledgeClaimReopen({ claim_id: live.id, reviewer: "operator", reason: "nope" }), /Only exited Knowledge claims/u);
  } finally { await f.close(); }
});

test("the existing Memory expiry sweep moves active records past valid_until to expired without deleting them", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const ledger = new MemoryLedgerKernel(f.store);
    ledger.remember({ memory_id: "keep", source_id: "source", kind: "preference", scope_kind: "project", scope_id: "demo",
      content: "alpha keep", confidence: "bounded", observed_at: "2020-01-01T00:00:00Z", valid_until: "2099-01-01T00:00:00Z" });
    ledger.remember({ memory_id: "age", source_id: "source", kind: "preference", scope_kind: "project", scope_id: "demo",
      content: "alpha age", confidence: "bounded", observed_at: "2020-01-01T00:00:00Z", valid_until: "2026-01-01T00:00:00Z" });
    const swept = service.memoryExpirySweep({ now: "2026-09-27T10:00:00Z" });
    assert.equal(swept.count, 1);
    assert.equal(((swept.expired as JsonObject[])[0]).id, "age");
    assert.equal(f.store.get("memory_ledger", "age").status, "expired");
    assert.equal(f.store.get("memory_ledger", "keep").status, "active");
    assert.throws(() => service.memoryExpirySweep({ now: "not-a-date" }), /ISO timestamp/u);
  } finally { await f.close(); }
});

test("temporal Memory selection honors includeStale for expired entries and their expiry reason", () => {
  const items = [
    { id: "current", status: "active", valid_until: "2099-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", version: 1, content_digest: "a" },
    { id: "aged", status: "expired", valid_until: "2026-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z", version: 1, content_digest: "b" },
  ];
  const now = new Date("2026-09-27T10:00:00Z");
  const strict = temporalMemorySelect(items, now, false);
  assert.deepEqual(strict.selected.map((item) => item.id), ["current"]);
  const stale = temporalMemorySelect(items, now, false, true);
  assert.deepEqual(stale.selected.map((item) => item.id).sort(), ["aged", "current"]);
  // Valid-but-unparseable valid_until is still excluded as invalid, even for stale.
  const invalid = temporalMemorySelect([{ id: "bad", status: "expired", valid_until: "x", version: 1, content_digest: "c" }], now, false, true);
  assert.equal(invalid.selected.length, 0);
});

test("expired Memory returns only as an advisory through Context with include_stale", async () => {
  const f = await fixture();
  try {
    const ledger = new MemoryLedgerKernel(f.store);
    ledger.remember({ memory_id: "mem-old", source_id: "source", kind: "preference", scope_kind: "project", scope_id: "demo",
      content: "alpha old", confidence: "bounded", observed_at: "2020-01-01T00:00:00Z", valid_until: "2026-01-01T00:00:00Z" });
    new CraftService(f.store).memoryExpirySweep({ now: "2026-09-27T10:00:00Z" });
    const memory = new MemoryContribution(f.store);
    const strictRequest = { ...request, members: ["memory"] } as unknown as ContextRequest;
    assert.equal((await memory.contribute(strictRequest)).items.length, 0);
    const advisory = (await memory.contribute({ ...strictRequest, include_stale: true })).items;
    assert.equal(advisory.length, 1);
    assert.equal(advisory[0]!.advisory, true);
    assert.equal(advisory[0]!.freshness_score, 0.3);
  } finally { await f.close(); }
});

test("an expired Procedure release stops routing but keeps the record for revival", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-procedure-stale-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("experience_procedure", "proc", { routeable: true, lifecycle: "routeable", definition_digest: "d1",
      valid_until: "2026-01-01T00:00:00Z" });
    assert.equal(activeProcedure(store, "proc", Date.parse("2026-09-27T00:00:00Z")), null);
    assert.equal((activeProcedure(store, "proc", Date.parse("2025-01-01T00:00:00Z")) as JsonObject).id, "proc");
    // preserve carries valid_until onto the release so an older record can also expire.
    const latest = store.create("experience_procedure", "proc2", { routeable: true, lifecycle: "routeable", definition_digest: "d2",
      valid_until: "2026-01-01T00:00:00Z" });
    preserveProcedureRelease(store, latest);
    assert.equal((store.find("experience_release", "proc2") as JsonObject).valid_until, "2026-01-01T00:00:00Z");
    // A later candidate that no longer routes falls back to the pinned (expired) release.
    store.save("experience_procedure", "proc2", { ...store.get("experience_procedure", "proc2"), routeable: false,
      lifecycle: "candidate", definition_digest: "d3" });
    assert.equal(activeProcedure(store, "proc2", Date.parse("2026-09-27T00:00:00Z")), null);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
