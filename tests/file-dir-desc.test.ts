import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { FileDirDescRegistry, PROMOTION_USE_THRESHOLD, type FileDirDescRecord } from "../core/file-dir-desc.ts";
import { type JsonObject } from "../core/infrastructure/store.ts";
const asResults = (value: unknown): FileDirDescRecord[] => (value as JsonObject).results as unknown as FileDirDescRecord[];
const asItems = (value: unknown): FileDirDescRecord[] => (value as JsonObject).items as unknown as FileDirDescRecord[];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-fdd-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, registry: new FileDirDescRegistry(store) };
}

test("recording a directory only observes it until it is used often enough", async () => {
  const { store, registry } = await fixture();
  try {
  const path = "C:\\projects\\billing";
  const first = registry.record({ path, description: "billing service root" }) as unknown as FileDirDescRecord;
    assert.equal(first.useCount, 1);
    assert.equal(first.status, "observed");
    assert.equal(first.hostKind, "local");
    // Repeated use bumps the count but stays observed below the threshold.
    for (let i = 2; i < PROMOTION_USE_THRESHOLD; i++) {
    const rec = registry.record({ path, description: "billing service root" }) as unknown as FileDirDescRecord;
      assert.equal(rec.useCount, i);
      assert.equal(rec.status, "observed");
    }
    // Crossing the threshold promotes it to a recallable entry.
  const promoted = registry.record({ path, description: "billing service root" }) as unknown as FileDirDescRecord;
    assert.equal(promoted.useCount, PROMOTION_USE_THRESHOLD);
    assert.equal(promoted.status, "promoted");
    // A second directory should not be promoted by the first one's usage.
  const other = registry.record({ path: "C:\\projects\\ledger", description: "ledger service" }) as unknown as FileDirDescRecord;
    assert.equal(other.status, "observed");
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("explicit promote forces a one-off directory into the formal index", async () => {
  const { store, registry } = await fixture();
  try {
  const path = "/opt/codex";
  const rec = registry.record({ path, description: "codex cli source" }) as unknown as FileDirDescRecord;
    assert.equal(rec.status, "observed");
  const promoted = registry.promote({ id: rec.id }) as unknown as FileDirDescRecord;
    assert.equal(promoted.status, "promoted");
    assert.equal(asResults(registry.resolve({ path }))[0]?.status, "promoted");
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("resolve is bidirectional and only returns promoted directories by description", async () => {
  const { store, registry } = await fixture();
  try {
    // Observed entries must not be recallable by description.
    registry.record({ path: "C:\\tmp\\noise", description: "billing service root" });
    const empty = registry.resolve({ description: "billing service" });
    assert.equal(asResults(empty).length, 0);
    // Promote a real entry, then it resolves.
    const promoted = registry.record({ path: "C:\\projects\\billing", description: "billing service root" }) as unknown as FileDirDescRecord;
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
    assert.throws(() => registry.record({ path: "C:\\x", description: "" }), /non-empty string/);
    assert.throws(() => registry.resolve({}), /requires description or path/);
    assert.throws(() => registry.promote({ id: "missing" }), /Unknown file_dir_desc/);
    assert.throws(() => registry.record({ path: "C:\\x", description: "x", host_kind: "mars" }), /local or cloud/);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("cloud host directories are recorded and listed separately", async () => {
  const { store, registry } = await fixture();
  try {
  const rec = registry.record({ path: "/cloud/vm1", description: "cloud build vm", host_kind: "cloud" }) as unknown as FileDirDescRecord;
    assert.equal(rec.hostKind, "cloud");
    registry.promote({ id: rec.id });
    const cloud = registry.list({ host_kind: "cloud" });
    assert.equal(asItems(cloud).length, 1);
    const local = registry.list({ host_kind: "local" });
    assert.equal(asItems(local).length, 0);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});
