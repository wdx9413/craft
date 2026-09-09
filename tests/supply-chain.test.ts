import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-supply-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  store.create("hub_source", "hub", { status: "active" });
  store.create("hub_catalog_entry", "hub:entry", { source_id: "hub", entry_id: "entry", status: "active", content_digest: "sha256:one" });
  store.create("capability_materialization", "material", { source_id: "hub", entry_record_id: "hub:entry", entry_id: "entry", content_digest: "sha256:one", status: "certified", asset_id: "asset" });
  store.create("task", "task", { title: "T" }); store.create("trial", "trial", { task_id: "task" });
  store.create("evaluation_run", "evaluation", { trial_ids: ["trial"] });
  store.create("capability_certification", "cert", { materialization_id: "material", evaluation_run_id: "evaluation", asset_id: "asset", asset_version: 1, status: "promoted" });
  store.create("capability_asset", "asset", { name: "A", trust: "candidate", health: "healthy", effect: "read_only" });
  store.save("capability_asset", "asset", { name: "A", trust: "verified", health: "healthy", effect: "read_only", certification_id: "cert", certification_version: 1 });
  store.create("activation_profile", "profile", { task_id: "task", asset_ids: ["asset"], asset_versions: { asset: 2 }, status: "recommended" });
  store.create("evidence", "e", { claim: "observed" });
  return { store, service };
}
function item(result: JsonObject, key: string): JsonObject { return result[key] as JsonObject; }

test("supply-chain advisories are scoped, evidence-backed, idempotent, and resolvable", async () => {
  const f = await fixture();
  const args = { advisory_id: "advisory", source_id: "hub", entry_id: "entry", severity: "high", summary: "unsafe release", evidence_ids: ["e"] };
  assert.equal(item(f.service.supplyChainAdvisoryRecord(args), "advisory").status, "active");
  assert.equal(f.service.supplyChainAdvisoryRecord(args).idempotent, true);
  assert.throws(() => f.service.supplyChainAdvisoryRecord({ ...args, summary: "changed" }), /idempotency conflict/);
  assert.equal(item(f.service.supplyChainAdvisoryResolve({ advisory_id: "advisory", resolution: "patched", resolver: "security", evidence_ids: ["e"] }), "advisory").status, "resolved");
  assert.equal(f.service.supplyChainAdvisoryResolve({ advisory_id: "advisory", resolution: "ignored", resolver: "x", evidence_ids: ["e"] }).idempotent, true);
  const generated = f.service.supplyChainAdvisoryRecord({ source_id: "hub", asset_id: "asset", severity: "high", summary: "notice", evidence_ids: ["e"] });
  assert.match(String(item(generated, "advisory").id), /^supply_chain_advisory_/);
  f.service.supplyChainAdvisoryResolve({ advisory_id: item(generated, "advisory").id, resolution: "false positive", resolver: "security", evidence_ids: ["e"] });
  for (const bad of [
    { ...args, advisory_id: "x1", entry_id: undefined, asset_id: undefined }, { ...args, advisory_id: "x2", asset_id: "asset" },
    { ...args, advisory_id: "x3", severity: "urgent" }, { ...args, advisory_id: "x4", evidence_ids: [] },
    { ...args, advisory_id: "x5", evidence_ids: ["e", "e"] },
    { ...args, advisory_id: "x6", summary: " " },
    { ...args, advisory_id: "x7", evidence_ids: [" "] },
  ]) assert.throws(() => f.service.supplyChainAdvisoryRecord(bad), /exactly one|unsupported|non-empty|not be empty|unique/);
  f.store.close();
});

test("reconcile atomically blocks drifted supply-chain state and projects recertification recovery", async () => {
  for (const reason of ["source_disabled", "entry_withdrawn", "content_digest_changed", "security_advisory", "certified_asset_drift"] as const) {
    const f = await fixture();
    if (reason === "source_disabled") f.store.save("hub_source", "hub", { status: "disabled" });
    if (reason === "entry_withdrawn") f.store.save("hub_catalog_entry", "hub:entry", { source_id: "hub", entry_id: "entry", status: "withdrawn", content_digest: "sha256:one" });
    if (reason === "content_digest_changed") f.store.save("hub_catalog_entry", "hub:entry", { source_id: "hub", entry_id: "entry", status: "active", content_digest: "sha256:two" });
    if (reason === "security_advisory") f.service.supplyChainAdvisoryRecord({ source_id: "hub", asset_id: "asset", severity: "critical", summary: "compromised", evidence_ids: ["e"] });
    if (reason === "certified_asset_drift") f.store.save("capability_asset", "asset", { ...f.store.get("capability_asset", "asset"), certification_id: "other" });
    const result = f.service.supplyChainReconcile({ source_id: "hub" }); assert.equal(result.count, 1); assert.equal(result.recovery_refresh_required, true);
    assert.equal(f.store.get("capability_asset", "asset").health, "stale"); assert.equal(f.store.get("activation_profile", "profile").status, "invalidated");
    assert.equal(f.store.get("capability_certification", "cert").invalidation_reason, reason);
    assert.equal(f.service.supplyChainReconcile({ source_id: "hub" }).count, 0);
    const recovery = f.service.recoveryQueueRefresh({}); assert.equal(recovery.count, 1); assert.equal((recovery.items as JsonObject[])[0].action, "recertify_capability");
    f.store.close();
  }
});

test("reconcile leaves current certifications and unrelated or mismatched profiles untouched", async () => {
  const f = await fixture(); f.store.create("hub_source", "other", { status: "active" });
  f.store.create("activation_profile", "old", { asset_ids: ["asset"], asset_versions: { asset: 99 }, status: "recommended" });
  f.store.create("activation_profile", "done", { asset_ids: ["asset"], asset_versions: { asset: 2 }, status: "invalidated" });
  f.service.supplyChainAdvisoryRecord({ source_id: "hub", asset_id: "asset", severity: "medium", summary: "informational", evidence_ids: ["e"] });
  assert.equal(f.service.supplyChainReconcile({ source_id: "other" }).count, 0); assert.equal(f.service.supplyChainReconcile({ source_id: "hub" }).count, 0);
  assert.equal(f.store.get("activation_profile", "old").status, "recommended"); f.store.close();
});
