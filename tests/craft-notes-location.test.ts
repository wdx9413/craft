import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftNotesLocationRegistry, CRAFT_NOTES_LOCATION_USE_THRESHOLD, type CraftNotesLocationRecord } from "@craft/craft-notes/craft-notes-location";
import { canonicalizeNotePath } from "@craft/craft-notes/craft-notes-location";
import { type JsonObject } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
const asResults = (value: unknown): CraftNotesLocationRecord[] => (value as JsonObject).results as unknown as CraftNotesLocationRecord[];
const asItems = (value: unknown): CraftNotesLocationRecord[] => (value as JsonObject).items as unknown as CraftNotesLocationRecord[];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-fdd-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const registry = new CraftNotesLocationRegistry(store);
  // The local device is the implicit default device for every place, and is
  // active by default in a real deployment.
  registry.registerDevice({ id: "local", name: "Local device", device_kind: "local", host_kind: "local", health: "healthy", device_note: "本地开发设备" });
  return { root, store, registry };
}

test("the implicit local device remains recallable when it has no explicit device row", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-fdd-implicit-local-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const registry = new CraftNotesLocationRegistry(store);
    const record = registry.record({ path: join(root, "project"), description: "local project" }) as unknown as CraftNotesLocationRecord;
    registry.promote({ id: record.id });
    assert.equal(asResults(registry.resolve({ description: "local project" })).length, 1);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy location rows migrate once to the Craft Notes collection without changing identity or audit data", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-notes-migration-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const legacy = { id: "legacy-location", device_id: "local", path: "/work/billing", description: "billing service",
      status: "promoted", use_count: 4, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
      revoked_by: null, revoked_reason: null };
    store.save("file_dir_desc", legacy.id, legacy);
    const source = store.find("file_dir_desc", legacy.id);
    new CraftNotesLocationRegistry(store);
    const migrated = store.find("craft_notes_location", legacy.id)!;
    for (const field of ["id", "device_id", "path", "description", "status", "use_count", "revoked_by", "revoked_reason"] as const) {
      assert.equal(migrated[field], source?.[field], `${field} is preserved`);
    }
    assert.deepEqual(store.find("file_dir_desc", legacy.id), source, "migration keeps the source row for safe rollback");
    const firstCopy = store.find("craft_notes_location", legacy.id);
    new CraftNotesLocationRegistry(store);
    assert.deepEqual(store.find("craft_notes_location", legacy.id), firstCopy, "reopening is idempotent");
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("recording a directory only observes it until it is used often enough", async () => {
  const { store, registry } = await fixture();
  try {
    const path = "C:\\projects\\billing";
    const first = registry.record({ path, description: "billing service root" }) as unknown as CraftNotesLocationRecord;
    assert.equal(first.useCount, 1);
    assert.equal(first.status, "observed");
    assert.equal(first.hostKind, "local");
    const windowsPath = registry.record({ path: "C:/projects/archive/../ledger", description: "ledger service" }) as unknown as CraftNotesLocationRecord;
    assert.equal(windowsPath.path, "C:\\projects\\ledger", "Windows paths stay normalized even when the host process is POSIX");
    assert.equal(asResults(registry.resolve({ path: "C:\\projects\\ledger" }))[0]?.id, windowsPath.id);
    const uncPath = registry.record({ path: "\\\\build-host\\share\\repo", description: "remote build repository" }) as unknown as CraftNotesLocationRecord;
    assert.equal(uncPath.path, "\\\\build-host\\share\\repo", "UNC paths stay absolute on a POSIX host");
    // Repeated use bumps the count but stays observed below the threshold.
    for (let i = 2; i < CRAFT_NOTES_LOCATION_USE_THRESHOLD; i++) {
      const rec = registry.record({ path, description: "billing service root" }) as unknown as CraftNotesLocationRecord;
      assert.equal(rec.useCount, i);
      assert.equal(rec.status, "observed");
    }
    // Crossing the threshold promotes it to a recallable entry.
    const promoted = registry.record({ path, description: "billing service root" }) as unknown as CraftNotesLocationRecord;
    assert.equal(promoted.useCount, CRAFT_NOTES_LOCATION_USE_THRESHOLD);
    assert.equal(promoted.status, "promoted");
    // A second directory should not be promoted by the first one's usage.
    const other = registry.record({ path: "C:\\projects\\ledger", description: "ledger service" }) as unknown as CraftNotesLocationRecord;
    assert.equal(other.status, "observed");
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("device metadata: register, list, health and disable blocks recall", async () => {
  const { store, registry } = await fixture();
  try {
    const device = registry.registerDevice({ id: "edge-01", name: "Edge node", device_kind: "container", host_kind: "cloud",
      location: "eu-west", tags: ["ci", "build"], health: "healthy", device_note: "欧洲构建节点" });
    assert.equal(device.id, "edge-01");
    assert.equal(device.deviceKind, "container");
    assert.equal(device.hostKind, "cloud");
    assert.deepEqual(device.tags, ["ci", "build"]);

    registry.record({ path: "/opt/app", description: "edge app", device_id: "edge-01", device_kind: "container", host_kind: "cloud",
      promote: true });
    assert.equal(asResults(registry.resolve({ description: "edge app", device_id: "edge-01" })).length, 1);

    const disabled = registry.disableDevice("edge-01");
    assert.equal(disabled.status, "disabled");
    assert.equal(disabled.health, "offline");
    assert.equal(asResults(registry.resolve({ description: "edge app", device_id: "edge-01" })).length, 0, "disabled device places must not be recalled");

    const enabled = registry.enableDevice("edge-01");
    assert.equal(enabled.status, "active");
    assert.equal(asResults(registry.resolve({ description: "edge app", device_id: "edge-01" })).length, 1, "re-enabled device places are recallable again");

    const all = registry.listDevices() as unknown as { items: { deviceKind: string }[] };
    const kinds = all.items.map((item) => item.deviceKind);
    assert.ok(kinds.includes("local") && kinds.includes("container"));
    const active = registry.listDevices({ status: "active" }) as unknown as { items: unknown[] };
    assert.equal(active.items.length, 2);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("device metadata: unknown device and reactivation rules", async () => {
  const { store, registry } = await fixture();
  try {
    assert.throws(() => registry.disableDevice("no-such-device"), /Unknown device/);
    assert.equal(registry.device("no-such-device"), null);
    registry.registerDevice({ id: "edge-02", device_kind: "ssh", host_kind: "cloud", device_note: "远程构建节点" });
    registry.disableDevice("edge-02");
    assert.throws(() => registry.registerDevice({ id: "edge-02", status: "active", device_note: "重新启用远程构建节点" }), /reactivated/);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("path canonicalization and concept tags do not split one place", async () => {
  const { store, registry } = await fixture();
  try {
    const one = registry.record({ path: "/opt/codex", description: "codex cli", concept_kind: "rule", rationale: "The CLI entry point" });
    assert.equal(one.concept_kind, "rule");
    assert.equal(one.rationale, "The CLI entry point");
    const two = registry.observe({ path: "/opt/codex/", description: "later title" });
    assert.equal(two.description, "codex cli", "reinforcement never rewrites directory meaning");
    assert.equal(two.concept_kind, "rule");
    const canon = canonicalizeNotePath("/opt/codex/");
    assert.equal(canon, canonicalizeNotePath("/opt/codex"));
    assert.ok(!canon.endsWith("/") && !canon.endsWith("\\"), "trailing separators must be stripped");
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("explicit promote forces a one-off directory into the formal index", async () => {
  const { store, registry } = await fixture();
  try {
    const path = "/opt/codex";
    const rec = registry.record({ path, description: "codex cli source" }) as unknown as CraftNotesLocationRecord;
    assert.equal(rec.status, "observed");
    const promoted = registry.promote({ id: rec.id }) as unknown as CraftNotesLocationRecord;
    assert.equal(promoted.status, "promoted");
    assert.equal(asResults(registry.resolve({ path }))[0]?.status, "promoted");
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("stale legacy promotion and revocation do not split the Notes and compatibility records", async () => {
  const { store, root } = await fixture();
  try {
    const service = new CraftService(store);
    service.craftNotesCreateDevice({ id: "local", note: "本地开发设备" });
    const place = service.craftNotesLocationRecord({ device_id: "local", path: "/work/versioned", description: "versioned project" });
    const note = store.find("craft_note", String(place.id))!;
    assert.throws(() => service.craftNotesLocationPromote({ id: place.id, expected_version: Number(note.version) + 1 }), /stale Note/u);
    assert.equal(store.find("craft_notes_location", String(place.id))?.status, "observed");
    assert.equal(store.find("craft_note", String(place.id))?.status, "candidate");
    service.craftNotesLocationPromote({ id: place.id, expected_version: Number(note.version) });
    const confirmed = store.find("craft_note", String(place.id))!;
    assert.throws(() => service.craftNotesLocationRevoke({ id: place.id, expected_version: Number(confirmed.version) + 1,
      revoked_by: "user", reason: "stale" }), /stale Note/u);
    assert.equal(store.find("craft_notes_location", String(place.id))?.status, "promoted");
    assert.equal(store.find("craft_note", String(place.id))?.status, "confirmed");
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("resolve is bidirectional and only returns promoted directories by description", async () => {
  const { store, registry } = await fixture();
  try {
    // Observed entries must not be recallable by description.
    registry.record({ path: "C:\\tmp\\noise", description: "billing service root" });
    const empty = registry.resolve({ description: "billing service" });
    assert.equal(asResults(empty).length, 0);
    // Promote a real entry, then it resolves.
    const promoted = registry.record({ path: "C:\\projects\\billing", description: "billing service root" }) as unknown as CraftNotesLocationRecord;
    registry.promote({ id: promoted.id });
    const byDesc = registry.resolve({ description: "billing service" });
    assert.equal((byDesc as JsonObject).kind, "by_description");
    assert.equal(asResults(byDesc).length, 1);
    assert.equal(asResults(byDesc)[0].path, "C:\\projects\\billing");
    // Reverse direction: path -> description.
    const byPath = registry.resolve({ path: "C:\\projects\\billing" });
    assert.equal((byPath as JsonObject).kind, "by_path");
    assert.equal(asResults(byPath)[0].description, "billing service root");
    // Unmatched description yields nothing.
    assert.equal(asResults(registry.resolve({ description: "nonexistent concept" })).length, 0);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("rejects malformed input and requires absolute paths", async () => {
  const { store, registry } = await fixture();
  try {
    assert.throws(() => registry.record({ path: "relative/path", description: "x" }), /absolute path/);
    assert.throws(() => registry.record({ path: "C:relative/path", description: "x" }), /absolute path/);
    assert.throws(() => registry.record({ path: "C:\\x", description: "" }), /non-empty string/);
    assert.throws(() => registry.resolve({}), /requires description or path/);
    assert.throws(() => registry.promote({ id: "missing" }), /Unknown craft_notes_location/);
    assert.throws(() => registry.record({ path: "C:\\x", description: "x", host_kind: "mars" }), /local or cloud/);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("cloud host directories are recorded and listed separately", async () => {
  const { store, registry } = await fixture();
  try {
    const rec = registry.record({ path: "/cloud/vm1", description: "cloud build vm", host_kind: "cloud" }) as unknown as CraftNotesLocationRecord;
    assert.equal(rec.hostKind, "cloud");
    registry.promote({ id: rec.id });
    const cloud = registry.list({ host_kind: "cloud" });
    assert.equal(asItems(cloud).length, 1);
    const local = registry.list({ host_kind: "local" });
    assert.equal(asItems(local).length, 0);
    assert.equal(asItems(registry.list({ host_kind: "cloud", limit: 1 })).length, 1);
    assert.throws(() => registry.list({ limit: 0 }), /limit must be an integer/u);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("observe reinforces use without rewriting the description", async () => {
  const { store, registry } = await fixture();
  try {
    const path = "C:\\projects\\billing";
    registry.observe({ path, description: "billing service root" });
    const second = registry.observe({ path, description: "a later task title" }) as unknown as CraftNotesLocationRecord;
    assert.equal(second.description, "billing service root", "reinforcement must not overwrite directory meaning");
    assert.equal(second.useCount, 2);
    const third = registry.observe({ path }) as unknown as CraftNotesLocationRecord;
    assert.equal(third.status, "promoted", "three real uses promote");
    assert.equal(asResults(registry.resolve({ description: "billing service" })).length, 1);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("withdrawal stops recall and survives later use without resurrecting", async () => {
  const { store, registry } = await fixture();
  try {
    const rec = registry.observe({ path: "C:\\projects\\old", description: "legacy billing service" }) as unknown as CraftNotesLocationRecord;
    registry.promote({ id: rec.id });
    assert.equal(asResults(registry.resolve({ description: "billing service" })).length, 1);
    const revoked = registry.revoke({ id: rec.id, revoked_by: "user:alex", reason: "project moved" }) as unknown as CraftNotesLocationRecord;
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revokedBy, "user:alex");
    assert.equal(asResults(registry.resolve({ description: "billing service" })).length, 0, "a withdrawn entry must stop being recallable");
    // Continued use must not silently undo a deliberate withdrawal.
    const usedAgain = registry.observe({ path: "C:\\projects\\old" }) as unknown as CraftNotesLocationRecord;
    assert.equal(usedAgain.status, "revoked");
    assert.equal(asItems(registry.list({ status: "revoked" })).length, 1, "the audit trail survives");
    assert.throws(() => registry.revoke({ id: rec.id, revoked_by: "user:alex", reason: "" }), /reason must be a non-empty string/u);
    assert.throws(() => registry.revoke({ id: rec.id, revoked_by: "", reason: "x" }), /must name the operator/u);
    // Only an explicit promote revives it.
    assert.equal((registry.promote({ id: rec.id }) as unknown as CraftNotesLocationRecord).status, "promoted");
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("relocation keeps identity and use, and refuses to overwrite another entry", async () => {
  const { store, registry } = await fixture();
  try {
    const rec = registry.observe({ path: "C:\\projects\\billing", description: "billing service root" }) as unknown as CraftNotesLocationRecord;
    registry.observe({ id: rec.id, path: "C:\\projects\\billing" });
    const moved = registry.relocate({ id: rec.id, path: "D:\\work\\billing" }) as unknown as CraftNotesLocationRecord;
    assert.equal(moved.path, "D:\\work\\billing");
    assert.equal(moved.useCount, 2, "relocation must not reset accumulated use");
    assert.equal(asResults(registry.resolve({ path: "C:\\projects\\billing" })).length, 0);
    const other = registry.observe({ path: "C:\\projects\\ledger", description: "ledger service" }) as unknown as CraftNotesLocationRecord;
    assert.throws(() => registry.relocate({ id: other.id, path: "D:\\work\\billing" }), /already describes/u);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("the same path on two devices is two places, and recall is device-scoped by default", async () => {
  const { store, registry } = await fixture();
  try {
    registry.registerDevice({ id: "laptop", name: "Laptop", device_kind: "local", host_kind: "local", health: "healthy", device_note: "主力开发机" });
    registry.registerDevice({ id: "build-01", name: "Build server", device_kind: "ssh", host_kind: "cloud", location: "us-east", device_note: "远程构建机" });
    const laptop = registry.record({ path: "C:\\work\\billing", description: "billing checkout", device_id: "laptop", device_kind: "local", promote: true }) as unknown as CraftNotesLocationRecord;
    const server = registry.record({ path: "C:\\work\\billing", description: "billing checkout", device_id: "build-01", device_kind: "ssh", promote: true }) as unknown as CraftNotesLocationRecord;
    assert.notEqual(laptop.id, server.id, "two devices must not share one place record");
    assert.equal(laptop.deviceId, "laptop");
    assert.equal(server.deviceKind, "ssh");
    assert.equal(asResults(registry.resolve({ path: "C:\\work\\billing" })).length, 2);
    assert.deepEqual(asResults(registry.resolve({ path: "C:\\work\\billing", device_id: "laptop" })).map((item) => item.deviceId), ["laptop"]);
    assert.deepEqual(asResults(registry.resolve({ description: "billing", device_id: "build-01" })).map((item) => item.deviceId), ["build-01"]);
    assert.deepEqual(asItems(registry.list({ device_id: "build-01" })).map((item) => item.deviceId), ["build-01"]);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("a repository identity lets two devices recall the same checkout, and never stores credentials", async () => {
  const { store, registry } = await fixture();
  try {
    const repo = { remote_url: "https://github.com/acme/billing.git", commit: "abc1234" };
    registry.registerDevice({ id: "laptop", name: "Laptop", device_kind: "local", host_kind: "local", device_note: "主力开发机" });
    registry.registerDevice({ id: "build-01", name: "Build server", device_kind: "ssh", host_kind: "cloud", location: "us-east", device_note: "远程构建机" });
    registry.record({ path: "C:\\work\\billing", description: "billing monorepo", device_id: "laptop", repo_identity: repo, promote: true });
    registry.record({ path: "/srv/billing", description: "billing monorepo", device_id: "build-01", repo_identity: repo, promote: true });
    const recalled = asResults(registry.resolve({ description: "billing", repo_identity: { remote_url: "https://github.com/acme/billing" } }));
    assert.deepEqual(recalled.map((item) => item.deviceId).sort(), ["build-01", "laptop"]);
    assert.equal(recalled[0]?.repoIdentity?.remoteUrl, repo.remote_url);
    assert.throws(() => registry.record({ path: "C:\\work\\x", description: "x", repo_identity: { remote_url: "https://user:token@github.com/acme/x.git" } }), /credentials/u);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("device identity and relocation are validated so a place cannot silently change machine", async () => {
  const { store, registry } = await fixture();
  try {
    assert.throws(() => registry.record({ path: "C:\\work\\a", description: "a", device_id: "Bad Device!" }), /device_id/u);
    assert.throws(() => registry.record({ path: "C:\\work\\a", description: "a", device_kind: "toaster" }), /device_kind/u);
    const place = registry.observe({ path: "C:\\work\\a", device_id: "laptop" }) as unknown as CraftNotesLocationRecord;
    assert.throws(() => registry.relocate({ id: place.id, path: "C:\\work\\b", device_id: "build-01" }), /another device/u);
    const moved = registry.relocate({ id: place.id, path: "C:\\work\\b" }) as unknown as CraftNotesLocationRecord;
    assert.equal(moved.path, "C:\\work\\b");
    assert.equal(moved.deviceId, "laptop");
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});
