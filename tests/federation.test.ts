import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { CraftService } from "../src/service.ts";
import { craftPaths } from "../src/paths.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-federation-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  store.create("evidence", "e1", { source: "test", claim: "passed" });
  store.create("capability_asset", "asset", { name: "A", asset_type: "skill", trust: "verified", health: "healthy", effect: "read_only" });
  return { store, service };
}
function record(result: JsonObject, key: string): JsonObject { return result[key] as JsonObject; }

test("federation shares only reviewed exact-version assets and revokes every pinned consumer", async () => {
  const f = await fixture();
  const proposed = f.service.capabilityBundlePropose({ bundle_id: "bundle", asset_id: "asset", asset_version: 1, audience: "organization",
    manifest: { name: "Safe capability", platforms: ["codex", "claude"] }, evidence_ids: ["e1"] });
  assert.equal(record(proposed, "bundle").raw_trajectory_stored, false);
  assert.equal(f.service.capabilityBundlePropose({ bundle_id: "bundle", asset_id: "asset", asset_version: 1, audience: "organization",
    manifest: { name: "Safe capability", platforms: ["codex", "claude"] }, evidence_ids: ["e1"] }).idempotent, true);
  const reviewed = record(f.service.capabilityBundleReview({ bundle_id: "bundle", decision: "approve", reviewer: "reviewer", review_ref: "review-1",
    reviewed_manifest: { name: "Redacted capability", platforms: ["codex"] } }), "bundle");
  const release = record(f.service.capabilityBundlePublish({ release_id: "release", bundle_id: "bundle", bundle_version: reviewed.version,
    publisher: "publisher", approval_ref: "approval-1" }), "release");
  assert.equal(f.service.capabilityBundlePublish({ release_id: "release", bundle_id: "bundle", bundle_version: reviewed.version,
    publisher: "publisher", approval_ref: "approval-1" }).idempotent, true);
  const subscription = record(f.service.capabilityReleaseSubscribe({ subscription_id: "sub", release_id: "release", release_version: release.version, consumer: "team-a" }), "subscription");
  assert.equal(f.service.capabilityReleaseSubscribe({ subscription_id: "sub", release_id: "release", release_version: release.version, consumer: "team-a" }).idempotent, true);
  assert.equal(f.service.capabilitySubscriptionResolve({ subscription_id: String(subscription.id) }).activation_allowed, true);
  assert.equal(record(f.service.capabilityReleaseRevoke({ release_id: "release", actor: "security", revocation_ref: "incident-1", reason: "unsafe" }), "release").status, "revoked");
  assert.equal(f.service.capabilityReleaseRevoke({ release_id: "release", actor: "security", revocation_ref: "incident-1", reason: "unsafe" }).idempotent, true);
  assert.throws(() => f.service.capabilitySubscriptionResolve({ subscription_id: "sub" }), /revoked or changed/);
  f.store.close();
});

test("federation fails closed for unsafe, stale, conflicting, or insufficiently reviewed sharing", async () => {
  const f = await fixture();
  const propose = (extra: Record<string, unknown> = {}) => f.service.capabilityBundlePropose({ asset_id: "asset", asset_version: 1,
    audience: "team", manifest: { name: "Safe" }, evidence_ids: ["e1"], ...extra });
  assert.throws(() => propose({ audience: "world" }), /audience/);
  assert.throws(() => propose({ asset_id: " " }), /asset_id/);
  assert.throws(() => propose({ manifest: [] }), /manifest must be an object/);
  assert.throws(() => propose({ manifest: { token: "x" } }), /sensitive field/);
  assert.throws(() => propose({ manifest: { nested: [{ note: "Bearer abcdefghijklmnop" }] } }), /secret-like/);
  assert.throws(() => propose({ evidence_ids: [] }), /at least 1/);
  assert.throws(() => propose({ evidence_ids: ["e1", "e1"] }), /unique/);
  f.store.create("capability_asset", "untrusted", { trust: "candidate", health: "healthy" });
  assert.throws(() => propose({ asset_id: "untrusted" }), /healthy verified/);
  const bundle = record(propose({ bundle_id: "b" }), "bundle");
  assert.throws(() => propose({ bundle_id: "b", audience: "personal" }), /idempotency conflict/);
  assert.throws(() => f.service.capabilityBundleReview({ bundle_id: "b", decision: "maybe", reviewer: "r", review_ref: "x" }), /decision/);
  const rejected = record(f.service.capabilityBundleReview({ bundle_id: "b", decision: "reject", reviewer: "r", review_ref: "x" }), "bundle");
  assert.throws(() => f.service.capabilityBundleReview({ bundle_id: "b", decision: "approve", reviewer: "r", review_ref: "x" }), /awaiting review/);
  assert.throws(() => f.service.capabilityBundlePublish({ bundle_id: "b", bundle_version: rejected.version, publisher: "p", approval_ref: "x" }), /reviewed/);
  propose({ bundle_id: "b2" });
  const reviewed = record(f.service.capabilityBundleReview({ bundle_id: "b2", decision: "approve", reviewer: "same", review_ref: "x" }), "bundle");
  assert.throws(() => f.service.capabilityBundlePublish({ bundle_id: "b2", bundle_version: reviewed.version, publisher: "same", approval_ref: "x" }), /independent/);
  f.store.save("capability_asset", "asset", { trust: "verified", health: "stale" });
  assert.throws(() => f.service.capabilityBundlePublish({ bundle_id: "b2", bundle_version: reviewed.version, publisher: "p", approval_ref: "x" }), /no longer publishable/);
  f.store.save("capability_asset", "asset", { trust: "verified", health: "healthy" });
  const release = record(f.service.capabilityBundlePublish({ release_id: "r2", bundle_id: "b2", bundle_version: reviewed.version, publisher: "p", approval_ref: "x" }), "release");
  assert.throws(() => f.service.capabilityBundlePublish({ release_id: "r2", bundle_id: "b2", bundle_version: reviewed.version, publisher: "other", approval_ref: "x" }), /idempotency conflict/);
  const sub = record(f.service.capabilityReleaseSubscribe({ subscription_id: "s2", release_id: "r2", release_version: release.version, consumer: "c" }), "subscription");
  assert.throws(() => f.service.capabilityReleaseSubscribe({ subscription_id: "s2", release_id: "r2", release_version: release.version, consumer: "other" }), /idempotency conflict/);
  const altered = f.store.save("capability_subscription", "s2", { ...sub, release_digest: "sha256:changed", status: "pinned" });
  assert.throws(() => f.service.capabilitySubscriptionResolve({ subscription_id: String(altered.id) }), /revoked or changed/);
  f.store.save("capability_subscription", "s2", { ...sub, status: "disabled" });
  assert.throws(() => f.service.capabilitySubscriptionResolve({ subscription_id: "s2" }), /not pinned/);
  const generated = record(propose({ manifest: { name: "Generated", optional: null } }), "bundle");
  const generatedReviewed = record(f.service.capabilityBundleReview({ bundle_id: generated.id, decision: "approve", reviewer: "r3", review_ref: "x" }), "bundle");
  const generatedRelease = record(f.service.capabilityBundlePublish({ bundle_id: generated.id, bundle_version: generatedReviewed.version, publisher: "p3", approval_ref: "x" }), "release");
  assert.match(String(generatedRelease.id), /^capability_release_/);
  assert.match(String(record(f.service.capabilityReleaseSubscribe({ release_id: generatedRelease.id, release_version: generatedRelease.version, consumer: "generated" }), "subscription").id), /^capability_subscription_/);
  f.service.capabilityReleaseRevoke({ release_id: "r2", actor: "a", revocation_ref: "x", reason: "x" });
  assert.throws(() => f.service.capabilityReleaseSubscribe({ release_id: "r2", release_version: 2, consumer: "c" }), /not active/);
  assert.equal(bundle.execution_authority, false);
  f.store.close();
});
